/**
 * The admin's discount-code pages (SCRUM-63): the codes, a form to create one (typed, or a random
 * one-person code), a one-click "free re-grit for one person", deactivate/reactivate, and each
 * code's uses by order reference only.
 */
import { CODE_STATES, MAX_BATCH, MAX_CODE_NOTE, stateOf, type CodeState, type CodeUse, type DiscountCode } from '../orders/discounts.js';
import { describeDiscount } from '../orders/rules.js';
import { calendarDay, html, type Html, when } from './html.js';
import { layout, type Flash, type PageContext } from './pages.js';

const csrfField = (ctx: PageContext) => html`<input type="hidden" name="_csrf" value="${ctx.admin.csrf}">`;
const flashBox = (flash?: Flash) =>
  flash ? html`<p class="flash ${flash.kind}" role="${flash.kind === 'error' ? 'alert' : 'status'}">${flash.text}</p>` : '';

const STATE_LABELS: Record<CodeState, string> = { active: 'Active', used_up: 'Used up', expired: 'Expired', inactive: 'Inactive' };
const STATE_BADGE: Record<CodeState, string> = { active: '', used_up: 'due', expired: 'overdue', inactive: '' };
const state = (c: DiscountCode, today: string): Html => {
  const s = stateOf(c, today);
  return html`<span class="badge${STATE_BADGE[s] ? ` ${STATE_BADGE[s]}` : ''}">${STATE_LABELS[s]}</span>`;
};

const facts = (c: DiscountCode) =>
  html`${describeDiscount(c)} · ${c.used} of ${c.maxUses} used${c.expiresOn ? ` · until ${calendarDay(c.expiresOn)}` : ''}${
    c.onePerEmail && c.maxUses > 1 ? ' · once per email' : ''
  }`;

export interface CodesFilter {
  prefix: string;
  state: CodeState | '';
}

export function codesPage(
  ctx: PageContext,
  codes: DiscountCode[],
  today: string,
  filter: CodesFilter,
  prefixes: string[],
  flash?: Flash,
): string {
  const opt = (value: string, label: string, current: string) => html`<option value="${value}"${value === current ? html` selected` : ''}>${label}</option>`;
  return layout(
    ctx,
    'Discount codes',
    html`<p><a href="/admin/orders">← Orders</a></p>
${flashBox(flash)}
<h1>Discount codes</h1>
<p class="small">Direct orders only. A code always comes off the re-grit, never off return postage. A use is held when the order is placed, used up when it’s paid, and given back if the order is rejected, withdrawn or lapses unpaid.</p>

<details class="action" open><summary>Create codes</summary>
<form method="post" action="/admin/codes">
  ${csrfField(ctx)}
  <fieldset><legend>Kind of code</legend>
    <label class="check"><input type="radio" name="mode" value="personal" checked> One per person: unique codes, each used once</label>
    <label class="check"><input type="radio" name="mode" value="shared"> Shared: one code, used by many people</label>
  </fieldset>
  <label>Prefix (letters and digits, up to 20)
    <input name="prefix" required maxlength="20" pattern="[A-Za-z0-9]{1,20}" autocomplete="off" autocapitalize="characters"></label>
  <p class="small">One per person: <strong>PREFIX-XXXXXXXX</strong> (8 random characters added), one use each, once per email. Shared: the code is <strong>exactly the prefix</strong> (at least 3 characters).</p>
  <label>How many codes (one per person only; 1 to ${MAX_BATCH})
    <input name="count" inputmode="numeric" pattern="\\d{1,3}" value="1"></label>
  <label>What it gives
    <select name="kind" required>
      <option value="free">Free re-grit for up to N paddles</option>
      <option value="amount">A$ off the re-grit</option>
      <option value="percent">% off the re-grit</option>
    </select></label>
  <label>How much: paddles (free re-grit), dollars (A$ off) or per cent (% off)
    <input name="value" required inputmode="decimal" pattern="\\d{1,5}(\\.\\d{1,2})?"></label>
  <label>Total uses (shared only; one-per-person codes are always 1)
    <input name="maxUses" inputmode="numeric" pattern="\\d{1,5}" value="10"></label>
  <label class="check"><input type="checkbox" name="onePerEmail" value="yes" checked> Once per email (shared only; one-per-person codes always are)</label>
  <label>Last day valid (optional)<input type="date" name="expiresOn" min="${today}"></label>
  <label>Note (optional, only you see it), e.g. “Launch offer”<input name="note" maxlength="${MAX_CODE_NOTE}"></label>
  <button type="submit">Create codes</button>
</form></details>

<h2>Codes <span class="small">(${codes.length})</span></h2>
<form class="inline" method="get" action="/admin/codes">
  <label>Prefix <select name="prefix">${opt('', 'All', filter.prefix)}${prefixes.map((p) => opt(p, p, filter.prefix))}</select></label>
  <label>State <select name="state">${opt('', 'All', filter.state)}${CODE_STATES.map((s) => opt(s, STATE_LABELS[s], filter.state))}</select></label>
  <button type="submit" class="secondary">Show</button>
</form>
${
  codes.length
    ? html`<ul class="orders">${codes.map(
        (c) => html`<li><a href="/admin/codes/${c.id}"><span><span class="ref">${c.code}</span> <span class="small">${facts(c)}${
          c.note ? html` · ${c.note}` : ''
        }</span></span>${state(c, today)}</a></li>`,
      )}</ul>`
    : html`<p class="empty">No codes${filter.prefix || filter.state ? ' match' : ' yet'}.</p>`
}`,
  );
}

const USE_LABELS: Record<CodeUse['state'], string> = { reserved: 'Held (not paid yet)', consumed: 'Used (paid)', released: 'Given back' };

export function codePage(ctx: PageContext, c: DiscountCode, uses: CodeUse[], today: string, flash?: Flash): string {
  return layout(
    ctx,
    c.code,
    html`<p><a href="/admin/codes">← Discount codes</a></p>
${flashBox(flash)}
<h1><span class="ref">${c.code}</span> ${state(c, today)}</h1>
<p>${facts(c)}</p>
<p class="small">Created ${when(c.createdAt)}</p>
<form method="post" action="/admin/codes/${c.id}/note">
  ${csrfField(ctx)}
  <label>Note (only you see it), e.g. who it was sent to<input name="note" maxlength="${MAX_CODE_NOTE}" value="${c.note ?? ''}"></label>
  <button type="submit" class="secondary">Save note</button>
</form>
<form method="post" action="/admin/codes/${c.id}/active">
  ${csrfField(ctx)}
  <input type="hidden" name="active" value="${c.active ? 'no' : 'yes'}">
  <button type="submit"${c.active ? html` class="danger"` : ''}>${c.active ? 'Deactivate' : 'Reactivate'}</button>
</form>
<p class="small">Deactivating stops new orders using it. Orders already placed with it keep their discount.</p>

<h2>Uses</h2>
${
  uses.length
    ? html`<ul class="orders">${uses.map(
        (u) => html`<li>${
          u.orderExists ? html`<a href="/admin/orders/${u.reference}"><span class="ref">${u.reference}</span></a>` : html`<span class="ref">${u.reference}</span> <span class="small">(order deleted)</span>`
        } <span class="badge">${USE_LABELS[u.state]}</span> <span class="small">${when(u.reservedAt)}</span></li>`,
      )}</ul>`
    : html`<p class="empty">Not used yet.</p>`
}`,
  );
}
