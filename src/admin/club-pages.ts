/**
 * The admin's club pages (SCRUM-85): clubs and their billing details, each club's batches, and a
 * batch's page, where it is returned (issuing its invoice) or cancelled.
 */
import { BATCH_STATUS_LABELS, isOverdue, MAX_BATCH_PADDLES, MAX_CLUB_NOTE, type Batch, type BatchEmail, type BatchStatus, type Club } from '../clubs/clubs.js';
import { CLUB_PROBLEMS, MAX_PAYMENT_REFERENCE, METHOD_LABELS, type ClubPayment } from '../clubs/payments.js';
import { PROBLEM_TEXT } from '../payments/payments.js';
import { documentDate } from '../documents/documents.js';
import { calendarDay, dollars, html, type Html, when } from './html.js';
import { layout, type Flash, type PageContext } from './pages.js';

const csrfField = (ctx: PageContext) => html`<input type="hidden" name="_csrf" value="${ctx.admin.csrf}">`;
const flashBox = (flash?: Flash) =>
  flash ? html`<p class="flash ${flash.kind}" role="${flash.kind === 'error' ? 'alert' : 'status'}">${flash.text}</p>` : '';
const testBadge = (isTest: boolean) => (isTest ? html` <span class="badge test">TEST</span>` : '');
const clubBadge = (c: Club) => (c.status === 'active' ? html`<span class="badge">Active</span>` : html`<span class="badge">Inactive</span>`);

const BATCH_BADGE: Record<BatchStatus, string> = { collected: 'due', returned: '', invoiced: 'due', paid: '', cancelled: '' };
const batchBadge = (s: BatchStatus) => html`<span class="badge${BATCH_BADGE[s] ? ` ${BATCH_BADGE[s]}` : ''}">${BATCH_STATUS_LABELS[s]}</span>`;
const overdueBadge = (b: Batch, today: string) => (isOverdue(b, today) ? html` <span class="badge overdue">Overdue</span>` : '');
const problemWords = (p: string) => CLUB_PROBLEMS[p] ?? PROBLEM_TEXT[p] ?? p;

function clubFields(c?: Partial<Club>): Html {
  return html`<label>Club name<input name="name" required maxlength="120" value="${c?.name ?? ''}"></label>
  <label>Billing contact’s name<input name="billingName" required maxlength="120" value="${c?.billingName ?? ''}" autocomplete="off"></label>
  <label>Billing email (invoices go here)<input type="email" name="billingEmail" required maxlength="254" value="${c?.billingEmail ?? ''}" autocomplete="off"></label>
  <label>Billing address<textarea name="billingAddress" required maxlength="400" rows="3">${c?.billingAddress ?? ''}</textarea></label>
  <label>ABN (optional)<input name="abn" inputmode="numeric" maxlength="14" value="${c?.abn ?? ''}" autocomplete="off"></label>
  <label>Notes (only you see them)<textarea name="notes" maxlength="${MAX_CLUB_NOTE}" rows="3">${c?.notes ?? ''}</textarea></label>`;
}

function batchRows(batches: Batch[], withClub: boolean, today: string): Html {
  return html`<table class="list">
<thead><tr><th scope="col">Batch</th>${withClub ? html`<th scope="col">Club</th>` : ''}<th scope="col">Collected</th><th scope="col" class="num">Paddles</th><th scope="col">Status</th><th scope="col">Invoice</th><th scope="col" class="num">Owing</th></tr></thead>
<tbody>${batches.map(
    (b) => html`<tr><td><a href="/admin/batches/${b.reference}"><span class="ref">${b.reference}</span></a></td>${
      withClub ? html`<td><a href="/admin/clubs/${b.clubId}">${b.clubName}</a></td>` : ''
    }<td>${calendarDay(b.collectedOn)}</td><td class="num">${b.paddleCount}</td><td>${batchBadge(b.status)}${overdueBadge(b, today)}</td><td>${
      b.invoice ? html`<a href="/admin/documents/${b.invoice.number}">${b.invoice.number}</a> ${dollars(b.invoice.totalCents)}` : '—'
    }</td><td class="num">${b.invoice && b.invoice.balanceCents > 0 ? dollars(b.invoice.balanceCents) : '—'}</td></tr>`,
  )}</tbody></table>`;
}

