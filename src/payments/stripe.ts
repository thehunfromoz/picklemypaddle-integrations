/**
 * A small Stripe client (SCRUM-82): only the calls PickleMyPaddle makes, over fetch, so tests can
 * fake Stripe at the HTTP boundary (tests/helpers/fake-stripe.ts).
 *
 * The key is a restricted key (rk_test_… on staging) with, and only with:
 *   Checkout Sessions: Write · PaymentIntents: Read · Charges: Read · Balance: Read · Events: Read
 * (docs/working-with-claude.md and the staging runbook list them).
 *
 * No Stripe-Version header: the account's API version applies. The fields used here (ids,
 * amount_total, payment_status, client_reference_id, payment_intent, latest_charge,
 * balance_transaction.fee, amount_refunded) are stable across versions. No-cost line items (a
 * free re-grit line at A$0) need 2023-08-16 or later, which every account made since has.
 */

export class StripeError extends Error {
  constructor(
    readonly status: number | null,
    readonly code: string,
  ) {
    super(`stripe ${code}`);
    this.name = 'StripeError';
  }
}

/** The parts of a Checkout Session we read. */
export interface CheckoutSession {
  id: string;
  object: 'checkout.session';
  url: string | null;
  mode: string;
  status: 'open' | 'complete' | 'expired' | string;
  payment_status: 'paid' | 'unpaid' | 'no_payment_required' | string;
  client_reference_id: string | null;
  amount_total: number | null;
  currency: string | null;
  payment_intent: string | null;
  livemode: boolean;
  created: number;
  expires_at: number;
  metadata?: Record<string, string>;
}

export interface PaymentIntent {
  id: string;
  amount_received: number;
  currency: string;
  created: number;
  latest_charge: null | {
    id: string;
    created: number;
    amount_refunded: number;
    balance_transaction: null | { id: string; fee: number };
  };
}

export interface Charge {
  id: string;
  object: 'charge';
  payment_intent: string | null;
  amount: number;
  amount_refunded: number;
  refunded: boolean;
  livemode: boolean;
}

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: { object: CheckoutSession | Charge | Record<string, unknown> };
}

export interface EventPage {
  data: StripeEvent[];
  has_more: boolean;
}

/** Form value for Stripe's x-www-form-urlencoded bodies: nested objects and arrays allowed. */
export type FormValue = string | number | boolean | null | undefined | FormValue[] | { [key: string]: FormValue };

/** `{ a: { b: [ { c: 1 } ] } }` → `a[b][0][c]=1`, as Stripe expects. */
export function formEncode(value: Record<string, FormValue>): string {
  const out = new URLSearchParams();
  const walk = (prefix: string, v: FormValue) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((item, i) => walk(`${prefix}[${i}]`, item));
    else if (typeof v === 'object') for (const [k, item] of Object.entries(v)) walk(prefix ? `${prefix}[${k}]` : k, item);
    else out.append(prefix, String(v));
  };
  walk('', value as FormValue);
  return out.toString();
}

export const STRIPE_EVENT_TYPES = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'charge.refunded'] as const;

export interface StripeApi {
  /** True for a live key (production), false for test mode. */
  readonly livemode: boolean;
  createCheckoutSession(params: Record<string, FormValue>, idempotencyKey: string): Promise<CheckoutSession>;
  expireCheckoutSession(id: string): Promise<CheckoutSession>;
  getCheckoutSession(id: string): Promise<CheckoutSession>;
  /** With latest_charge.balance_transaction expanded, for the fee. */
  getPaymentIntent(id: string): Promise<PaymentIntent>;
  listEvents(query: { endingBefore?: string; startingAfter?: string; createdGte?: number; limit?: number }): Promise<EventPage>;
}

export function stripeClient(key: string, base = 'https://api.stripe.com', fetchImpl: typeof fetch = fetch, timeoutMs = 20_000): StripeApi {
  const root = base.replace(/\/$/, '');
  const request = async <T>(method: 'GET' | 'POST', path: string, body?: string, extraHeaders: Record<string, string> = {}): Promise<T> => {
    let res: Response;
    try {
      res = await fetchImpl(`${root}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          'User-Agent': 'picklemypaddle-integrations',
          ...(body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...extraHeaders,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new StripeError(null, `network:${(err as Error)?.name ?? 'error'}`);
    }
    if (res.ok) return (await res.json()) as T;
    // Stripe's error type and code only (e.g. invalid_request_error/resource_missing): never the
    // message, which can quote what was sent.
    let code = `http:${res.status}`;
    try {
      const e = ((await res.json()) as { error?: { type?: string; code?: string } }).error;
      if (e?.type) code += `:${e.type}${e.code ? `/${e.code}` : ''}`;
    } catch {
      // not JSON
    }
    throw new StripeError(res.status, code);
  };
  const id = (v: string) => {
    if (!/^[A-Za-z0-9_]{3,255}$/.test(v)) throw new StripeError(null, 'bad_id');
    return v;
  };
  return {
    livemode: /^(sk|rk)_live_/.test(key),
    createCheckoutSession: (params, idempotencyKey) =>
      request('POST', '/v1/checkout/sessions', formEncode(params), { 'Idempotency-Key': idempotencyKey }),
    expireCheckoutSession: (sid) => request('POST', `/v1/checkout/sessions/${id(sid)}/expire`, ''),
    getCheckoutSession: (sid) => request('GET', `/v1/checkout/sessions/${id(sid)}`),
    getPaymentIntent: (pi) => request('GET', `/v1/payment_intents/${id(pi)}?expand[]=latest_charge.balance_transaction`),
    listEvents: ({ endingBefore, startingAfter, createdGte, limit = 100 }) => {
      const q = new URLSearchParams({ limit: String(limit) });
      for (const t of STRIPE_EVENT_TYPES) q.append('types[]', t);
      if (endingBefore) q.set('ending_before', id(endingBefore));
      if (startingAfter) q.set('starting_after', id(startingAfter));
      if (createdGte !== undefined) q.set('created[gte]', String(createdGte));
      return request('GET', `/v1/events?${q.toString()}`);
    },
  };
}
