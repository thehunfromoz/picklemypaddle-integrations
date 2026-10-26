/**
 * Abuse protection for the public order endpoints (SCRUM-67). No third-party CAPTCHA: the site's
 * strict CSP allows no third-party origins.
 *
 *  - Honeypot and minimum fill time: bots get a normal-looking 201 and nothing is stored.
 *  - Rate limits per IP and per email address, kept in Postgres so restarts don't reset them.
 *  - Only salted hashes of IPs and emails are stored or logged.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { Db, Queryable } from '../db/db.js';

// ── Service secrets ───────────────────────────────────────────────────────────

/**
 * A random key the service makes for itself the first time it needs one, stored in the database
 * so every restart and container agrees on it. Nothing to configure, nothing in env files.
 */
export async function serviceSecret(db: Db, name: string): Promise<Buffer> {
  await db.query('INSERT INTO app_secrets (name, value) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [
    name,
    randomBytes(32),
  ]);
  const { rows } = await db.query<{ value: Uint8Array }>('SELECT value FROM app_secrets WHERE name = $1', [name]);
  if (!rows[0]) throw new Error(`service secret ${name} missing`);
  return Buffer.from(rows[0].value);
}

export interface AbuseKeys {
  /** Signs the form's load time. */
  formKey: Buffer;
  /** Salts the hashes of IPs and emails used as rate-limit keys and in logs. */
  pepper: Buffer;
}

export async function loadAbuseKeys(db: Db): Promise<AbuseKeys> {
  return { formKey: await serviceSecret(db, 'form-token-key'), pepper: await serviceSecret(db, 'rate-limit-pepper') };
}

/** Salted SHA-256, hex. Short prefixes of it are what the logs show. */
export function hashKey(pepper: Buffer, value: string): string {
  return createHash('sha256').update(pepper).update(value, 'utf8').digest('hex');
}

// ── Form token: when the form was loaded ──────────────────────────────────────

/** A form left open longer than this must be reloaded (its token has gone stale). */
export const FORM_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** `<issued-at ms>.<HMAC>`, handed to the page when the order form loads. */
export function issueFormToken(key: Buffer, now: Date): string {
  const ts = String(now.getTime());
  return `${ts}.${createHmac('sha256', key).update(ts).digest('base64url')}`;
}

export type FormTokenCheck = { ok: true; ageMs: number } | { ok: false };

export function checkFormToken(key: Buffer, token: string | undefined, now: Date): FormTokenCheck {
  if (!token || !/^\d{10,15}\.[A-Za-z0-9_-]{43}$/.test(token)) return { ok: false };
  const [ts, mac] = token.split('.') as [string, string];
  const expected = createHmac('sha256', key).update(ts).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false };
  const ageMs = now.getTime() - Number(ts);
  if (ageMs < -60_000 || ageMs > FORM_TOKEN_MAX_AGE_MS) return { ok: false };
  return { ok: true, ageMs };
}

// ── Rate limits ───────────────────────────────────────────────────────────────

export interface Limit {
  bucket: string;
  max: number;
  windowMs: number;
}

export type LimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/** Is there room for one more event under this limit? Does not count anything. */
export async function checkLimit(q: Queryable, limit: Limit, keyHash: string, now: Date): Promise<LimitResult> {
  const since = new Date(now.getTime() - limit.windowMs);
  const { rows } = await q.query<{ n: number | string; oldest: Date | null }>(
    'SELECT count(*) AS n, min(at) AS oldest FROM rate_limit_events WHERE bucket = $1 AND key_hash = $2 AND at > $3',
    [limit.bucket, keyHash, since],
  );
  const n = Number(rows[0]?.n ?? 0);
  if (n < limit.max) return { ok: true };
  const oldest = rows[0]?.oldest ? new Date(rows[0].oldest) : now;
  const retryMs = oldest.getTime() + limit.windowMs - now.getTime();
  return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)) };
}

export async function recordEvent(q: Queryable, bucket: string, keyHash: string, now: Date): Promise<void> {
  await q.query('INSERT INTO rate_limit_events (bucket, key_hash, at) VALUES ($1, $2, $3)', [bucket, keyHash, now]);
}

/** Daily clean-up: the longest window is a day, so two days of history is plenty. */
export async function pruneRateLimitEvents(db: Db, now: Date): Promise<number> {
  const { rows } = await db.query<{ n: number | string }>(
    'WITH gone AS (DELETE FROM rate_limit_events WHERE at < $1 RETURNING 1) SELECT count(*) AS n FROM gone',
    [new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)],
  );
  return Number(rows[0]?.n ?? 0);
}

// ── Client IP behind the gateway ──────────────────────────────────────────────

const stripMapped = (ip: string) => (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip);

/**
 * Which peers may tell us the client's address in X-Forwarded-For. Entries are IPs, CIDR ranges
 * or host names; names (like "gateway" on the Compose network) are resolved and refreshed every
 * minute, so a recreated gateway with a new address keeps working.
 */
export class TrustedProxies {
  private list = new BlockList();
  private resolvedAt = 0;

  constructor(private readonly entries: readonly string[], private readonly ttlMs = 60_000) {}

  private async refresh(): Promise<void> {
    const list = new BlockList();
    for (const entry of this.entries) {
      const [addr, bits] = entry.split('/') as [string, string | undefined];
      const kind = isIP(addr);
      if (kind && bits !== undefined) list.addSubnet(addr, Number(bits), kind === 4 ? 'ipv4' : 'ipv6');
      else if (kind) list.addAddress(addr, kind === 4 ? 'ipv4' : 'ipv6');
      else {
        try {
          for (const r of await lookup(addr, { all: true })) list.addAddress(r.address, r.family === 4 ? 'ipv4' : 'ipv6');
        } catch {
          // Not resolvable right now (e.g. the gateway is restarting): trust nobody for that name.
        }
      }
    }
    this.list = list;
    this.resolvedAt = Date.now();
  }

  async trusts(peer: string): Promise<boolean> {
    if (this.entries.length === 0) return false;
    if (Date.now() - this.resolvedAt > this.ttlMs) await this.refresh();
    const ip = stripMapped(peer);
    const kind = isIP(ip);
    return kind !== 0 && this.list.check(ip, kind === 4 ? 'ipv4' : 'ipv6');
  }
}

/**
 * The client's address: the socket peer, unless that peer is a trusted proxy, in which case the
 * right-most X-Forwarded-For entry (the one our own gateway added; anything left of it came from
 * the client and can be forged).
 */
export async function clientIp(peer: string, forwardedFor: string | undefined, trusted: TrustedProxies): Promise<string> {
  const direct = stripMapped(peer || 'unknown');
  if (!forwardedFor || !(await trusted.trusts(direct))) return direct;
  const last = forwardedFor.split(',').map((s) => s.trim()).filter(Boolean).pop();
  return last && isIP(stripMapped(last)) ? stripMapped(last) : direct;
}
