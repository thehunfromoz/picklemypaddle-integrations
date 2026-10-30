/**
 * The admin's retention pages (SCRUM-75): what the daily job will delete soon, extensions, the
 * job's recent runs, erasures, and "Erase customer" with its confirmation step.
 */
import { sydneyDate } from '../orders/dates.js';
import { DELETED_CATEGORIES, type ErasurePlan, type ErasureResult } from '../orders/erasure.js';
import { addDays, addMonths, dueDates, HEADS_UP_DAYS, isExtended, RULES, type Rule, type Upcoming } from '../orders/retention.js';
import { ADMIN_LABELS, type OrderDetail } from './data.js';
import { calendarDay, dollars, html, type Html, when } from './html.js';
import { layout, type Flash, type PageContext } from './pages.js';

const csrfField = (ctx: PageContext) => html`<input type="hidden" name="_csrf" value="${ctx.admin.csrf}">`;
const flashBox = (flash?: Flash) =>
  flash ? html`<p class="flash ${flash.kind}" role="${flash.kind === 'error' ? 'alert' : 'status'}">${flash.text}</p>` : '';

export interface RetentionPageData {
  upcoming: Upcoming[];
  extensions: { reference: string; until: string; reason: string }[];
  runs: { at: Date; counts: Record<string, number> }[];
  erasures: { at: Date; orders_deleted: number; orders_minimised: number; categories: string; crm: string }[];
}

export function retentionPage(ctx: PageContext, d: RetentionPageData, flash?: Flash): string {
  const byRule = (rule: Rule) => d.upcoming.filter((u) => u.rule === rule);
  return layout(
    ctx,
    'Retention',
    html`<p><a href="/admin/orders">← Orders</a></p>
${flashBox(flash)}
<h1>Retention</h1>
<p class="small">The daily job deletes what the privacy policy says it will. Extend an order from its own page to hold it back.</p>

<h2>Due for deletion in the next ${HEADS_UP_DAYS} days</h2>
${(Object.keys(RULES) as Rule[]).map((rule) => {
  const list = byRule(rule);
  return html`<h3>${RULES[rule].label} <span class="small">(${list.length}; deletes ${RULES[rule].what})</span></h3>
${
  list.length
    ? html`<ul class="orders">${list.map(
        (u) => html`<li><a href="/admin/orders/${u.reference}"><span><span class="ref">${u.reference}</span>${u.isTest ? html` <span class="badge test">TEST</span>` : ''}${
          u.erased ? html` <span class="badge">Erased</span>` : ''
        }</span><span class="badge ${u.due <= sydneyDate(ctx.now) ? 'overdue' : 'due'}">${calendarDay(u.due)}</span></a></li>`,
      )}</ul>`
    : html`<p class="empty">Nothing due.</p>`
}`;
})}

<h2>Extensions in force</h2>
${
  d.extensions.length
    ? html`<ul class="notes">${d.extensions.map(
        (e) => html`<li><a href="/admin/orders/${e.reference}">${e.reference}</a> kept until ${calendarDay(e.until)}<div class="pre small">${e.reason}</div></li>`,
      )}</ul>`
    : html`<p class="empty">None.</p>`
}

<h2>Erase a customer</h2>
<p><a href="/admin/erase">Erase a customer’s data on request →</a></p>

<h2>Recent runs</h2>
${
  d.runs.length
    ? html`<ul class="notes">${d.runs.map(
        (r) => html`<li>${when(r.at)}: photos ${r.counts.photos ?? 0} · orders that never went ahead ${r.counts.enquiries ?? 0} · paid orders ${r.counts.paid ?? 0}${
          r.counts.waiting ? html` · <strong>waiting on HubSpot ${r.counts.waiting}</strong>` : ''
        }</li>`,
      )}</ul>`
    : html`<p class="empty">The job hasn’t run yet.</p>`
}

<h2>Erasures</h2>
${
  d.erasures.length
    ? html`<ul class="notes">${d.erasures.map(
        (e) => html`<li>${when(e.at)}: ${e.orders_deleted} deleted, ${e.orders_minimised} kept as tax records · HubSpot ${e.crm}<div class="small">${e.categories}</div></li>`,
      )}</ul>`
    : html`<p class="empty">None yet.</p>`
}`,
  );
}

// ── On the order page ─────────────────────────────────────────────────────────

const RULE_PHRASE: Record<Rule, string> = {
  photos: 'Photos deleted',
  enquiries: 'Order deleted',
  paid: 'Order deleted (end of the 5-year tax record)',
};

