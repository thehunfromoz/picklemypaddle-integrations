/**
 * The admin's club pages (SCRUM-85): clubs and their billing details, each club's batches, and a
 * batch's page, where it is invoiced, paid, returned or cancelled.
 */
import { BATCH_STATUS_LABELS, effectiveFulfilment, FREE_RETURN_POST_MIN, isOverdue, MAX_BATCH_PADDLES, MAX_TRACKING, MAX_CLUB_NOTE, type Batch, type BatchEmail, type BatchStatus, type Club, type ClubStatus } from '../clubs/clubs.js';
import type { AgreementVersion } from '../clubs/agreement-versions.js';
import { MAX_ACCEPTED_BY, MAX_ACCEPTED_NOTE, type ClubAgreement } from '../clubs/agreements.js';
import { MOVES } from '../clubs/leads.js';
import { FULFILMENT_LABELS } from '../clubs/service-area.js';
import { meetingText, STATUS_LABELS } from '../clubs/model.js';
import { CLUB_PROBLEMS, MAX_PAYMENT_REFERENCE, METHOD_LABELS, type ClubPayment } from '../clubs/payments.js';
import { PROBLEM_TEXT } from '../payments/payments.js';
import { documentDate } from '../documents/documents.js';
import { sydneyDate } from '../orders/dates.js';
import { calendarDay, dollars, html, type Html, when } from './html.js';
import { layout, type Flash, type PageContext } from './pages.js';

const csrfField = (ctx: PageContext) => html`<input type="hidden" name="_csrf" value="${ctx.admin.csrf}">`;
const flashBox = (flash?: Flash) =>
  flash ? html`<p class="flash ${flash.kind}" role="${flash.kind === 'error' ? 'alert' : 'status'}">${flash.text}</p>` : '';
const testBadge = (isTest: boolean) => (isTest ? html` <span class="badge test">TEST</span>` : '');
const clubBadge = (c: Club) => html`<span class="badge${c.status === 'lead' || c.status === 'meeting' || c.status === 'agreement_sent' ? ' due' : ''}">${STATUS_LABELS[c.status]}</span>`;
const isCustomer = (c: Club) => c.status === 'active' || c.status === 'inactive';

const BATCH_BADGE: Record<BatchStatus, string> = { collected: 'due', returned: '', invoiced: 'due', paid: '', cancelled: '' };
/** A paid batch that hasn't gone back yet is still the admin's to do (SCRUM-102: the club pays before its batch is returned). */
const toReturn = (b: Pick<Batch, 'status' | 'returnedOn'>) => b.status === 'paid' && !b.returnedOn;
const batchBadge = (b: Pick<Batch, 'status' | 'returnedOn'>) =>
  toReturn(b)
    ? html`<span class="badge due">Paid: to return</span>`
    : html`<span class="badge${BATCH_BADGE[b.status] ? ` ${BATCH_BADGE[b.status]}` : ''}">${BATCH_STATUS_LABELS[b.status]}</span>`;
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

const returnTrackingField = (b: Batch): Html | string =>
  b.method === 'post' ? html`<label>Tracking number for the box back (optional)<input name="returnTracking" maxlength="${MAX_TRACKING}" autocomplete="off"></label>` : '';

function batchRows(batches: Batch[], withClub: boolean, today: string): Html {
  return html`<table class="list">
<thead><tr><th scope="col">Batch</th>${withClub ? html`<th scope="col">Club</th>` : ''}<th scope="col">Collected</th><th scope="col" class="num">Paddles</th><th scope="col">Status</th><th scope="col">Invoice</th><th scope="col" class="num">Owing</th></tr></thead>
<tbody>${batches.map(
    (b) => html`<tr><td><a href="/admin/batches/${b.reference}"><span class="ref">${b.reference}</span></a></td>${
      withClub ? html`<td><a href="/admin/clubs/${b.clubId}">${b.clubName}</a></td>` : ''
    }<td>${calendarDay(b.collectedOn)}</td><td class="num">${b.paddleCount}</td><td>${batchBadge(b)}${overdueBadge(b, today)}</td><td>${
      b.invoice ? html`<a href="/admin/documents/${b.invoice.number}">${b.invoice.number}</a> ${dollars(b.invoice.totalCents)}` : '—'
    }</td><td class="num">${b.invoice && b.invoice.balanceCents > 0 ? dollars(b.invoice.balanceCents) : '—'}</td></tr>`,
  )}</tbody></table>`;
}

