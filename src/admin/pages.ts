/**
 * The admin's pages (SCRUM-72): the order list and an order's detail, as plain server-rendered
 * HTML forms. No client-side script, so the CSP can allow none; works on a phone over Tailscale.
 */
import { sydneyDate } from '../orders/dates.js';
import { quotePostage } from '../pricing/postage.js';
import { taxWording, termsOn, type TaxSettings } from '../pricing/terms.js';
import { STATUSES, type OrderStatus, PRICE_PER_PADDLE_CENTS } from '../orders/model.js';
import { canTransition, EMAIL_ON, TRANSITIONS } from '../orders/transitions.js';
import { dashboardUrl, problemText, REINSTATABLE } from '../payments/payments.js';
import { describeDiscount, discountCents } from '../orders/rules.js';
import { ADMIN_LABELS, WAITING, type ListedOrder, type OrderDetail } from './data.js';
import type { AdminIdentity } from './guard.js';
import { calendarDay, dollars, html, type Html, when } from './html.js';

export interface PageContext {
  admin: AdminIdentity;
  isProduction: boolean;
  now: Date;
  /** SCRUM-81: GST_REGISTERED_FROM, for the terms an Accept would use today. */
  tax?: TaxSettings;
  /** SCRUM-82: whether a Stripe key is set here. */
  paymentsConfigured?: boolean;
}

export function layout(ctx: PageContext, title: string, body: Html): string {
  return html`<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title} · PickleMyPaddle admin</title>
<link rel="stylesheet" href="/admin/admin.css">
</head>
<body>
<header class="bar">
  <a href="/admin/orders">PickleMyPaddle orders${ctx.isProduction ? '' : ' (TEST)'}</a>
  <a href="/admin/codes">Discount codes</a>
  <a href="/admin/documents">Documents</a>
  <a href="/admin/retention">Retention</a>
  <span class="who">Signed in through Tailscale as ${ctx.admin.name ?? ctx.admin.login}</span>
</header>
<main>
${body}
</main>
</body>
</html>`.value;
}

const statusBadge = (s: OrderStatus) => html`<span class="badge">${ADMIN_LABELS[s]}</span>`;

/** "Mon, 16 Nov" for a YYYY-MM-DD calendar date (no time-zone shift). */
const shortDay = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
};

/** SCRUM-73 AC5: the promise, flagged when 2 business days away or less, or past. */
const promiseBadge = (p: { on: string; state: 'ok' | 'soon' | 'late' } | null) =>
  !p || p.state === 'ok' ? '' : p.state === 'late' ? html` <span class="badge overdue">Past promise</span>` : html` <span class="badge due">Due soon</span>`;
const testBadge = (isTest: boolean) => (isTest ? html` <span class="badge test">TEST</span>` : '');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── Order list ────────────────────────────────────────────────────────────────

export type ListFilter = 'waiting' | 'all' | OrderStatus;

export function parseFilter(value: string | undefined): ListFilter | null {
  if (!value || value === 'waiting') return 'waiting';
  if (value === 'all') return 'all';
  return (STATUSES as readonly string[]).includes(value) ? (value as OrderStatus) : null;
}

export const filterStatuses = (f: ListFilter): readonly OrderStatus[] => (f === 'waiting' ? WAITING : f === 'all' ? STATUSES : [f]);