export function orderRetentionSection(ctx: PageContext, o: OrderDetail): Html {
  const today = sydneyDate(ctx.now);
  const hasPhotos = o.paddles.some((p) => p.photos.length > 0);
  const due = dueDates({ status: o.status, statusChangedAt: o.statusChangedAt, everPaid: o.everPaid, hasPhotos, retainUntil: o.retainUntil });
  const extended = isExtended({ retainUntil: o.retainUntil }, today);
  const lines = (Object.keys(due) as Rule[]).map((r) => html`<li>${RULE_PHRASE[r]} on ${calendarDay(due[r]!)}</li>`);
  const defaultUntil = o.retainUntil && o.retainUntil > today ? o.retainUntil : addMonths(today, 3);
  return html`<h2>Retention</h2>
${o.erasedAt ? html`<p class="flash warn">Erased on request on ${when(o.erasedAt)}: only the tax record is kept${o.amountCents !== null ? html` (${dollars(o.amountCents)})` : ''}.</p>` : ''}
${lines.length ? html`<ul>${lines}</ul>` : html`<p class="empty">Nothing is scheduled while the order is open.</p>`}
${
  extended
    ? html`<p class="flash warn">Held back until ${calendarDay(o.retainUntil!)}: ${o.retainReason}</p>
<form class="inline" method="post" action="/admin/orders/${o.reference}/retention">${csrfField(ctx)}<input type="hidden" name="action" value="clear"><button type="submit" class="secondary">Remove the extension</button></form>`
    : ''
}
<details class="action"><summary>${extended ? 'Change the extension' : 'Keep it longer'}</summary>
<form method="post" action="/admin/orders/${o.reference}/retention">
  ${csrfField(ctx)}
  <input type="hidden" name="action" value="extend">
  <label>Keep until<input type="date" name="until" required min="${addDays(today, 1)}" max="${addMonths(today, 60)}" value="${defaultUntil}"></label>
  <label>Reason (required, for example a dispute)<textarea name="reason" required maxlength="500"></textarea></label>
  <p class="small">Every retention rule waits until after this date, then applies again.</p>
  <button type="submit">Save the extension</button>
</form></details>`;
}

// ── Erase customer (AC7) ──────────────────────────────────────────────────────

export function erasePage(ctx: PageContext, flash?: Flash, email = ''): string {
  return layout(
    ctx,
    'Erase a customer',
    html`<p><a href="/admin/retention">← Retention</a></p>
${flashBox(flash)}
<h1>Erase a customer</h1>
<p>For a customer who asked us to delete their data. Enter the email address their orders use. Nothing changes until you confirm on the next page.</p>
<form method="post" action="/admin/erase/preview">
  ${csrfField(ctx)}
  <label>Email address<input type="email" name="email" required autocomplete="off" value="${email}"></label>
  <button type="submit">Show what would be erased</button>
</form>`,
  );
}

export function erasePreviewPage(ctx: PageContext, plan: ErasurePlan, hasCrm: boolean, flash?: Flash): string {
  const deletes = plan.orders.filter((o) => o.action === 'delete');
  const keeps = plan.orders.filter((o) => o.action === 'minimise');
  const row = (o: ErasurePlan['orders'][number]) =>
    html`<li><a href="/admin/orders/${o.reference}">${o.reference}</a> · ${ADMIN_LABELS[o.status]} · placed ${when(o.createdAt)}${
      o.keptUntil ? html` · tax record kept until ${calendarDay(o.keptUntil)}` : ''
    }</li>`;
  return layout(
    ctx,
    'Confirm erasure',
    html`<p><a href="/admin/erase">← Back</a></p>
${flashBox(flash)}
<h1>Erase ${plan.email}?</h1>
${
  plan.orders.length === 0
    ? html`<p class="empty">There are no orders for that address.</p>`
    : html`
${plan.open.length ? html`<p class="flash error">Still open: ${plan.open.join(', ')}. Finish or withdraw ${plan.open.length === 1 ? 'it' : 'them'} first; erasing now would lose the return address.</p>` : ''}
<h2>Deleted entirely (${deletes.length})</h2>
${deletes.length ? html`<ul>${deletes.map(row)}</ul>` : html`<p class="empty">None.</p>`}
<h2>Kept as a tax record only (${keeps.length})</h2>
${
  keeps.length
    ? html`<p class="small">Paid orders inside their 5 years: only the reference, name, dates, statuses and amount stay; the rest goes now. The daily job deletes the record when its 5 years are up.</p><ul>${keeps.map(row)}</ul>`
    : html`<p class="empty">None.</p>`
}
<h2>What goes</h2>
<p>${DELETED_CATEGORIES.filter((c) => c !== 'HubSpot contact').join(', ')}${hasCrm ? ', and the HubSpot contact (a permanent GDPR delete) and these orders’ deals (deleted, or stripped to reference and amount).' : '. (HubSpot isn’t configured here.)'}</p>
<p>Status links stop working at once. This can’t be undone. Gmail and Resend are separate: see the deletion runbook.</p>
${
  plan.open.length
    ? ''
    : html`<form method="post" action="/admin/erase/confirm">
  ${csrfField(ctx)}
  <input type="hidden" name="email" value="${plan.email}">
  <input type="hidden" name="fingerprint" value="${plan.fingerprint}">
  <label><span><input type="checkbox" name="confirm" value="erase" required> I want to erase this customer’s data now</span></label>
  <button type="submit" class="danger">Erase now</button>
</form>`
}`
}`,
  );
}

export function eraseDonePage(ctx: PageContext, r: ErasureResult): string {
  return layout(
    ctx,
    'Erased',
    html`<p><a href="/admin/retention">← Retention</a></p>
<p class="flash done" role="status">Erased: ${r.deleted} order${r.deleted === 1 ? '' : 's'} deleted, ${r.minimised} kept as tax record${r.minimised === 1 ? '' : 's'}. HubSpot: ${r.crm}.</p>
<p>Recorded in the erasure log (no personal details). Next: the customer’s mail in Gmail and Resend, as the deletion runbook says.</p>`,
  );
}
