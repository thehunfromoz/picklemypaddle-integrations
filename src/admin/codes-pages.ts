/**
 * The admin's discount-code pages (SCRUM-63): the codes, a form to create one (typed, or a random
 * one-person code), a one-click "free re-grit for one person", deactivate/reactivate, and each
 * code's uses by order reference only.
 */
import { GENERATED_PREFIX, MAX_BATCH, MAX_CODE_NOTE, type CodeUse, type DiscountCode } from '../orders/discounts.js';
import { describeDiscount } from '../orders/rules.js';
import { calendarDay, html, type Html, when } from './html.js';
import { layout, type Flash, type PageContext } from './pages.js';

const csrfField = (ctx: PageContext) => html`<input type="hidden" name="_csrf" value="${ctx.admin.csrf}">`;
const flashBox = (flash?: Flash) =>
  flash ? html`<p class="flash ${flash.kind}" role="${flash.kind === 'error' ? 'alert' : 'status'}">${flash.text}</p>` : '';

function state(c: DiscountCode, today: string): Html {
  if (!c.active) return html`<span class="badge">Inactive</span>`;
  if (c.expiresOn !== null && today > c.expiresOn) return html`<span class="badge overdue">Expired</span>`;
  if (c.used >= c.maxUses) return html`<span class="badge due">Used up</span>`;
  return html`<span class="badge">Active</span>`;
}

const facts = (c: DiscountCode) =>
  html`${describeDiscount(c)} · ${c.used} of ${c.maxUses} used${c.expiresOn ? ` · until ${calendarDay(c.expiresOn)}` : ''}${
    c.onePerEmail ? ' · once per email' : ''
  }`;

export function codesPage(ctx: PageContext, codes: DiscountCode[], today: string, flash?: Flash): string {
  return layout(
    ctx,
    'Discount codes',
    html`<p><a href="/admin/orders">← Orders</a></p>
${flashBox(flash)}
<h1>Discount codes</h1>
<p class="small">Direct orders only. A code always comes off the re-grit, never off return postage. A use is held when the order is placed, used up when it’s paid, and given back if the order is rejected, withdrawn or lapses unpaid.</p>

<details class="action" open><summary>Free re-grit codes, one per person</summary>
<form method="post" action="/admin/codes">
  ${csrfField(ctx)}
  <input type="hidden" name="kind" value="free">
  <input type="hidden" name="value" value="1">
  <input type="hidden" name="maxUses" value="1">
  <input type="hidden" name="onePerEmail" value="yes">
  <p class="small">Each is a random, unguessable ${GENERATED_PREFIX}XXXXXXXX code: one paddle free, one use; return postage is still paid. Send each to one person from info@, and note on the code who it went to.</p>
  <label>How many codes (1 to ${MAX_BATCH})<input name="count" required inputmode="numeric" pattern="\\d{1,2}" value="1"></label>
  <label>Note (optional, only you see it), e.g. “Launch offer”<input name="note" maxlength="500"></label>
  <label>Last day they can be used (optional)<input type="date" name="expiresOn" min="${today}"></label>
  <button type="submit">Generate codes</button>
</form></details>

<details class="action"><summary>Create a code</summary>
<p class="small">For marketing campaigns: a shared code such as SPRING10, capped at a number of uses.</p>
<form method="post" action="/admin/codes">
  ${csrfField(ctx)}
  <label>Code (leave blank to generate a random ${GENERATED_PREFIX}XXXXXXXX one; letters, digits and hyphens)
    <input name="code" maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9\\-]{1,30}[A-Za-z0-9]" autocomplete="off"></label>
  <label>What it gives
    <select name="kind" required>
      <option value="free">Free re-grit for up to N paddles</option>
      <option value="amount">A$ off the re-grit</option>
      <option value="percent">% off the re-grit</option>
    </select></label>
  <label>How much: paddles (free re-grit), dollars (A$ off) or per cent (% off)
    <input name="value" required inputmode="decimal" pattern="\\d{1,5}(\\.\\d{1,2})?"></label>
  <label>Total uses<input name="maxUses" required inputmode="numeric" pattern="\\d{1,5}" value="1"></label>
  <label>Last day it can be used (optional)<input type="date" name="expiresOn" min="${today}"></label>
  <label class="check"><input type="checkbox" name="onePerEmail" value="yes" checked> Once per email address</label>
  <label>Note (optional, only you see it)<input name="note" maxlength="500"></label>
  <button type="submit">Create code</button>
</form></details>

<h2>Codes</h2>
${
  codes.length
    ? html`<ul class="orders">${codes.map(
        (c) => html`<li><a href="/admin/codes/${c.id}"><span><span class="ref">${c.code}</span> <span class="small">${facts(c)}${
          c.note ? html` · ${c.note}` : ''
        }</span></span>${state(c, today)}</a></li>`,
      )}</ul>`
    : html`<p class="empty">No codes yet.</p>`
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