export function listPage(ctx: PageContext, filter: ListFilter, orders: ListedOrder[]): string {
  const chip = (value: ListFilter, label: string) =>
    html`<li><a href="/admin/orders?status=${value}"${filter === value ? html` aria-current="page"` : ''}>${label}</a></li>`;
  const heading = filter === 'waiting' ? 'Waiting on you' : filter === 'all' ? 'All orders' : ADMIN_LABELS[filter];
  const overdue = orders.filter((o) => o.overdue).length;
  const late = orders.filter((o) => o.promise?.state === 'late').length;
  const soon = orders.filter((o) => o.promise?.state === 'soon').length;
  const payIssues = orders.filter((o) => o.paymentProblem).length;
  return layout(
    ctx,
    heading,
    html`<h1>${heading} <span class="small">(${orders.length})</span></h1>
<ul class="filters" aria-label="Filter by status">
  ${chip('waiting', 'Waiting on you')}${STATUSES.map((s) => chip(s, ADMIN_LABELS[s]))}${chip('all', 'All')}
</ul>
${overdue > 0 ? html`<p class="flash warn">${plural(overdue, 'order')} past the 1-business-day reply promise.</p>` : ''}
${late > 0 ? html`<p class="flash error">${plural(late, 'order')} past the “back in the post by” date.</p>` : ''}
${soon > 0 ? html`<p class="flash warn">${plural(soon, 'order')} due back in the post within 2 business days.</p>` : ''}
${payIssues > 0 ? html`<p class="flash error">${plural(payIssues, 'payment')} to check: reinstate the order or refund in Stripe.</p>` : ''}
${
  orders.length === 0
    ? html`<p class="empty">Nothing here.</p>`
    : html`<ul class="orders">${orders.map(
        (o) => html`<li><a href="/admin/orders/${o.reference}">
  <span><span class="ref">${o.reference}</span>${testBadge(o.isTest)}${o.overdue ? html` <span class="badge overdue">Reply overdue</span>` : ''}${promiseBadge(o.promise)}${
    o.paymentProblem ? html` <span class="badge overdue">${o.paymentProblem === 'late' ? 'Payment after lapse' : 'Check payment'}</span>` : ''
  }${
    o.reviewed ? html` <span class="badge sent">Reviewed${o.reviewed.mayQuote ? '' : ' (private)'}</span>` : ''
  }</span>
  ${statusBadge(o.status)}
  <span class="meta">${when(o.createdAt)} · ${plural(o.paddles, 'paddle')} · ${plural(o.daysInStatus, 'day')} in ${ADMIN_LABELS[o.status]}${
    o.promise ? ` · back in the post by ${shortDay(o.promise.on)}` : ''
  }${o.lapsesInDays !== null ? ` · lapses ${o.lapsesInDays <= 0 ? 'today' : `in ${plural(o.lapsesInDays, 'day')}`} unless paid` : ''}</span>
</a></li>`,
      )}</ul>`
}`,
  );
}

// ── Order detail ──────────────────────────────────────────────────────────────

export interface Flash {
  kind: 'error' | 'done';
  text: string;
}

const csrfField = (ctx: PageContext) => html`<input type="hidden" name="_csrf" value="${ctx.admin.csrf}">`;

/** The form for one move, with the fields that move needs. */
function actionForm(ctx: PageContext, o: OrderDetail, to: OrderStatus): Html {
  const email = EMAIL_ON[to];
  const emailNote = email ? html`<p class="small">Emails the customer (“${ADMIN_LABELS[to]}”).</p>` : html`<p class="small">No email to the customer.</p>`;
  let fields: Html | string = '';
  if (to === 'accepted') {
    // SCRUM-81: the price and postage are worked out here, from today's terms; postage can be
    // changed, but then it needs a reason (kept in the history).
    const today = sydneyDate(ctx.now);
    const terms = termsOn(today, ctx.tax ?? { gstRegisteredFrom: null });
    const n = o.paddles.length;
    const regrit = n * terms.pricePerPaddleCents;
    const quote = quotePostage(n, o.postcode, today);
    const postageValue = quote.ok ? (quote.cents / 100).toFixed(2) : '';
    const discount = o.discount ? discountCents(o.discount, n, terms.pricePerPaddleCents) : 0;
    const total = regrit - discount + (quote.ok ? quote.cents : 0);
    fields = html`<dl class="facts">
  <dt>Re-grit</dt><dd>${plural(n, 'paddle')} × ${dollars(terms.pricePerPaddleCents)} = ${dollars(regrit)}</dd>
  ${o.discount ? html`<dt>Discount</dt><dd>−${dollars(discount)}: code ${o.discount.code} (${describeDiscount(o.discount)})</dd>` : ''}
  <dt>Return postage</dt><dd>${
    quote.ok
      ? html`${dollars(quote.cents)}: ${quote.packing}, charged on ${String(quote.chargeableKg)} kg (${String(quote.actualKg)} kg actual, ${String(quote.cubicKg)} kg cubic)${quote.zone ? `, zone ${quote.zone}` : ''}; Australia Post ${dollars(quote.postageCents)} + packaging ${quote.packagingCents ? dollars(quote.packagingCents) : `absorbed (${dollars(quote.packagingCostCents)})`}`
      : html`<strong>${quote.reason}</strong>`
  }</dd>
  ${quote.ok ? html`<dt>Total</dt><dd>${dollars(total)} · ${taxWording(terms.treatment, total).gstLine}</dd>` : ''}
</dl>
<label>Return postage (A$)${quote.ok ? ', calculated' : ', required'}
  <input name="postage" inputmode="decimal" pattern="\\d{1,5}(\\.\\d{1,2})?" value="${postageValue}"${quote.ok ? '' : ' required'}></label>
<label>Reason, only if you change the postage${quote.ok ? '' : ' (required)'} (kept in the history, never shown to the customer)
  <input name="postageReason" maxlength="2000"${quote.ok ? '' : ' required'}></label>`;
  } else if (to === 'rejected') {
    fields = html`<label>Reason, sent to the customer as you type it (required)
  <textarea name="reason" required maxlength="2000"></textarea></label>`;
  } else if (to === 'in_queue') {
    fields = html`<label>Day the paddles arrived
  <input type="date" name="arrivedOn" required value="${sydneyDate(ctx.now)}" max="${sydneyDate(ctx.now)}"></label>`;
  } else if (to === 'posted_back') {
    fields = html`<label>Tracking number (required)
  <input name="trackingNumber" required maxlength="64" pattern="[A-Za-z0-9 \\-]+" autocomplete="off"></label>`;
  }
  const danger = to === 'rejected' || to === 'withdrawn';
  return html`<details class="action">
<summary>Move to ${ADMIN_LABELS[to]}</summary>
<form method="post" action="/admin/orders/${o.reference}/status">
  ${csrfField(ctx)}
  <input type="hidden" name="to" value="${to}">
  ${emailNote}
  ${fields}
  <label>Internal note (optional, never shown to the customer)
    <textarea name="note" maxlength="2000"></textarea></label>
  <button type="submit"${danger ? html` class="danger"` : ''}>Move to ${ADMIN_LABELS[to]}</button>
</form>
</details>`;
}

