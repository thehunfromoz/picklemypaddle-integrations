/**
 * The admin's pages (SCRUM-72): the order list and an order's detail, as plain server-rendered
 * HTML forms. No client-side script, so the CSP can allow none; works on a phone over Tailscale.
 */
import { sydneyDate } from '../orders/dates.js';
import { STATUSES, type OrderStatus, PRICE_PER_PADDLE_CENTS } from '../orders/model.js';
import { canTransition, EMAIL_ON, TRANSITIONS } from '../orders/transitions.js';
import { ADMIN_LABELS, WAITING, type ListedOrder, type OrderDetail } from './data.js';
import type { AdminIdentity } from './guard.js';
import { calendarDay, dollars, html, type Html, when } from './html.js';

export interface PageContext {
  admin: AdminIdentity;
  isProduction: boolean;
  now: Date;
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
${
  orders.length === 0
    ? html`<p class="empty">Nothing here.</p>`
    : html`<ul class="orders">${orders.map(
        (o) => html`<li><a href="/admin/orders/${o.reference}">
  <span><span class="ref">${o.reference}</span>${testBadge(o.isTest)}${o.overdue ? html` <span class="badge overdue">Reply overdue</span>` : ''}${promiseBadge(o.promise)}</span>
  ${statusBadge(o.status)}
  <span class="meta">${when(o.createdAt)} · ${plural(o.paddles, 'paddle')} · ${plural(o.daysInStatus, 'day')} in ${ADMIN_LABELS[o.status]}${
    o.promise ? ` · back in the post by ${shortDay(o.promise.on)}` : ''
  }</span>
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
    const standard = o.paddles.length * PRICE_PER_PADDLE_CENTS;
    fields = html`<label>Amount (A$), if not ${dollars(standard)} for ${plural(o.paddles.length, 'paddle')}
  <input name="amount" inputmode="decimal" pattern="\\d{1,5}(\\.\\d{1,2})?" placeholder="${(standard / 100).toFixed(0)}"></label>`;
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
  const moves = (Object.keys(TRANSITIONS[o.status]) as OrderStatus[]).filter((to) => to !== 'paid' && canTransition(o.status, to, 'admin', ctx.isProduction));
  // Staging only (AC6): the Stripe webhook (SCRUM-9) sets Paid for real.
  const markPaid =
    !ctx.isProduction && o.status === 'accepted'
      ? html`<details class="action"><summary>Mark paid (test)</summary>
<form method="post" action="/admin/orders/${o.reference}/mark-paid-test">
  ${csrfField(ctx)}
  <p class="test-note">Test only: stands in for the Stripe payment. Not available in production.</p>
  <button type="submit">Mark paid (test)</button>
</form></details>`
      : '';
  if (moves.length === 0 && !markPaid) {
    const why = o.status === 'accepted' ? 'Waiting for the customer to pay (Stripe sets Paid).' : 'This order is closed.';
    return html`<p class="empty">${why}</p>`;
  }
  return html`${markPaid}${moves.map((to) => actionForm(ctx, o, to))}${
    o.status === 'accepted' && ctx.isProduction ? html`<p class="small">Paid is set by Stripe when the customer pays.</p>` : ''
  }`;
}

const ACTOR_LABELS: Record<string, string> = { customer: 'customer', admin: 'you', system: 'automatic', stripe: 'Stripe' };

export function detailPage(ctx: PageContext, o: OrderDetail, flash?: Flash): string {
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
  <dt>Standard price</dt><dd>${dollars(amountLine)} (${plural(o.paddles.length, 'paddle')}), plus return postage</dd>
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

${
  o.review
    ? html`<h2>Review</h2>
<blockquote class="pre">${o.review.quote}</blockquote>
<p class="small">${o.review.firstName}, ${o.review.suburb} · ${when(o.review.createdAt)} · ${
        o.review.permission ? 'may be quoted on the website' : 'NOT for the website (no permission)'
      }</p>`
    : ''
}`,
  );
}

export function notFoundPage(ctx: PageContext, what: string): string {
  return layout(ctx, 'Not found', html`<p><a href="/admin/orders">← Orders</a></p><h1>Not found</h1><p>${what}</p>`);
}
