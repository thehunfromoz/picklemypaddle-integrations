/**
 * Receipts, invoices and credit notes in the admin (SCRUM-84): the list of every document (the
 * accountant's view), a document's printable page, and the section on an order's page.
 *
 * The printable page lays out the frozen snapshot: every word on it comes from the document as
 * issued, so a change to the settings or this code's wording never alters an issued document.
 */
import {
  displayHeading,
  documentDate,
  documentMoney,
  KIND_TITLE,
  paidLine,
  type DocumentSummary,
  type DocumentView,
} from '../documents/documents.js';
import { dollars, html, type Html } from './html.js';
import { layout, type PageContext } from './pages.js';

/** SCRUM-85: a club batch's reference (PMPB-…) rather than an order's. */
const isBatch = (reference: string) => reference.startsWith('PMPB-');
/** Where a document's reference opens in the admin. */
export const referenceHref = (reference: string) => (isBatch(reference) ? `/admin/batches/${reference}` : `/admin/orders/${reference}`);

/** The document itself, as on paper. Shared shape with the site's printable page. */
export function documentBody(v: DocumentView): Html {
  const s = v.snapshot;
  const paid = paidLine(v);
  return html`<article class="doc">
${s.test ? html`<p class="doc-test">TEST DOCUMENT from the staging site: not a real ${s.heading.toLowerCase()}. Nothing was charged.</p>` : ''}
<header class="doc-head">
  <div>
    <h1>${displayHeading(s.heading, !!v.paid && s.kind !== 'credit_note')}</h1>
    <dl class="doc-meta">
      <dt>Number</dt><dd>${s.number}</dd>
      <dt>Date of issue</dt><dd>${documentDate(s.issuedOn)}</dd>
      <dt>${isBatch(s.reference) ? 'Club batch' : 'Order'}</dt><dd>${s.reference}</dd>
      ${s.dueOn ? html`<dt>Due by</dt><dd>${documentDate(s.dueOn)}</dd>` : ''}
      ${s.refersTo ? html`<dt>For</dt><dd>${s.refersTo.number} of ${documentDate(s.refersTo.issuedOn)}</dd>` : ''}
    </dl>
  </div>
  <div class="doc-seller">
    <strong>${s.seller.name}</strong><br>
    ABN ${s.seller.abn}<br>
    ${s.seller.email}<br>
    ${s.seller.website}
  </div>
</header>
<p class="doc-buyer"><span class="small">${s.kind === 'credit_note' ? 'Credit to' : 'Bill to'}</span><br><strong>${s.buyer.name}</strong>${
    s.buyer.abn ? html`<br>ABN ${s.buyer.abn}` : ''
  }${s.buyer.address ? html`<br><span class="pre">${s.buyer.address}</span>` : ''}</p>
<table class="doc-lines">
  <thead><tr><th scope="col">Description</th><th scope="col" class="num">Qty</th><th scope="col" class="num">Each</th><th scope="col" class="num">Amount</th></tr></thead>
  <tbody>${s.lines.map(
    (l) => html`<tr><td>${l.description}</td><td class="num">${l.quantity}</td><td class="num">${documentMoney(l.unitCents)}</td><td class="num">${documentMoney(l.amountCents)}</td></tr>`,
  )}</tbody>
  <tfoot>
    ${s.subtotalCents !== undefined
      ? html`<tr><th scope="row" colspan="3">Subtotal (excluding GST)</th><td class="num">${documentMoney(s.subtotalCents)}</td></tr>
    <tr><th scope="row" colspan="3">GST (10%)</th><td class="num">${documentMoney(s.gstCents)}</td></tr>`
      : ''}
    <tr class="total"><th scope="row" colspan="3">${s.kind === 'credit_note' ? 'Total credit' : 'Total'}</th><td class="num">${documentMoney(s.totalCents)}</td></tr>
    ${s.subtotalCents === undefined ? html`<tr><td colspan="4" class="gst">${s.gstLine}</td></tr>` : ''}
  </tfoot>
</table>
${paid ? html`<p class="doc-paid">${paid}</p>` : ''}
${s.notes.map((n) => html`<p class="small">${n}</p>`)}
</article>`;
}

export function documentPage(ctx: PageContext, v: DocumentView): string {
  return layout(
    ctx,
    v.snapshot.number,
    html`<p class="no-print"><a href="/admin/documents">← Documents</a>${v.snapshot.reference ? html` · <a href="${referenceHref(v.snapshot.reference)}">${isBatch(v.snapshot.reference) ? 'Batch' : 'Order'} ${v.snapshot.reference}</a>` : ''}</p>
<p class="no-print small">To print it or save it as a PDF, use your browser’s Print (Ctrl+P or ⌘P). It prints without the admin’s header.</p>
${documentBody(v)}
<p class="no-print small">SHA-256 of the issued document: <code>${v.sha256}</code></p>`,
  );
}

const kindLabel = (d: DocumentSummary) => KIND_TITLE[d.kind];

function rows(docs: DocumentSummary[], withOrder: boolean): Html {
  return html`<table class="list">
<thead><tr><th scope="col">Number</th><th scope="col">Kind</th><th scope="col">Issued</th>${withOrder ? html`<th scope="col">Order or batch</th>` : ''}<th scope="col" class="num">Total</th><th scope="col" class="num">GST</th></tr></thead>
<tbody>${docs.map(
    (d) => html`<tr><td><a href="/admin/documents/${d.number}">${d.number}</a></td><td>${kindLabel(d)}${d.refersTo ? html` <span class="small">for ${d.refersTo}</span>` : ''}</td><td>${documentDate(d.issuedOn)}</td>${
      withOrder ? html`<td>${d.reference ? html`<a href="${referenceHref(d.reference)}">${d.reference}</a>` : '—'}</td>` : ''
    }<td class="num">${d.kind === 'credit_note' ? '−' : ''}${dollars(d.totalCents)}</td><td class="num">${dollars(d.gstCents)}</td></tr>`,
  )}</tbody></table>`;
}

/** The section on an order's page. */
export function documentsSection(docs: DocumentSummary[]): Html | string {
  if (docs.length === 0) return '';
  return html`<h2>Receipts and credit notes</h2>${rows([...docs].reverse(), false)}`;
}

export function documentListPage(ctx: PageContext, docs: DocumentSummary[]): string {
  return layout(
    ctx,
    'Documents',
    html`<h1>Receipts, invoices and credit notes</h1>
<p class="small">Every document issued, newest first. Numbers are never skipped or reused, and a document is never edited after issue: a refund or correction is a credit note.</p>
${docs.length ? rows(docs, true) : html`<p class="empty">No documents yet: the first receipt is issued when an order is paid.</p>`}`,
  );
}