function actions(ctx: PageContext, o: OrderDetail): Html {
  // Paid is never a plain move: Stripe sets it, or Attila reinstates a late payment (below).
  const moves = (Object.keys(TRANSITIONS[o.status]) as OrderStatus[]).filter((to) => to !== 'paid' && canTransition(o.status, to, 'admin', ctx.isProduction));
  // SCRUM-82: only Stripe sets Paid, when the customer pays from the status page.
  const waiting =
    o.status !== 'accepted'
      ? ''
      : ctx.paymentsConfigured
        ? html`<p class="small">Waiting for the customer to pay: Stripe sets Paid when they do.${
            ctx.isProduction ? '' : ' On staging, pay from the status page with Stripe test card 4242 4242 4242 4242.'
          }</p>`
        : html`<p class="flash error" role="alert">Payments not configured: no Stripe key is set here, so the customer can’t pay online.</p>`;
  // SCRUM-83: a late payment on a Lapsed or Withdrawn order: reinstate it, or refund in Stripe.
  const late = o.payments.find((p) => p.problem && REINSTATABLE.has(p.problem) && p.refundedCents < p.amountCents);
  const reinstate =
    late && (o.status === 'lapsed' || o.status === 'withdrawn')
      ? html`<p class="flash error" role="alert">Payment received after the order ${o.status === 'lapsed' ? 'lapsed' : 'was withdrawn'}: ${dollars(late.amountCents)}. Reinstate it, or refund it in Stripe (the Payment section has the link).</p>
<details class="action" open><summary>Reinstate as paid</summary>
<form method="post" action="/admin/orders/${o.reference}/reinstate">
  ${csrfField(ctx)}
  <p class="small">Moves the order to Paid, takes the late payment as its payment, and records you and your note in the history.</p>
  <label>Why (required, kept in the history, never shown to the customer)
    <textarea name="note" required maxlength="2000"></textarea></label>
  <button type="submit">Reinstate as paid</button>
</form></details>`
      : '';
  if (moves.length === 0) return html`${reinstate}${waiting || (reinstate ? '' : html`<p class="empty">This order is closed.</p>`)}`;
  return html`${reinstate}${waiting}${moves.map((to) => actionForm(ctx, o, to))}`;
}