export function clubsPage(ctx: PageContext, clubs: (Club & { openBatches: number })[], flash?: Flash, form?: Partial<Club>): string {
  const leads = clubs.filter((c) => !isCustomer(c));
  const customers = clubs.filter(isCustomer);
  return layout(
    ctx,
    'Clubs',
    html`<p><a href="/admin/orders">← Orders</a> · <a href="/admin/batches">Open batches</a></p>
${flashBox(flash)}
<h1>Clubs</h1>
<p class="small">Clubs keep their members’ details: only the club’s name and billing details are held here. Clubs never get discount codes.</p>
<h2>Leads and pipeline</h2>
${
  leads.length
    ? html`<ul class="orders">${leads.map(
        (c) => html`<li><a href="/admin/clubs/${c.id}"><span><span class="ref">${c.name}</span>${testBadge(c.isTest)} <span class="small">${c.contactName ?? '—'}${c.suburb ? ` · ${c.suburb}` : ''}${
          c.meetingOn ? ` · meeting ${meetingText(c)}` : ''
        } · asked ${when(c.createdAt)}</span></span>${clubBadge(c)}</a></li>`,
      )}</ul>`
    : html`<p class="empty">No leads yet. Clubs ask from the “Talk to us about your club” form on the Clubs page.</p>`
}
<h2>Clubs</h2>
${
  customers.length
    ? html`<ul class="orders">${customers.map(
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

const FORWARD: Partial<Record<ClubStatus, ClubStatus>> = { lead: 'meeting', meeting: 'agreement_sent', agreement_sent: 'active' };
const moveLabel = (from: ClubStatus, to: ClubStatus): string =>
  to === 'inactive' ? 'Not going ahead (Inactive)' : from === 'inactive' ? 'Reopen as a lead' : FORWARD[from] === to ? `Move to ${STATUS_LABELS[to]}` : `Back to ${STATUS_LABELS[to]}`;

/** How the club's batches travel (SCRUM-102): the service area's default, and the admin's override. */
function fulfilmentSection(ctx: PageContext, club: Club): Html {
  const eff = effectiveFulfilment(club);
  return html`<h2>Pickup or post</h2>
<p>Now: <strong>${eff ? FULFILMENT_LABELS[eff] : 'not set'}</strong>${club.fulfilmentOverride ? html` (your override${club.fulfilmentOverrideAt ? `, ${calendarDay(sydneyDate(club.fulfilmentOverrideAt))}` : ''})` : club.fulfilmentDefault ? ' (from the service area)' : ''}.</p>
${club.fulfilmentDefault ? html`<p class="small">The service area (list ${club.areaVersion ?? '—'}) gave ${FULFILMENT_LABELS[club.fulfilmentDefault]} for ${club.suburb ?? '—'} ${club.venuePostcode ?? ''}.</p>` : html`<p class="small">This club has no venue on file, so the service area hasn’t been used. Choose below.</p>`}
${club.areaReview ? html`<p class="flash error" role="note">The suburb is on our list but with a different postcode. Several NSW suburb names exist in more than one place: check the venue.</p>` : ''}
<form method="post" action="/admin/clubs/${club.id}/fulfilment" class="inline">
  ${csrfField(ctx)}
  <label>Method
    <select name="fulfilment">
      <option value=""${club.fulfilmentOverride ? '' : html` selected`}>Use the service area’s default</option>
      <option value="local"${club.fulfilmentOverride === 'local' ? html` selected` : ''}>Local pickup and drop-off</option>
      <option value="postal"${club.fulfilmentOverride === 'postal' ? html` selected` : ''}>Post</option>
    </select>
  </label>
  <button type="submit" class="secondary">Save</button>
</form>`;
}

/** A lead's details, its meeting date and the moves along the pipeline (SCRUM-93). */
function pipelineSection(ctx: PageContext, club: Club): Html | string {
  const open = club.status === 'lead' || club.status === 'meeting' || club.status === 'agreement_sent';
  const moves = MOVES[club.status].filter((s) => !(isCustomer(club) && s === 'active'));
  const asked = club.suburb || club.contactName || club.leadMessage || club.memberCount !== null;
  return html`${
    asked
      ? html`<h2>The enquiry</h2><dl class="facts">
  <dt>Contact</dt><dd>${club.contactName ?? '—'}${club.contactEmail ? html`, <a href="mailto:${club.contactEmail}">${club.contactEmail}</a>` : ''}${club.contactPhone ? `, ${club.contactPhone}` : ''}</dd>
  <dt>Venue suburb</dt><dd>${club.suburb ?? '—'}${club.venuePostcode ? ` ${club.venuePostcode}` : ''}</dd>
  <dt>Rough size</dt><dd>${club.memberCount !== null ? `about ${club.memberCount} members play` : '—'}</dd>
  <dt>Preferred times</dt><dd>${club.preferredTimes ?? '—'}</dd>
  <dt>Message</dt><dd>${club.leadMessage ?? '—'}</dd>
</dl>`
      : ''
  }
${
  open
    ? html`<h2>Pipeline</h2>
<p>Now: <strong>${STATUS_LABELS[club.status]}</strong>${club.meetingOn ? html`, meeting <strong>${meetingText(club)}</strong>` : ''}.</p>
<form method="post" action="/admin/clubs/${club.id}/meeting" class="inline">
  ${csrfField(ctx)}
  <label>Meeting date<input type="date" name="meetingOn" value="${club.meetingOn ?? ''}"></label>
  <label>Time (optional, Sydney)<input type="time" name="meetingTime" value="${club.meetingTime ?? ''}"></label>
  <label>Length in minutes (optional)<input name="meetingMinutes" inputmode="numeric" pattern="\\d{1,3}" value="${club.meetingMinutes ?? ''}"></label>
  <button type="submit" class="secondary">Save meeting</button>
</form>
<p class="small">Set the date first and add the time and length later. The meeting shows on the club’s company in HubSpot (“Club meeting”). Clearing the date clears all three.</p>`
    : ''
}
${
  open || club.status === 'inactive'
    ? html`<div class="actions">${moves
        .filter((s) => club.status !== 'inactive' || s === 'lead')
        .map(
          (s) => html`<form method="post" action="/admin/clubs/${club.id}/stage" class="inline">${csrfField(ctx)}<input type="hidden" name="to" value="${s}"><button type="submit"${
            s === 'inactive' ? html` class="danger"` : html` class="secondary"`
          }>${moveLabel(club.status, s)}</button></form>`,
        )}</div>`
    : ''
}`;
}

/** The club agreement: send the live version, and record the reply (SCRUM-94). */
function agreementSection(ctx: PageContext, club: Club, agreements: ClubAgreement[], live: AgreementVersion | null, today: string): Html | string {
  const canSend = club.status === 'meeting' || club.status === 'agreement_sent' || club.status === 'active';
  if (!canSend && agreements.length === 0) return '';
  const waiting = agreements.filter((a) => !a.acceptedOn);
  const sendable = live && !agreements.some((a) => a.version === live.version && a.acceptedOn);
  return html`<h2>Agreement</h2>
${
  agreements.length
    ? html`<table class="list"><thead><tr><th scope="col">Version</th><th scope="col">Sent</th><th scope="col">To</th><th scope="col">Accepted</th></tr></thead><tbody>${agreements.map(
        (a) => html`<tr><td>${a.label}</td><td>${when(a.sentAt)}</td><td>${a.sentTo}</td><td>${
          a.acceptedOn ? html`${calendarDay(a.acceptedOn)}, ${a.acceptedBy}${a.acceptedNote ? html` <span class="small">(${a.acceptedNote})</span>` : ''}` : 'Waiting for “I agree”'
        }</td></tr>`,
      )}</tbody></table>`
    : html`<p class="empty">Not sent yet.</p>`
}
${
  canSend && sendable
    ? html`<form method="post" action="/admin/clubs/${club.id}/agreement/send" class="inline">
  ${csrfField(ctx)}
  <button type="submit" class="secondary">${agreements.some((a) => a.version === live.version) ? `Send agreement ${live.label} again` : `Send agreement ${live.label}`}</button>
</form>
<p class="small">The email has the full text, a printable page and asks the club to reply “I agree”.${live.approvedOn ? '' : ' This version isn’t approved yet: only staging sends it.'}</p>`
    : canSend && !live
      ? html`<p class="small">There’s no approved agreement to send yet.</p>`
      : ''
}
${
  waiting.length && (club.status === 'agreement_sent' || club.status === 'active')
    ? html`<details class="action"><summary>Record an “I agree” reply</summary>
<form method="post" action="/admin/clubs/${club.id}/agreement/accept">
  ${csrfField(ctx)}
  <label>Version<select name="version">${waiting.map((a) => html`<option value="${a.version}">${a.label}</option>`)}</select></label>
  <label>Date of the reply<input type="date" name="acceptedOn" required max="${today}" value="${today}"></label>
  <label>Who replied<input name="acceptedBy" required maxlength="${MAX_ACCEPTED_BY}" autocomplete="off"></label>
  <label>Note (optional, only you see it)<textarea name="note" maxlength="${MAX_ACCEPTED_NOTE}" rows="2"></textarea></label>
  <p class="small">${club.status === 'agreement_sent' ? 'The club becomes Active (it needs its billing details first).' : 'The club stays Active.'}</p>
  <button type="submit">Record acceptance</button>
</form></details>`
    : ''
}`;
}

export function clubPage(ctx: PageContext, club: Club, batches: Batch[], today: string, flash?: Flash, form?: Partial<Club>, sync?: BatchEmail | null, agreements: ClubAgreement[] = [], live: AgreementVersion | null = null): string {
  return layout(
    ctx,
    club.name,
    html`<p><a href="/admin/clubs">← Clubs</a></p>
${flashBox(flash)}
<h1>${club.name}${testBadge(club.isTest)} ${clubBadge(club)}</h1>
<p class="small">Added ${when(club.createdAt)}. ${
  club.billingEmail ? html`Invoices go to ${club.billingName}, ${club.billingEmail}.` : html`No billing details yet: add them (Edit the club) before making it Active.`
}</p>
${crmLine(ctx, sync)}
${pipelineSection(ctx, club)}
${fulfilmentSection(ctx, club)}
${agreementSection(ctx, club, agreements, live, today)}

<h2>Batches</h2>
${batches.length ? batchRows(batches, false, today) : html`<p class="empty">No batches yet.</p>`}
${
  club.status === 'active'
    ? html`<details class="action"><summary>Record a batch received</summary>
<form method="post" action="/admin/clubs/${club.id}/batches">
  ${csrfField(ctx)}
  <label>How it reached us
    <select name="method"><option value="pickup"${effectiveFulfilment(club) === 'postal' ? '' : html` selected`}>I picked it up</option><option value="post"${effectiveFulfilment(club) === 'postal' ? html` selected` : ''}>It arrived by post</option></select>
  </label>
  <label>Received on (the day it was picked up or arrived)<input type="date" name="collectedOn" required max="${today}" value="${today}"></label>
  <label>Tracking number for the box to us (post only, optional)<input name="inboundTracking" maxlength="${MAX_TRACKING}" autocomplete="off"></label>
  <label>Number of paddles (1 to ${MAX_BATCH_PADDLES})<input name="paddleCount" required inputmode="numeric" pattern="\\d{1,3}"></label>
  <label>Notes (optional, only you see them)<textarea name="notes" maxlength="${MAX_CLUB_NOTE}" rows="2"></textarea></label>
  <button type="submit">Record batch</button>
</form></details>`
    : club.status === 'inactive'
      ? html`<p class="small">This club is inactive: reactivate it to record a new batch.</p>`
      : html`<p class="small">Batches can be recorded once the club is Active.</p>`
}

<details class="action"${form ? html` open` : ''}><summary>Edit the club’s details</summary>
<form method="post" action="/admin/clubs/${club.id}">
  ${csrfField(ctx)}
  ${clubFields(form ?? club)}
  <p class="small">Invoices already issued keep the details they were issued with.</p>
  <button type="submit">Save</button>
</form></details>

${
  isCustomer(club)
    ? html`<form method="post" action="/admin/clubs/${club.id}/active">
  ${csrfField(ctx)}
  <input type="hidden" name="active" value="${club.status === 'active' ? 'no' : 'yes'}">
  <button type="submit"${club.status === 'active' ? html` class="danger"` : ''}>${club.status === 'active' ? 'Make inactive' : 'Reactivate'}</button>
</form>
<p class="small">An inactive club keeps its batches and invoices; it just can’t have new batches.</p>`
    : ''
}`,
  );
}

export function batchesPage(ctx: PageContext, batches: Batch[], all: boolean, today: string): string {
  return layout(
    ctx,
    'Batches',
    html`<p><a href="/admin/clubs">← Clubs</a></p>
<h1>${all ? 'All batches' : 'Open batches'}</h1>
<p class="small">${all ? html`<a href="/admin/batches">Show open batches only</a>` : html`Collected, invoiced, or paid and not yet returned. <a href="/admin/batches?all=1">Show all</a>`}</p>
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
  flagged: { paymentIntentId: string | null; amountCents: number; problem: string | null; refundedCents: number; livemode: boolean }[];
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
<p>${owing > 0 ? html`Unpaid: <strong>${dollars(owing)}</strong>${b.invoice.dueOn ? `, due ${documentDate(b.invoice.dueOn)}` : ''}${overdueBadge(b, today)}` : html`<strong>Paid in full.</strong>`}</p>
${p.flagged.map(
  (f) =>
    f.problem === null
      ? html`<p class="flash error">A card payment of ${dollars(f.amountCents)}${f.paymentIntentId ? ` (Stripe ${f.paymentIntentId})` : ''} was refunded in Stripe (${dollars(f.refundedCents)}), but the invoice still counts it as paid. Check the balance by hand: what a refund does to the invoice isn’t built yet.</p>`
      : html`<p class="flash error">A card payment of ${dollars(f.amountCents)}${f.paymentIntentId ? ` (Stripe ${f.paymentIntentId})` : ''} wasn’t applied: ${problemWords(f.problem)}.${
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
  <p class="small">Payment is in full: the amount must match the invoice. Card payments come in from Stripe by themselves.</p>
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
<h1><span class="ref">${b.reference}</span> ${batchBadge(b)}${overdueBadge(b, today)}</h1>
<dl class="facts">
  <dt>Club</dt><dd><a href="/admin/clubs/${b.clubId}">${b.clubName}</a></dd>
  <dt>${b.method === 'post' ? 'Received by post' : 'Picked up'}</dt><dd>${calendarDay(b.collectedOn)}: ${b.paddleCount} ${b.paddleCount === 1 ? 'paddle' : 'paddles'}</dd>
  ${b.inboundTracking ? html`<dt>Tracking to us</dt><dd>${b.inboundTracking}</dd>` : ''}
  ${b.returnTracking ? html`<dt>Tracking back to the club</dt><dd>${b.returnTracking}</dd>` : ''}
  ${b.returnedOn ? html`<dt>Returned</dt><dd>${calendarDay(b.returnedOn)}</dd>` : ''}
  ${b.unchangedCount ? html`<dt>Unchanged</dt><dd>${b.unchangedCount} not re-gritted (not charged), ${charged} re-gritted</dd>` : ''}
  ${b.invoice ? html`<dt>Invoice</dt><dd><a href="/admin/documents/${b.invoice.number}">${b.invoice.number}</a>, ${dollars(b.invoice.totalCents)}${b.invoice.dueOn ? `, due ${documentDate(b.invoice.dueOn)}` : ', due before the batch goes back'}</dd>` : ''}
</dl>
${
  b.status === 'collected'
    ? html`<details class="action" open><summary>Re-gritted: invoice the club</summary>
<form method="post" action="/admin/batches/${b.reference}/invoice">
  ${csrfField(ctx)}
  <label>Paddles that can’t be re-gritted (unsuitable, returned unchanged, not charged)<input name="unchangedCount" required inputmode="numeric" pattern="\\d{1,3}" value="0"></label>
  ${
    b.method === 'post' && b.paddleCount >= FREE_RETURN_POST_MIN
      ? html`<label>Return postage allowance, A$ (leave empty for the standard cost)<input name="postageAllowance" inputmode="decimal" pattern="\\d{1,3}(\\.\\d{1,2})?" autocomplete="off"></label>
  <p class="small">${b.paddleCount} paddles is ${FREE_RETURN_POST_MIN} or more, so agreement 5.3 takes the standard cost of the postage off the invoice, as its own line. Left empty, it is Australia Post’s price to the club’s venue postcode today; if that can’t be worked out, enter it.</p>`
      : b.method === 'post'
        ? html`<p class="small">Fewer than ${FREE_RETURN_POST_MIN} paddles: no postage is taken off the invoice (agreement 5.3).</p>`
        : ''
  }
  <p class="small">This issues the invoice for the paddles re-gritted, at the club price on today’s terms, and emails it to the club’s billing contact. The club pays before the batch goes back (agreement 7.3). An invoice can’t be edited afterwards: a mistake needs a credit note.</p>
  <button type="submit">Invoice the club</button>
</form></details>
<details class="action"><summary>Every paddle came back unchanged: return with no invoice</summary>
<form method="post" action="/admin/batches/${b.reference}/return">
  ${csrfField(ctx)}
  <input type="hidden" name="unchangedCount" value="${b.paddleCount}">
  <label>Returned on<input type="date" name="returnedOn" required min="${b.collectedOn}" max="${today}" value="${today}"></label>
  ${returnTrackingField(b)}
  <button type="submit" class="secondary">Return, nothing to invoice</button>
</form></details>
<form method="post" action="/admin/batches/${b.reference}/cancel">
  ${csrfField(ctx)}
  <button type="submit" class="danger">Cancel this batch</button>
</form>
<p class="small">Cancel only a batch that won’t be returned through us (recorded by mistake, say). Nothing is invoiced.</p>`
    : b.status === 'invoiced'
      ? html`<p class="small">Waiting for payment: the club pays before the batch goes back (agreement 7.3). Record the payment below, or the club can pay by card from its invoice page.</p>`
      : toReturn(b)
        ? html`<details class="action" open><summary>Paid: mark returned</summary>
<form method="post" action="/admin/batches/${b.reference}/return">
  ${csrfField(ctx)}
  <label>Returned on (dropped off or posted)<input type="date" name="returnedOn" required min="${b.collectedOn}" max="${today}" value="${today}"></label>
  ${returnTrackingField(b)}
  <button type="submit">Mark returned</button>
</form></details>`
        : b.status === 'returned' && !b.invoice
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