export function clubsPage(ctx: PageContext, clubs: (Club & { openBatches: number })[], flash?: Flash, form?: Partial<Club>): string {
  return layout(
    ctx,
    'Clubs',
    html`<p><a href="/admin/orders">← Orders</a> · <a href="/admin/batches">Open batches</a></p>
${flashBox(flash)}
<h1>Clubs</h1>
<p class="small">Clubs keep their members’ details: only the club’s name and billing details are held here. Clubs never get discount codes.</p>
${
  clubs.length
    ? html`<ul class="orders">${clubs.map(
        (c) => html`<li><a href="/admin/clubs/${c.id}"><span><span class="ref">${c.name}</span>${testBadge(c.isTest)} <span class="small">${c.billingName} · ${
          c.openBatches === 1 ? '1 open batch' : `${c.openBatches} open batches`
        }</span></span>${clubBadge(c)}</a></li>`,
      )}</ul>`
    : html`<p class="empty">No clubs yet.</p>`
}
<details class="action"${form ? html` open` : ''}><summary>Add a club</summary>
<form method="post" action="/admin/clubs">
  ${csrfField(ctx)}
  ${clubFields(form)}
  <button type="submit">Add club</button>
</form></details>`,
  );
}

const CRM_STATE: Record<BatchEmail['state'], string> = { pending: 'Queued', sending: 'Syncing', sent: 'Up to date', failed: 'Failed', suppressed: 'Not synced' };

function crmLine(ctx: PageContext, sync: BatchEmail | null | undefined): Html | string {
  if (!sync) return '';
  return html`<p class="small outbox ${sync.state}">HubSpot: <strong>${CRM_STATE[sync.state]}</strong> (${when(sync.createdAt)}${sync.lastError ? ` · ${sync.lastError}` : ''})${
    sync.state === 'failed'
      ? html` <form class="inline" method="post" action="/admin/outbox/${sync.id}/retry">${csrfField(ctx)}<button type="submit" class="secondary">Retry</button></form>`
      : ''
  }</p>`;
}

export function clubPage(ctx: PageContext, club: Club, batches: Batch[], today: string, flash?: Flash, form?: Partial<Club>, sync?: BatchEmail | null): string {
  return layout(
    ctx,
    club.name,
    html`<p><a href="/admin/clubs">← Clubs</a></p>
${flashBox(flash)}
<h1>${club.name}${testBadge(club.isTest)} ${clubBadge(club)}</h1>
<p class="small">Added ${when(club.createdAt)}. Invoices go to ${club.billingName}, ${club.billingEmail}.</p>
${crmLine(ctx, sync)}

<h2>Batches</h2>
${batches.length ? batchRows(batches, false, today) : html`<p class="empty">No batches yet.</p>`}
${
  club.status === 'active'
    ? html`<details class="action"><summary>Record a batch collected</summary>
<form method="post" action="/admin/clubs/${club.id}/batches">
  ${csrfField(ctx)}
  <label>Collected on<input type="date" name="collectedOn" required max="${today}" value="${today}"></label>
  <label>Number of paddles (1 to ${MAX_BATCH_PADDLES})<input name="paddleCount" required inputmode="numeric" pattern="\\d{1,3}"></label>
  <label>Notes (optional, only you see them)<textarea name="notes" maxlength="${MAX_CLUB_NOTE}" rows="2"></textarea></label>
  <button type="submit">Record batch</button>
</form></details>`
    : html`<p class="small">This club is inactive: reactivate it to record a new batch.</p>`
}

<details class="action"${form ? html` open` : ''}><summary>Edit the club’s details</summary>
<form method="post" action="/admin/clubs/${club.id}">
  ${csrfField(ctx)}
  ${clubFields(form ?? club)}
  <p class="small">Invoices already issued keep the details they were issued with.</p>
  <button type="submit">Save</button>
</form></details>

<form method="post" action="/admin/clubs/${club.id}/active">
  ${csrfField(ctx)}
  <input type="hidden" name="active" value="${club.status === 'active' ? 'no' : 'yes'}">
  <button type="submit"${club.status === 'active' ? html` class="danger"` : ''}>${club.status === 'active' ? 'Make inactive' : 'Reactivate'}</button>
</form>
<p class="small">An inactive club keeps its batches and invoices; it just can’t have new batches.</p>`,
  );
}

