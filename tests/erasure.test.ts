/**
 * Erasure on request (SCRUM-75 AC7, AC8): unpaid orders deleted, paid ones minimised to the tax
 * record (checked column by column), HubSpot GDPR-deleted first, status links dead, an audit row
 * without personal data, and the admin's preview and confirmation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { applySetup, hubspotAdapter, hubspotClient, planSetup, portalIdOf } from '../src/crm/hubspot.js';
import { processCrm, type CrmDeps } from '../src/crm/sync.js';
import { eraseCustomer, planErasure, recentErasures } from '../src/orders/erasure.js';
import type { OrderStatus } from '../src/orders/model.js';
import { runRetention } from '../src/orders/retention.js';
import { submitReview } from '../src/orders/reviews.js';
import { runReviewReminders } from '../src/orders/review-reminder.js';
import { transitionOrder } from '../src/orders/transitions.js';
import { addNote } from '../src/admin/data.js';
import { makeAdmin } from './helpers/admin.js';
import { makeApp, orderForm, photoFiles, post, SITE, type TestApp } from './helpers/app.js';
import { fakeHubSpot, type FakeHubSpot } from './helpers/fake-hubspot.js';

let t: TestApp;
let hs: FakeHubSpot;
afterEach(async () => {
  await t?.close();
});

const KEY = ['pat', 'ap1', 'erasuretestkey'].join('-');
const EMAIL = 'erase.me@test.picklemypaddle.com';

async function setup(): Promise<CrmDeps> {
  t = await makeApp({ env: { APP_ENV: 'staging' } });
  hs = fakeHubSpot({ portalId: '111' });
  const client = hubspotClient(KEY, 'https://api.hubapi.test', hs.fetch);
  await applySetup(client, await planSetup(client));
  return { db: t.db, adapter: hubspotAdapter(client), portalId: () => portalIdOf(client), expectedPortalId: '111', now: () => t.clock.now };
}

async function place(email = EMAIL, paddles = 1) {
  const res = await post(t, await orderForm(t, { email, paddles, overrides: { name: 'Erin Erasable', phone: '0400 111 222', street: '9 Forget St', suburb: 'Nowhere' } }));
  expect(res.status).toBe(201);
  return (await res.json()) as { reference: string; statusToken: string };
}
async function walk(reference: string, ...steps: OrderStatus[]) {
  for (const to of steps) {
    await transitionOrder(
      { db: t.db, isProduction: false, now: t.clock.now },
      { reference, to, actor: 'admin', note: 'Spoke to Erin on the phone', ...(to === 'posted_back' ? { trackingNumber: 'AP999' } : {}), ...(to === 'rejected' ? { reason: 'Erin’s paddle is cracked.' } : {}), ...(to === 'accepted' ? { amountCents: 5500 } : {}) },
    );
  }
}
const COMPLETE: OrderStatus[] = ['accepted', 'paid', 'in_queue', 'regritted', 'posted_back', 'completed'];
const deps = (crm: CrmDeps | null) => ({ db: t.db, photos: t.photos, crm });
const statusOf = (token: string) =>
  t.app.request('/api/orders/status', { method: 'POST', body: JSON.stringify({ token }), headers: { 'Content-Type': 'application/json', Origin: SITE } });

describe('erasure on request', () => {
  it('deletes unpaid orders entirely and minimises paid ones to exactly the tax record', async () => {
    const crm = await setup();
    const paid = await place(EMAIL, 2);
    await walk(paid.reference, ...COMPLETE);
    await submitReview(t.db, { token: paid.statusToken, quote: 'Erin says it plays like new.', firstName: 'Erin', suburb: 'Nowhere', permission: true }, t.clock.now);
    await addNote(t.db, paid.reference, 'attila@test.picklemypaddle.com', 'Erin asked for a quick turnaround', t.clock.now);
    const unpaid = await place(EMAIL);
    await walk(unpaid.reference, 'rejected');
    const other = await place('someone.else@test.picklemypaddle.com');
    await processCrm(crm);
    expect(hs.contacts.has(EMAIL)).toBe(true);
    expect(hs.deals.size).toBe(3);

    const plan = await planErasure(deps(crm), ` ${EMAIL.toUpperCase()} `, t.clock.now);
    expect(Object.fromEntries(plan.orders.map((o) => [o.reference, o.action]))).toEqual({ [paid.reference]: 'minimise', [unpaid.reference]: 'delete' });
    expect(plan.open).toEqual([]);
    const result = await eraseCustomer(deps(crm), EMAIL, plan.fingerprint, t.clock.now);
    expect(result).toEqual({ deleted: 1, minimised: 1, crm: 'deleted' });

    // The unpaid order is gone.
    expect((await t.db.query('SELECT 1 FROM orders WHERE reference = $1', [unpaid.reference])).rows).toEqual([]);

    // The paid one keeps exactly the tax record. Every column, one by one:
    const { rows } = await t.db.query<Record<string, unknown>>('SELECT * FROM orders WHERE reference = $1', [paid.reference]);
    const o = rows[0]!;
    const kept = { reference: paid.reference, name: 'Erin Erasable', status: 'completed', is_test: true, is_smoke: false, amount_cents: 5500 };
    for (const [col, value] of Object.entries(kept)) expect(o[col], col).toBe(value);
    for (const col of ['id', 'created_at', 'status_changed_at', 'consent_at', 'tournament_ack_at', 'updated_at', 'erased_at', 'arrived_on', 'promise_on', 'crm_deal_id', 'review_reminder_at']) {
      expect(o[col], col).not.toBeNull();
    }
    for (const [col, value] of Object.entries({ email: '', email_norm: '', street: '', suburb: '', state: '', postcode: '' })) expect(o[col], col).toBe(value);
    for (const col of ['phone', 'tracking_number', 'idempotency_key', 'crm_contact_id']) expect(o[col], col).toBeNull();
    for (const col of ['retain_until', 'retain_reason', 'retain_set_at']) expect(o[col], col).toBeNull();
    // Nothing else on the order has been forgotten in this list.
    const checked = new Set([...Object.keys(kept), 'id', 'created_at', 'status_changed_at', 'consent_at', 'tournament_ack_at', 'updated_at', 'erased_at', 'arrived_on', 'promise_on', 'crm_deal_id', 'review_reminder_at', 'email', 'email_norm', 'street', 'suburb', 'state', 'postcode', 'phone', 'tracking_number', 'idempotency_key', 'crm_contact_id', 'retain_until', 'retain_reason', 'retain_set_at']);
    expect(Object.keys(o).filter((c) => !checked.has(c))).toEqual([]);

    const id = o.id as string;
    const count = async (sql: string) => Number((await t.db.query<{ n: string }>(sql, [id])).rows[0]!.n);
    expect(await count('SELECT count(*) AS n FROM photos ph JOIN paddles p ON p.id = ph.paddle_id WHERE p.order_id = $1')).toBe(0);
    expect((await t.db.query<{ brand: string; model: string | null }>('SELECT brand, model FROM paddles WHERE order_id = $1', [id])).rows).toEqual([
      { brand: '[erased]', model: null },
      { brand: '[erased]', model: null },
    ]);
    for (const table of ['status_tokens', 'outbox', 'order_notes', 'reviews']) expect(await count(`SELECT count(*) AS n FROM ${table} WHERE order_id = $1`), table).toBe(0);
    const history = (await t.db.query<{ status: string; note: string | null }>('SELECT status, note FROM status_history WHERE order_id = $1 ORDER BY at, id', [id])).rows;
    expect(history.map((h) => h.status)).toEqual(['submitted', ...COMPLETE]);
    expect(history.every((h) => h.note === null)).toBe(true);
    expect(await photoFiles(t.photoDir)).toHaveLength(2); // only the other customer's photos remain

    // Status links stop working at once.
    expect((await statusOf(paid.statusToken)).status).toBe(404);
    expect((await statusOf(unpaid.statusToken)).status).toBe(404);
    expect((await statusOf(other.statusToken)).status).toBe(200);

    // HubSpot: the contact GDPR-deleted, the unpaid deal deleted, the paid deal stripped.
    expect(hs.contacts.has(EMAIL)).toBe(false);
    expect(hs.calls.filter((c) => c.path === '/crm/v3/objects/contacts/gdpr-delete')).toHaveLength(1);
    const deals = [...hs.deals.values()];
    expect(deals).toHaveLength(2);
    const paidDeal = deals.find((d) => d.properties.pmp_reference === paid.reference)!;
    expect(paidDeal.properties).toMatchObject({ dealname: `[TEST] ${paid.reference}`, pmp_paddle_count: '', pmp_reviewed: '' });
    // Later syncs never recreate the contact.
    await processCrm(crm);
    expect(hs.contacts.has(EMAIL)).toBe(false);
    // And the one review reminder never goes to the erased order.
    expect(await runReviewReminders(t.db, new Date(t.clock.now.getTime() + 30 * 86_400_000))).toBe(0);

    // The audit row: counts and categories, nothing personal.
    const audit = await recentErasures(deps(crm));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ orders_deleted: 1, orders_minimised: 1, crm: 'deleted' });
    expect(JSON.stringify(audit)).not.toMatch(/erase\.me|Erin|PMP-/);
  });

  it('lets the paid rule delete the minimised record when its 5 years are up', async () => {
    const crm = await setup();
    const paid = await place();
    await walk(paid.reference, ...COMPLETE);
    await processCrm(crm);
    const plan = await planErasure(deps(crm), EMAIL, t.clock.now);
    await eraseCustomer(deps(crm), EMAIL, plan.fingerprint, t.clock.now);
    expect(hs.deals.size).toBe(1);
    const fiveYears = new Date(t.clock.now);
    fiveYears.setUTCFullYear(fiveYears.getUTCFullYear() + 5);
    expect((await runRetention(deps(crm), fiveYears)).paid).toBe(1);
    expect((await t.db.query('SELECT 1 FROM orders WHERE reference = $1', [paid.reference])).rows).toEqual([]);
    expect(hs.deals.size).toBe(0);
  });

  it('refuses while an order is still open', async () => {
    const crm = await setup();
    const o = await place();
    await walk(o.reference, 'accepted', 'paid', 'in_queue');
    const plan = await planErasure(deps(crm), EMAIL, t.clock.now);
    expect(plan.open).toEqual([o.reference]);
    await expect(eraseCustomer(deps(crm), EMAIL, plan.fingerprint, t.clock.now)).rejects.toThrow(/Finish or withdraw/);
  });

  it('refuses a confirmation for a plan that has since changed', async () => {
    const crm = await setup();
    const o = await place();
    await walk(o.reference, 'rejected');
    const plan = await planErasure(deps(crm), EMAIL, t.clock.now);
    const another = await place();
    await walk(another.reference, 'withdrawn');
    await expect(eraseCustomer(deps(crm), EMAIL, plan.fingerprint, t.clock.now)).rejects.toThrow(/changed since the preview/);
    expect((await t.db.query('SELECT 1 FROM orders WHERE email_norm = $1', [EMAIL])).rows).toHaveLength(2);
  });

  it('changes nothing when HubSpot can’t be reached', async () => {
    const crm = await setup();
    const o = await place();
    await walk(o.reference, 'rejected');
    await processCrm(crm);
    const plan = await planErasure(deps(crm), EMAIL, t.clock.now);
    hs.failNext.push(503);
    await expect(eraseCustomer(deps(crm), EMAIL, plan.fingerprint, t.clock.now)).rejects.toThrow(/nothing was erased/);
    expect((await t.db.query('SELECT 1 FROM orders WHERE reference = $1', [o.reference])).rows).toHaveLength(1);
    expect(await recentErasures(deps(crm))).toEqual([]);
    // A retry then works.
    await eraseCustomer(deps(crm), EMAIL, plan.fingerprint, t.clock.now);
    expect((await t.db.query('SELECT 1 FROM orders WHERE reference = $1', [o.reference])).rows).toEqual([]);
  });

  it('finds the HubSpot contact by email even when its ID was never stored', async () => {
    const crm = await setup();
    const o = await place();
    await walk(o.reference, 'withdrawn');
    await processCrm(crm);
    await t.db.query('UPDATE orders SET crm_contact_id = NULL');
    const plan = await planErasure(deps(crm), EMAIL, t.clock.now);
    await eraseCustomer(deps(crm), EMAIL, plan.fingerprint, t.clock.now);
    expect(hs.contacts.has(EMAIL)).toBe(false);
  });

  it('works without HubSpot configured, and says so', async () => {
    t = await makeApp({ env: { APP_ENV: 'staging' } });
    const o = await place();
    await walk(o.reference, 'rejected');
    const plan = await planErasure(deps(null), EMAIL, t.clock.now);
    expect(await eraseCustomer(deps(null), EMAIL, plan.fingerprint, t.clock.now)).toEqual({ deleted: 1, minimised: 0, crm: 'not configured' });
  });
});

describe('admin: Erase a customer', () => {
  it('previews exactly what goes, then erases only after the box is ticked', async () => {
    await setup();
    const a = await makeAdmin(t);
    const paid = await place();
    await walk(paid.reference, ...COMPLETE);
    const unpaid = await place();
    await walk(unpaid.reference, 'rejected');

    expect((await a.get('/admin/erase')).status).toBe(200);
    const preview = await a.post('/admin/erase/preview', { email: EMAIL });
    expect(preview.status).toBe(200);
    const page = await preview.text();
    expect(page).toContain('Deleted entirely (1)');
    expect(page).toContain('Kept as a tax record only (1)');
    expect(page).toContain(unpaid.reference);
    expect(page).toContain(paid.reference);
    const fingerprint = /name="fingerprint" value="([^"]+)"/.exec(page)![1]!;

    // Without the box ticked: nothing happens.
    expect((await a.post('/admin/erase/confirm', { email: EMAIL, fingerprint })).status).toBe(400);
    expect((await t.db.query('SELECT 1 FROM orders WHERE email_norm = $1', [EMAIL])).rows).toHaveLength(2);

    const done = await a.post('/admin/erase/confirm', { email: EMAIL, fingerprint, confirm: 'erase' });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('1 order deleted, 1 kept as tax record');
    const retention = await (await a.get('/admin/retention')).text();
    expect(retention).toContain('1 deleted, 1 kept as tax records');
    const detail = await (await a.get(`/admin/orders/${paid.reference}`)).text();
    expect(detail).toContain('Erased on request');
    expect(detail).toContain('A$55');
  });

  it('shows open orders and offers no confirm button', async () => {
    await setup();
    const a = await makeAdmin(t);
    const o = await place();
    await walk(o.reference, 'accepted');
    const page = await (await a.post('/admin/erase/preview', { email: EMAIL })).text();
    expect(page).toContain(`Still open: ${o.reference}`);
    expect(page).not.toContain('Erase now');
  });

  it('refuses the erase routes without the CSRF token', async () => {
    await setup();
    const a = await makeAdmin(t);
    expect((await a.post('/admin/erase/preview', { email: EMAIL, _csrf: 'x' })).status).toBe(403);
  });
});