/** SCRUM-82: the Stripe payment(s) and any refunds. */
function paymentSection(o: OrderDetail): Html | string {
  if (o.payments.length === 0) return '';
  return html`<h2>Payment</h2>
<ul class="notes">${o.payments.map((p) => {
    const url = dashboardUrl(p);
    return html`<li><strong>${dollars(p.amountCents)}</strong> by card · ${when(p.paidAt)}${
      p.feeCents !== null ? ` · Stripe fee ${dollars(p.feeCents)}, net ${dollars(p.amountCents - p.feeCents)}` : ' · Stripe fee not known yet (filled in within a few minutes)'
    } · via ${p.source}${p.livemode ? '' : ' · TEST mode'}
  ${p.problem ? html`<div class="flash error" role="alert">Not applied: ${problemText(p.problem)}. Check it in Stripe and refund it there if needed.</div>` : ''}
  ${p.reinstatedAt ? html`<div class="small">Reinstated ${when(p.reinstatedAt)} by ${p.reinstatedBy ?? 'admin'}</div>` : ''}
  ${p.refundedCents ? html`<div>Refunded ${dollars(p.refundedCents)}${p.refundedAt ? ` (recorded ${when(p.refundedAt)})` : ''}</div>` : ''}
  <div class="small">${p.paymentIntentId ?? p.checkoutSessionId}${url ? html` · <a href="${url}" target="_blank" rel="noopener noreferrer">Open in Stripe</a>` : ''}</div></li>`;
  })}</ul>`;
}



/** SCRUM-33/80: the review, or where the one reminder stands; staging can send it now. */
function reviewSection(ctx: PageContext, o: OrderDetail): Html | string {
  if (o.review) {
    return html`<h2>Review</h2>
<blockquote class="pre">${o.review.quote}</blockquote>
<p class="small">${o.review.firstName}, ${o.review.suburb} · ${when(o.review.createdAt)} · ${
      o.review.permission ? 'may be quoted on the website' : 'NOT for the website (no permission)'
    }${o.reviewReminderAt ? ` · after the reminder of ${when(o.reviewReminderAt)}` : ''}</p>`;
  }
  if (o.status !== 'posted_back' && o.status !== 'completed') return '';
  const state = o.reviewReminderAt
    ? `No review yet. The one reminder went on ${when(o.reviewReminderAt)}; there won’t be another.`
    : o.reviewReminderDue
      ? `No review yet. The one reminder goes automatically on ${when(o.reviewReminderDue)}.`
      : 'No review yet.';
  const button =
    !ctx.isProduction && !o.reviewReminderAt
      ? html`<details class="action"><summary>Send review reminder now (test)</summary>
<form method="post" action="/admin/orders/${o.reference}/review-reminder-test">
  ${csrfField(ctx)}
  <p class="test-note">Test only: sends the one reminder now instead of 10 days after posting back. Not available in production.</p>
  <button type="submit">Send review reminder now (test)</button>
</form></details>`
      : '';
  return html`<h2>Review</h2><p class="empty">${state}</p>${button}`;
}

const ACTOR_LABELS: Record<string, string> = { customer: 'customer', admin: 'you', system: 'automatic', stripe: 'Stripe' };

