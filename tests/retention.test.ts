/**
 * Retention (SCRUM-75 AC1 to AC6): the rules' boundaries, the daily job (files really gone,
 * HubSpot cleaned up first, idempotent), extensions, and logs with counts only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applySetup, hubspotAdapter, hubspotClient, planSetup, portalIdOf } from '../src/crm/hubspot.js';
import { processCrm, type CrmDeps } from '../src/crm/sync.js';
import type { OrderStatus } from '../src/orders/model.js';
import {
  activeExtensions,
  addMonths,
  dueDates,
  recentRuns,
  rulesDue,
  runRetention,
  setExtension,
  upcomingDeletions,
  type RetentionFacts,
} from '../src/orders/retention.js';
import { transitionOrder } from '../src/orders/transitions.js';
import { makeAdmin } from './helpers/admin.js';
import { makeApp, orderForm, photoFiles, post, type TestApp } from './helpers/app.js';
import { fakeHubSpot, type FakeHubSpot } from './helpers/fake-hubspot.js';

// ── The rules, table-driven (no database) ─────────────────────────────────────

/** Noon in Sydney on a calendar date (summer: UTC+11). */
const noon = (iso: string) => new Date(`${iso}T01:00:00Z`);
const facts = (status: OrderStatus, everPaid: boolean, extra: Partial<RetentionFacts> = {}): RetentionFacts => ({
  status,
  statusChangedAt: noon('2026-11-10'),
  everPaid,
  hasPhotos: true,
  retainUntil: null,
  ...extra,
});

describe('retention rules', () => {
  it('adds calendar months', () => {
    expect(addMonths('2026-11-10', 12)).toBe('2027-11-10');
    expect(addMonths('2026-11-10', 60)).toBe('2031-11-10');
    expect(addMonths('2028-02-29', 12)).toBe('2029-03-01'); // no 29 Feb in 2029
  });

  it.each([
    // status, ever paid, rule, due date (all reached the status on 10 Nov 2026)
    ['completed', true, 'photos', '2027-11-10'],
    ['completed', true, 'paid', '2031-11-10'],
    ['withdrawn', true, 'paid', '2031-11-10'], // withdrawn after paying: a tax record
    ['rejected', false, 'enquiries', '2027-11-10'],
    ['withdrawn', false, 'enquiries', '2027-11-10'],
    ['lapsed', false, 'enquiries', '2027-11-10'],
  ] as const)('%s (paid: %s): %s is due on %s, not the day before', (status, paid, rule, due) => {
    const f = facts(status, paid);
    expect(dueDates(f)[rule]).toBe(due);
    const dayBefore = noon(addMonths(due, 0).replace(/(\d\d)$/, (d) => String(Number(d) - 1).padStart(2, '0')));
    expect(rulesDue(f, dayBefore)).not.toContain(rule);
    expect(rulesDue(f, noon(due))).toContain(rule);
  });

  it('never applies to open orders', () => {
    for (const s of ['submitted', 'questions', 'accepted', 'paid', 'in_queue', 'regritted', 'posted_back'] as const) {
      expect(dueDates(facts(s, true)), s).toEqual({});
      expect(dueDates(facts(s, false)), s).toEqual({});
    }
  });

  it('never deletes a paid order before its 5 years, whatever else applies', () => {
    const f = facts('completed', true);
    expect(rulesDue(f, noon('2031-11-09'))).toEqual(['photos']);
    expect(rulesDue(f, noon('2031-11-10'))).toEqual(['photos', 'paid']);
    // A paid order that was withdrawn is never treated as an enquiry.
    expect(dueDates(facts('withdrawn', true)).enquiries).toBeUndefined();
  });

  it('has no photos rule once the photos are gone', () => {
    expect(dueDates(facts('completed', true, { hasPhotos: false })).photos).toBeUndefined();
  });

  it('holds everything back while an extension is in force, and applies again after its date', () => {
    const f = facts('rejected', false, { retainUntil: '2028-01-31' });
    expect(rulesDue(f, noon('2027-12-01'))).toEqual([]);
    expect(rulesDue(f, noon('2028-01-31'))).toEqual([]); // the last day of the extension
    expect(rulesDue(f, noon('2028-02-01'))).toEqual(['enquiries']);
  });

  it('counts in Sydney dates: a late-evening status change belongs to that Sydney day', () => {
    // 22:30 on 30 Nov in Sydney is 11:30 UTC on 30 Nov; 00:30 on 1 Dec Sydney is 13:30 UTC on 30 Nov.
    expect(dueDates(facts('rejected', false, { statusChangedAt: new Date('2026-11-30T11:30:00Z') })).enquiries).toBe('2027-11-30');
    expect(dueDates(facts('rejected', false, { statusChangedAt: new Date('2026-11-30T13:30:00Z') })).enquiries).toBe('2027-12-01');
  });
});