export function batchesPage(ctx: PageContext, batches: Batch[], all: boolean, today: string): string {
  return layout(
    ctx,
    'Batches',
    html`<p><a href="/admin/clubs">← Clubs</a></p>
<h1>${all ? 'All batches' : 'Open batches'}</h1>
<p class="small">${all ? html`<a href="/admin/batches">Show open batches only</a>` : html`Collected, returned or invoiced and not yet paid. <a href="/admin/batches?all=1">Show all</a>`}</p>
${batches.length ? batchRows(batches, true, today) : html`<p class="empty">${all ? 'No batches yet.' : 'No open batches.'}</p>`}`,
  );
}

const EMAIL_LABELS: Record<string, string> = { club_invoice: 'Invoice email' };
const EMAIL_STATE: Record<BatchEmail['state'], string> = { pending: 'Queued', sending: 'Sending', sent: 'Sent', failed: 'Failed', suppressed: 'Not sent (test allow-list)' };

function emailsSection(ctx: PageContext, emails: BatchEmail[]): Html | string {
  if (!emails.length) return '';
  return html`<h2>Emails</h2><ul class="outbox">${emails.map(
    (e) => html`<li class="${e.state}">${EMAIL_LABELS[e.template] ?? e.template}: <strong>${EMAIL_STATE[e.state]}</strong> <span class="small">${when(e.createdAt)}${
      e.lastError ? ` · ${e.lastError}` : ''
    }</span>${
      e.state === 'failed'
        ? html` <form class="inline" method="post" action="/admin/outbox/${e.id}/retry">${csrfField(ctx)}<button type="submit" class="secondary">Retry</button></form>`
        : ''
    }</li>`,
  )}</ul>`;
}

export interface BatchPayments {
  payments: ClubPayment[];
  flagged: { paymentIntentId: string | null; amountCents: number; problem: string; refundedCents: number; livemode: boolean }[];
}

function paymentsSection(ctx: PageContext, b: Batch, p: BatchPayments, today: string): Html | string {
  if (!b.invoice) return '';
  const owing = b.invoice.balanceCents;
  return html`<h2>Payments</h2>
${
  p.payments.length
    ? html`<table class="list"><thead><tr><th scope="col">Received</th><th scope="col">Method</th><th scope="col">Reference</th><th scope="col" class="num">Amount</th></tr></thead><tbody>${p.payments.map(
        (x) => html`<tr><td>${calendarDay(x.paidOn)}</td><td>${METHOD_LABELS[x.method]}</td><td>${x.reference ?? '—'}</td><td class="num">${dollars(x.amountCents)}</td></tr>`,
      )}</tbody></table>`
    : html`<p class="empty">No payments yet.</p>`
}
<p>${owing > 0 ? html`Still owing: <strong>${dollars(owing)}</strong>${b.invoice.dueOn ? `, due ${documentDate(b.invoice.dueOn)}` : ''}${overdueBadge(b, today)}` : html`<strong>Paid in full.</strong>`}</p>
${p.flagged.map(
  (f) => html`<p class="flash error">A card payment of ${dollars(f.amountCents)}${f.paymentIntentId ? ` (Stripe ${f.paymentIntentId})` : ''} wasn’t applied: ${problemWords(f.problem)}.${
    f.refundedCents >= f.amountCents ? ' It has been refunded.' : ' Refund it in the Stripe dashboard.'
  }</p>`,
)}
${
  b.status === 'invoiced' && owing > 0
    ? html`<details class="action"><summary>Record a PayID or cash payment</summary>
<form method="post" action="/admin/batches/${b.reference}/payments">
  ${csrfField(ctx)}
  <label>Amount received (A$)<input name="amount" required inputmode="decimal" pattern="\\d{1,5}(\\.\\d{1,2})?" value="${(owing / 100).toFixed(2)}"></label>
  <label>Received on<input type="date" name="paidOn" required min="${b.collectedOn}" max="${today}" value="${today}"></label>
  <fieldset><legend>Method</legend>
    <label class="check"><input type="radio" name="method" value="payid" checked> PayID or bank transfer</label>
    <label class="check"><input type="radio" name="method" value="cash"> Cash</label>
  </fieldset>
  <label>Reference (optional), e.g. the bank’s transaction ID<input name="reference" maxlength="${MAX_PAYMENT_REFERENCE}" autocomplete="off"></label>
  <p class="small">Part payments are fine. Card payments come in from Stripe by themselves.</p>
  <button type="submit">Record payment</button>
</form></details>`
    : ''
}`;
}

