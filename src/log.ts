/**
 * Logging without personal data (SCRUM-65 AC10, SCRUM-67 AC7).
 *
 * One JSON line per event. Callers pass only references, counts, timings and salted-hash
 * prefixes: never names, emails, addresses, phone numbers or raw IPs. Errors are reduced to
 * their type, code and stack frames, because messages from libraries can quote input values
 * (Postgres puts the clashing value in a unique-violation message, for example).
 */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export function log(event: string, fields: LogFields = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

export function logError(event: string, err: unknown, fields: LogFields = {}): void {
  const e = err as { name?: string; code?: string; stack?: string } | null;
  const frames = (e?.stack ?? '').split('\n').filter((l) => /^\s+at /.test(l)).slice(0, 6).map((l) => l.trim()).join(' | ');
  console.error(JSON.stringify({ t: new Date().toISOString(), event, error: e?.name ?? typeof err, code: e?.code, frames, ...fields }));
}