// ── The job, against a database and a fake HubSpot ────────────────────────────

let t: TestApp;
let hs: FakeHubSpot;
afterEach(async () => {
  vi.restoreAllMocks();
  await t?.close();
});

const KEY = ['pat', 'ap1', 'retentiontestkey'].join('-');
let n = 0;

async function setup(withCrm = true): Promise<{ crm: CrmDeps | null }> {
  t = await makeApp({ env: { APP_ENV: 'staging' } });
  if (!withCrm) return { crm: null };
  hs = fakeHubSpot({ portalId: '111' });
  const client = hubspotClient(KEY, 'https://api.hubapi.test', hs.fetch);
  await applySetup(client, await planSetup(client));
  return { crm: { db: t.db, adapter: hubspotAdapter(client), portalId: () => portalIdOf(client), expectedPortalId: '111', now: () => t.clock.now } };
}

async function place(email = `ret${++n}@test.picklemypaddle.com`, paddles = 1) {
  const res = await post(t, await orderForm(t, { email, paddles }));
  expect(res.status).toBe(201);
  return { ...((await res.json()) as { reference: string; statusToken: string }), email };
}

async function walk(reference: string, ...steps: OrderStatus[]) {
  for (const to of steps) {
    await transitionOrder(
      { db: t.db, isProduction: false, now: t.clock.now },
      {
        reference,
        to,
        actor: to === 'lapsed' ? 'system' : 'admin',
        ...(to === 'posted_back' ? { trackingNumber: 'AP1' } : {}),
        ...(to === 'rejected' ? { reason: 'Cracked face.' } : {}),
      },
    );
  }
}
const COMPLETE: OrderStatus[] = ['accepted', 'paid', 'in_queue', 'regritted', 'posted_back', 'completed'];

const exists = async (reference: string) =>
  Number((await t.db.query<{ n: string }>('SELECT count(*) AS n FROM orders WHERE reference = $1', [reference])).rows[0]!.n) === 1;
const photoRows = async (reference: string) =>
  Number(
    (await t.db.query<{ n: string }>('SELECT count(*) AS n FROM photos ph JOIN paddles p ON p.id = ph.paddle_id JOIN orders o ON o.id = p.order_id WHERE o.reference = $1', [reference])).rows[0]!.n,
  );
const later = (months: number, days = 0) => {
  const d = new Date(t.clock.now);
  d.setUTCMonth(d.getUTCMonth() + months);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
};
const deps = (crm: CrmDeps | null) => ({ db: t.db, photos: t.photos, crm });

