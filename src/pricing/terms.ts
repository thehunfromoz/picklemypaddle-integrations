/**
 * Prices and tax terms on a given day (SCRUM-81).
 *
 * "What are the terms on date D?" has one answer, from here: the re-grit price a paddle, the
 * club remittance a paddle, whether GST applies and how documents word it. Every order and
 * document saves the answer when it is issued (Accept for an order, the issue date for a
 * receipt or invoice), so changing a price or the GST date never alters anything issued before.
 *
 * Decided 30 Oct 2026: A$60 a paddle stays A$60 and, from GST_REGISTERED_FROM, it INCLUDES GST
 * (A$5.45). Not GST-registered until then: documents say "Invoice" and "No GST has been charged",
 * never "tax invoice". The date that decides is the issue date (Attila confirms this rule with
 * his accountant before registering).
 *
 * Dates are Sydney calendar days, YYYY-MM-DD (compare as strings).
 */

/** A price list, in force from its date until the next one. Add a new entry; never edit an old one. */
export interface PriceList {
  from: string;
  /** The re-grit price a paddle, both faces, GST-inclusive once registered. */
  pricePerPaddleCents: number;
  /** What a club remits a paddle (the price less its 10% commission, SCRUM-10). */
  clubRemitPerPaddleCents: number;
}

export const PRICE_LISTS: readonly PriceList[] = [
  // Decided 6 Oct 2026 (SCRUM-9).
  { from: '2026-01-01', pricePerPaddleCents: 6000, clubRemitPerPaddleCents: 5400 },
];

/**
 * not_registered: no GST. gst_inclusive: direct orders once registered, A$60 includes GST.
 * gst_exclusive: club invoices once registered (decided 4 Nov 2026): GST is added on top of the
 * club price as its own line, so a registered club can claim it.
 */
export type TaxTreatment = 'not_registered' | 'gst_inclusive' | 'gst_exclusive';

/** The GST rate, in per cent. */
export const GST_PERCENT = 10;

export interface TaxSettings {
  /** The first day GST applies (GST_REGISTERED_FROM); null = not registered. */
  gstRegisteredFrom: string | null;
}

export interface Terms {
  /** The Sydney day these terms are for. */
  date: string;
  pricePerPaddleCents: number;
  clubRemitPerPaddleCents: number;
  treatment: TaxTreatment;
  /** Short, stable label saved with an order or document: which price list and tax rule applied. */
  version: string;
}

export function priceListOn(date: string, lists: readonly PriceList[] = PRICE_LISTS): PriceList {
  let found: PriceList | undefined;
  for (const l of lists) if (l.from <= date && (!found || l.from > found.from)) found = l;
  if (!found) throw new Error(`no price list in force on ${date}`);
  return found;
}

export function termsOn(date: string, tax: TaxSettings, lists: readonly PriceList[] = PRICE_LISTS): Terms {
  const list = priceListOn(date, lists);
  const treatment: TaxTreatment = tax.gstRegisteredFrom !== null && date >= tax.gstRegisteredFrom ? 'gst_inclusive' : 'not_registered';
  return {
    date,
    pricePerPaddleCents: list.pricePerPaddleCents,
    clubRemitPerPaddleCents: list.clubRemitPerPaddleCents,
    treatment,
    version: `price:${list.from};gst:${treatment === 'gst_inclusive' ? `from-${tax.gstRegisteredFrom}` : 'none'}`,
  };
}

/**
 * The GST included in a total: one eleventh, rounded to the nearest cent. 0 before registration.
 * For gst_exclusive the total is the subtotal plus 10%, so its GST is also one eleventh of it;
 * clubInvoiceAmounts works it out from the subtotal instead, which is what the invoice shows.
 */
export function gstIncluded(totalCents: number, treatment: TaxTreatment): number {
  if (treatment === 'not_registered') return 0;
  return Math.round(totalCents / 11);
}

/** The tax treatment of a club invoice issued on `date`: GST on top once registered. */
export function clubTreatment(date: string, tax: TaxSettings): TaxTreatment {
  return tax.gstRegisteredFrom !== null && date >= tax.gstRegisteredFrom ? 'gst_exclusive' : 'not_registered';
}

/**
 * A club invoice's amounts (SCRUM-85, GST rule decided 4 Nov 2026): the paddles at the club price
 * (GST-exclusive), then GST at 10% of that subtotal rounded to the cent, then the total.
 */
export function clubInvoiceAmounts(paddles: number, remitPerPaddleCents: number, treatment: TaxTreatment): { subtotalCents: number; gstCents: number; totalCents: number } {
  if (!Number.isInteger(paddles) || paddles < 1) throw new Error('a club invoice is for at least one paddle');
  if (treatment === 'gst_inclusive') throw new Error('club invoices are never GST-inclusive');
  const subtotalCents = paddles * remitPerPaddleCents;
  const gstCents = treatment === 'gst_exclusive' ? Math.round((subtotalCents * GST_PERCENT) / 100) : 0;
  return { subtotalCents, gstCents, totalCents: subtotalCents + gstCents };
}

const money = (cents: number) => `A$${(cents / 100).toFixed(2)}`;

/** How a document is headed and what it says about GST, for its issue date's treatment. */
export function taxWording(treatment: TaxTreatment, totalCents: number): { heading: 'Invoice' | 'Tax invoice'; gstLine: string } {
  if (treatment === 'gst_inclusive') return { heading: 'Tax invoice', gstLine: `Total includes GST of ${money(gstIncluded(totalCents, treatment))}` };
  if (treatment === 'gst_exclusive') return { heading: 'Tax invoice', gstLine: `GST (${GST_PERCENT}%) ${money(gstIncluded(totalCents, treatment))}` };
  return { heading: 'Invoice', gstLine: 'No GST has been charged' };
}

/** The line shown next to prices on the website and in emails. */
export function priceNote(treatment: TaxTreatment): string {
  if (treatment === 'gst_inclusive') return 'Prices include GST.';
  if (treatment === 'gst_exclusive') return `Prices exclude GST: GST at ${GST_PERCENT}% is added.`;
  return 'No GST is charged: we aren’t registered for GST.';
}

/** An Australian Business Number: 11 digits passing the ATO's check (weights mod 89). */
export function isValidAbn(value: string): boolean {
  const digits = value.replace(/\s/g, '');
  if (!/^\d{11}$/.test(digits)) return false;
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const sum = digits.split('').reduce((acc, d, i) => acc + (Number(d) - (i === 0 ? 1 : 0)) * weights[i]!, 0);
  return sum % 89 === 0;
}