export function detailPage(ctx: PageContext, o: OrderDetail, flash?: Flash, extra: Html | string = ''): string {
  const amountLine = o.paddles.length * PRICE_PER_PADDLE_CENTS;
  return layout(
    ctx,
    o.reference,
    html`<p><a href="/admin/orders">← Orders</a></p>
${flash ? html`<p class="flash ${flash.kind}" role="${flash.kind === 'error' ? 'alert' : 'status'}">${flash.text}</p>` : ''}
<h1>${o.reference}${testBadge(o.isTest)} ${statusBadge(o.status)}</h1>
<p class="small">Placed ${when(o.createdAt)} · in ${ADMIN_LABELS[o.status]} since ${when(o.statusChangedAt)}${
      o.crmDealId ? ' · mirrored to HubSpot' : ''
    }</p>

<h2>Next step</h2>
${actions(ctx, o)}

<h2>Customer</h2>
<dl class="facts">
  <dt>Name</dt><dd>${o.name}</dd>
  <dt>Email</dt><dd><a href="mailto:${o.email}">${o.email}</a></dd>
  <dt>Phone</dt><dd>${o.phone ?? '—'}</dd>
  <dt>Return address</dt><dd class="pre">${o.street}
${o.suburb} ${o.state} ${o.postcode}</dd>
  ${
    o.price
      ? html`<dt>Price (fixed at Accept)</dt><dd>Re-grit ${dollars(o.price.subtotalCents)}${
          o.price.discountCents ? html` − discount ${dollars(o.price.discountCents)}${o.discount ? ` (${o.discount.code})` : ''}` : ''
        } + postage ${dollars(o.price.postageCents)} = <strong>${dollars(o.amountCents ?? 0)}</strong> · ${
          o.price.taxTreatment === 'gst_inclusive' ? `includes GST ${dollars(o.price.gstCents)}` : 'no GST'
        }${o.price.postageOverrideReason ? html`<br><span class="small">Postage overridden${
          o.price.postageQuotedCents !== null ? ` (calculated ${dollars(o.price.postageQuotedCents)})` : ''
        }: ${o.price.postageOverrideReason}</span>` : ''}${o.price.postageDetail ? html`<br><span class="small">${o.price.postageDetail}</span>` : ''}</dd>`
      : html`<dt>Standard price</dt><dd>${dollars(amountLine)} (${plural(o.paddles.length, 'paddle')}), plus return postage</dd>`
  }
  ${
    o.discount
      ? html`<dt>Discount code</dt><dd>${o.discount.code}: ${describeDiscount(o.discount)}${
          o.price
            ? html` = <strong>−${dollars(o.price.discountCents)}</strong> off the re-grit <span class="small">(fixed at Accept)</span>`
            : html` <span class="small">(about −${dollars(discountCents(o.discount, o.paddles.length, PRICE_PER_PADDLE_CENTS))}; fixed at Accept, never off postage)</span>`
        }</dd>`
      : ''
  }
  ${o.arrivedOn ? html`<dt>Arrived</dt><dd>${calendarDay(o.arrivedOn)}</dd>` : ''}
  ${o.promise ? html`<dt>Back in the post by</dt><dd>${calendarDay(o.promise.on)}${promiseBadge(o.promise)}</dd>` : ''}
  ${o.trackingNumber ? html`<dt>Tracking</dt><dd>${o.trackingNumber}</dd>` : ''}
</dl>

<h2>Paddles</h2>
<div class="paddles">
${o.paddles.map(
  (p) => html`<section class="paddle">
  <h3>${p.position + 1}. ${p.brand}${p.model ? ` ${p.model}` : ''}</h3>
  <div class="photos">${p.photos.map(
    (ph) => html`<figure><a href="/admin/photos/${ph.id}"><img src="/admin/photos/${ph.id}" alt="${ph.side} of paddle ${p.position + 1}" loading="lazy"></a><figcaption>${ph.side === 'front' ? 'Front' : 'Back'}</figcaption></figure>`,
  )}</div>
</section>`,
)}
</div>

<h2>Notes <span class="small">(only you see these)</span></h2>
${o.notes.length ? html`<ul class="notes">${o.notes.map((n) => html`<li><span class="small">${when(n.at)}</span><div class="pre">${n.note}</div></li>`)}</ul>` : html`<p class="empty">No notes yet.</p>`}
<details class="action"><summary>Add a note</summary>
<form method="post" action="/admin/orders/${o.reference}/notes">
  ${csrfField(ctx)}
  <label>Note<textarea name="note" required maxlength="4000"></textarea></label>
  <button type="submit">Save note</button>
</form></details>

<h2>History</h2>
<ol class="history">${o.history.map(
      (h) => html`<li><strong>${ADMIN_LABELS[h.status as OrderStatus] ?? h.status}</strong> <span class="small">${when(h.at)} · by ${
        ACTOR_LABELS[h.actor ?? ''] ?? h.actor ?? 'unknown'
      }</span>${h.note ? html`<div class="pre small">${h.note}</div>` : ''}</li>`,
    )}</ol>

<h2>Emails and HubSpot</h2>
${
  o.outbox.length
    ? html`<ul class="outbox">${o.outbox.map(
        (r) => html`<li>${r.kind === 'email' ? 'Email' : 'HubSpot sync'}${r.kind === 'email' ? html` <strong>${r.template}</strong>` : ''}
  <span class="badge ${r.state}">${r.state}</span>
  <span class="small">${when(r.createdAt)}${r.attempts > 1 ? ` · ${r.attempts} attempts` : ''}${r.lastError ? ` · ${r.lastError}` : ''}</span>
  ${
    r.state === 'failed'
      ? html`<form class="inline" method="post" action="/admin/outbox/${r.id}/retry">${csrfField(ctx)}<button type="submit" class="secondary">Retry</button></form>`
      : ''
  }</li>`,
      )}</ul>`
    : html`<p class="empty">Nothing sent for this order.</p>`
}

${paymentSection(o)}

${reviewSection(ctx, o)}

${extra}`,
  );
}

export function notFoundPage(ctx: PageContext, what: string): string {
  return layout(ctx, 'Not found', html`<p><a href="/admin/orders">← Orders</a></p><h1>Not found</h1><p>${what}</p>`);
}