describe('the daily retention job', () => {
  it('deletes a completed order’s photos (files and rows) after 12 months, and keeps the order', async () => {
    const { crm } = await setup(false);
    const o = await place(undefined, 2);
    await walk(o.reference, ...COMPLETE);
    expect(await photoFiles(t.photoDir)).toHaveLength(4);

    expect((await runRetention(deps(crm), later(12, -1))).photos).toBe(0);
    expect(await photoRows(o.reference)).toBe(4);

    expect((await runRetention(deps(crm), later(12))).photos).toBe(1);
    expect(await photoRows(o.reference)).toBe(0);
    expect(await photoFiles(t.photoDir)).toEqual([]);
    expect(await exists(o.reference)).toBe(true);

    // Idempotent: nothing more to do.
    expect(await runRetention(deps(crm), later(13))).toEqual({ photos: 0, enquiries: 0, paid: 0, waiting: 0 });
  });

  it('deletes an order that never went ahead 12 months on, with its HubSpot deal and contact', async () => {
    const { crm } = await setup();
    const o = await place();
    await walk(o.reference, 'rejected');
    await processCrm(crm!);
    expect(hs.contacts.has(o.email)).toBe(true);
    expect(hs.deals.size).toBe(1);

    expect((await runRetention(deps(crm), later(12, -1))).enquiries).toBe(0);
    expect((await runRetention(deps(crm), later(12))).enquiries).toBe(1);
    expect(await exists(o.reference)).toBe(false);
    expect(await photoFiles(t.photoDir)).toEqual([]);
    expect(hs.deals.size).toBe(0);
    expect(hs.contacts.has(o.email)).toBe(false);
    expect(hs.calls.some((c) => c.path === '/crm/v3/objects/contacts/gdpr-delete')).toBe(true);
    // Its status link is dead too (the token rows went with the order).
    expect(Number((await t.db.query<{ n: string }>('SELECT count(*) AS n FROM status_tokens')).rows[0]!.n)).toBe(0);
  });

  it('keeps the HubSpot contact while the customer has another order', async () => {
    const { crm } = await setup();
    const email = 'repeat@test.picklemypaddle.com';
    const first = await place(email);
    await walk(first.reference, 'withdrawn');
    const second = await place(email);
    await processCrm(crm!);
    await runRetention(deps(crm), later(12));
    expect(await exists(first.reference)).toBe(false);
    expect(await exists(second.reference)).toBe(true);
    expect(hs.contacts.has(email)).toBe(true);
    expect(hs.deals.size).toBe(1);
  });

  it('treats lapsed orders as never having gone ahead', async () => {
    const { crm } = await setup(false);
    const o = await place();
    await walk(o.reference, 'questions', 'lapsed');
    expect((await runRetention(deps(crm), later(12))).enquiries).toBe(1);
    expect(await exists(o.reference)).toBe(false);
  });

  it('keeps a paid order 5 years, even if it was withdrawn after paying', async () => {
    const { crm } = await setup(false);
    const done = await place();
    await walk(done.reference, ...COMPLETE);
    const refunded = await place();
    await walk(refunded.reference, 'accepted', 'paid', 'withdrawn');

    await runRetention(deps(crm), later(59, 27));
    expect(await exists(done.reference)).toBe(true);
    expect(await exists(refunded.reference)).toBe(true);

    expect((await runRetention(deps(crm), later(60))).paid).toBe(2);
    expect(await exists(done.reference)).toBe(false);
    expect(await exists(refunded.reference)).toBe(false);
  });

  it('never touches open orders, however old', async () => {
    const { crm } = await setup(false);
    const o = await place();
    await walk(o.reference, 'accepted', 'paid', 'in_queue');
    expect(await runRetention(deps(crm), later(120))).toEqual({ photos: 0, enquiries: 0, paid: 0, waiting: 0 });
    expect(await photoRows(o.reference)).toBe(2);
  });

  it('honours an extension until its date, then deletes', async () => {
    const { crm } = await setup(false);
    const o = await place();
    await walk(o.reference, 'rejected');
    await setExtension(t.db, o.reference, { until: '2027-12-31', reason: 'Customer dispute' }, t.clock.now);
    expect(await activeExtensions(t.db, t.clock.now)).toEqual([{ reference: o.reference, until: '2027-12-31', reason: 'Customer dispute' }]);

    expect((await runRetention(deps(crm), noon('2027-12-31'))).enquiries).toBe(0);
    expect(await exists(o.reference)).toBe(true);
    expect(await activeExtensions(t.db, noon('2028-01-01'))).toEqual([]); // expired
    expect((await runRetention(deps(crm), noon('2028-01-01'))).enquiries).toBe(1);
  });

  it('refuses an extension without a reason, in the past, or beyond 5 years', async () => {
    await setup(false);
    const o = await place();
    for (const [ext, msg] of [
      [{ until: '2027-06-01', reason: ' ' }, /reason/],
      [{ until: '2026-10-25', reason: 'x' }, /after today/],
      [{ until: '2032-01-01', reason: 'x' }, /at most 5 years/],
    ] as const) {
      await expect(setExtension(t.db, o.reference, ext, t.clock.now)).rejects.toThrow(msg);
    }
  });

  it('leaves a due order in place when HubSpot can’t be reached, and deletes it on the next run', async () => {
    const { crm } = await setup();
    const o = await place();
    await walk(o.reference, 'rejected');
    await processCrm(crm!);
    hs.failNext.push(503); // the deal delete (the portal was verified by the sync above)
    expect(await runRetention(deps(crm), later(12))).toMatchObject({ enquiries: 0, waiting: 1 });
    expect(await exists(o.reference)).toBe(true);
    expect(hs.contacts.has(o.email)).toBe(true);
    expect(await runRetention(deps(crm), later(12, 1))).toMatchObject({ enquiries: 1, waiting: 0 });
  });

  it('records each run’s counts, and logs counts only', async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => void lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    const { crm } = await setup(false);
    const o = await place('unique.retention.person@test.picklemypaddle.com');
    await walk(o.reference, 'rejected');
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
    await runRetention(deps(crm), later(12));
    const all = lines.join('\n');
    expect(all).toMatch(/retention_run/);
    expect(all).not.toContain(o.reference);
    expect(all).not.toContain('unique.retention.person');
    expect(all).not.toContain('Test Player');
    const runs = await recentRuns(t.db);
    expect(runs[0]!.counts).toEqual({ photos: 0, enquiries: 1, paid: 0, waiting: 0 });
  });
});