export function batchPage(ctx: PageContext, b: Batch, today: string, flash?: Flash, emails: BatchEmail[] = [], pays?: BatchPayments): string {
  const charged = b.paddleCount - b.unchangedCount;
  return layout(
    ctx,
    b.reference,
    html`<p><a href="/admin/clubs/${b.clubId}">← ${b.clubName}</a> · <a href="/admin/batches">Open batches</a></p>
${flashBox(flash)}
<h1><span class="ref">${b.reference}</span> ${batchBadge(b.status)}${overdueBadge(b, today)}</h1>
<dl class="facts">
  <dt>Club</dt><dd><a href="/admin/clubs/${b.clubId}">${b.clubName}</a></dd>
  <dt>Collected</dt><dd>${calendarDay(b.collectedOn)}: ${b.paddleCount} ${b.paddleCount === 1 ? 'paddle' : 'paddles'}</dd>
  ${b.returnedOn ? html`<dt>Returned</dt><dd>${calendarDay(b.returnedOn)}${b.unchangedCount ? `: ${b.unchangedCount} unchanged (not charged), ${charged} re-gritted` : ''}</dd>` : ''}
  ${b.invoice ? html`<dt>Invoice</dt><dd><a href="/admin/documents/${b.invoice.number}">${b.invoice.number}</a>, ${dollars(b.invoice.totalCents)}${b.invoice.dueOn ? `, due ${documentDate(b.invoice.dueOn)}` : ''}</dd>` : ''}
</dl>
${
  b.status === 'collected'
    ? html`<details class="action" open><summary>Mark returned and invoice the club</summary>
<form method="post" action="/admin/batches/${b.reference}/return">
  ${csrfField(ctx)}
  <label>Returned on<input type="date" name="returnedOn" required min="${b.collectedOn}" max="${today}" value="${today}"></label>
  <label>Paddles returned unchanged (unsuitable, not charged)<input name="unchangedCount" required inputmode="numeric" pattern="\\d{1,3}" value="0"></label>
  <p class="small">This issues the invoice for the paddles re-gritted, at the club price on today’s terms, and emails it to the club’s billing contact. An invoice can’t be edited afterwards: a mistake needs a credit note.</p>
  <button type="submit">Return and invoice</button>
</form></details>
<form method="post" action="/admin/batches/${b.reference}/cancel">
  ${csrfField(ctx)}
  <button type="submit" class="danger">Cancel this batch</button>
</form>
<p class="small">Cancel only a batch that won’t be returned through us (recorded by mistake, say). Nothing is invoiced.</p>`
    : b.status === 'returned'
      ? html`<p class="small">Every paddle came back unchanged, so there was nothing to invoice.</p>`
      : ''
}
${pays ? paymentsSection(ctx, b, pays, today) : ''}
${emailsSection(ctx, emails)}
<form method="post" action="/admin/batches/${b.reference}/notes">
  ${csrfField(ctx)}
  <label>Notes (only you see them)<textarea name="notes" maxlength="${MAX_CLUB_NOTE}" rows="3">${b.notes ?? ''}</textarea></label>
  <button type="submit" class="secondary">Save notes</button>
</form>`,
  );
}