describe('admin: retention page and extensions (AC6)', () => {
  it('lists what is due within 14 days by rule, and saves and removes an extension', async () => {
    await setup(false);
    const a = await makeAdmin(t);
    const soon = await place();
    await walk(soon.reference, 'rejected');
    const far = await place();
    await walk(far.reference, ...COMPLETE);

    t.clock.now = later(12, -10); // ten days before the rejected order is due
    let page = await (await a.get('/admin/retention')).text();
    expect(page).toContain(soon.reference);
    expect(page).toContain(far.reference); // its photos are due the same day
    expect(await upcomingDeletions(t.db, t.clock.now)).toHaveLength(2);

    const res = await a.post(`/admin/orders/${soon.reference}/retention`, { action: 'extend', until: '2028-06-30', reason: 'Disputed charge' });
    expect(res.status).toBe(303);
    page = await (await a.get('/admin/retention')).text();
    expect(page).toContain('Extensions in force');
    expect(page).toContain('Disputed charge');
    expect((await upcomingDeletions(t.db, t.clock.now)).map((u) => u.reference)).toEqual([far.reference]);

    const detail = await (await a.get(`/admin/orders/${soon.reference}`)).text();
    expect(detail).toContain('Held back until 30 June 2028: Disputed charge');
    expect((await a.post(`/admin/orders/${soon.reference}/retention`, { action: 'extend', until: '2028-06-30', reason: '' })).status).toBe(400);

    expect((await a.post(`/admin/orders/${soon.reference}/retention`, { action: 'clear' })).status).toBe(303);
    expect(await activeExtensions(t.db, t.clock.now)).toEqual([]);
  });

  it('shows the order’s own dates', async () => {
    await setup(false);
    const a = await makeAdmin(t);
    const o = await place();
    await walk(o.reference, ...COMPLETE);
    const page = await (await a.get(`/admin/orders/${o.reference}`)).text();
    expect(page).toContain('Photos deleted on 26 Oct 2027');
    expect(page).toContain('Order deleted (end of the 5-year tax record) on 26 Oct 2031');
  });
});
