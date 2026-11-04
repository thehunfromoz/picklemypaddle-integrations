/**
 * The CRM mirror (SCRUM-74): what an order looks like in a CRM, independent of which CRM.
 *
 * One-way: the order database is the master and every sync overwrites the CRM's copy. The
 * contact carries only what Attila needs to recognise a customer. Never the street address,
 * photos, paddle details or the status-link token (AC3); `mapOrder` is the only place order
 * data is turned into CRM data, and its tests assert that.
 */
import { PRICE_PER_PADDLE_CENTS, STATUSES, type OrderStatus } from '../orders/model.js';
import { discountCents, type DiscountKind } from '../orders/rules.js';
import { BATCH_STATUSES, type BatchStatus } from '../clubs/model.js';

export interface CrmContact {
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  suburb: string;
  state: string;
  postcode: string;
  /** SCRUM-80: has left a review for any of their orders. */
  hasReviewed: boolean;
}

export interface CrmDeal {
  /** The order reference, e.g. PMP-7K3QX. */
  reference: string;
  /** `[TEST] PMP-…` for TEST orders (AC8). */
  name: string;
  amountCents: number;
  /** SCRUM-63 follow-up: how the amount is made up (fixed at Accept; the estimate before). */
  regritCents: number;
  discountCode: string | null;
  discountCents: number;
  /** Null before Accept (return postage isn't known until then). */
  postageCents: number | null;
  gstCents: number | null;
  paddleCount: number;
  isTest: boolean;
  status: OrderStatus;
  /** SCRUM-80: this order has a review. */
  reviewed: boolean;
}

/** Order data as the sync reads it from the database. */
export interface OrderForCrm {
  reference: string;
  status: OrderStatus;
  is_test: boolean;
  name: string;
  email: string;
  phone: string | null;
  suburb: string;
  state: string;
  postcode: string;
  paddle_count: number;
  /** The total frozen at Accept (SCRUM-81); null before. */
  amount_cents?: number | null;
  /** SCRUM-63: the code's benefit, saved at submit; taken off the estimate before Accept. */
  discount_kind?: DiscountKind | null;
  discount_value?: number | null;
  discount_code?: string | null;
  /** Fixed at Accept (SCRUM-81); null (or 0 for the discount) before. */
  subtotal_cents?: number | null;
  discount_cents?: number | null;
  postage_cents?: number | null;
  gst_cents?: number | null;
  /** SCRUM-80: this order has a review; any order with this email has one. */
  has_review: boolean;
  contact_has_review: boolean;
  crm_contact_id: string | null;
  crm_deal_id: string | null;
}

export interface CrmIds {
  contactId: string;
  dealId: string;
}

/** What order logic needs from a CRM, so the CRM can be swapped (AC1). */
export interface CrmAdapter {
  readonly name: string;
  /** Creates or updates the contact (by email) and the order's deal, associated. */
  sync(contact: CrmContact, deal: CrmDeal, known: Partial<CrmIds>): Promise<CrmIds>;
  /** Permanent deletion (erasure on request and retention, SCRUM-75). Gone already is fine. */
  deleteContact(id: string): Promise<void>;
  deleteDeal(id: string): Promise<void>;
  /** Erasure of a paid order kept for tax (SCRUM-75): leaves only the deal's name, reference and amount. */
  stripDeal(id: string): Promise<void>;
  /** The contact for this email, if the CRM has one (erasure, when no ID was stored). */
  findContactId(email: string): Promise<string | null>;
  /** SCRUM-85: a club as a company, its billing contact, and one deal per batch, all associated. */
  syncClub?(company: CrmCompany, contact: CrmClubContact, deals: CrmBatchDeal[], known: { companyId?: string; contactId?: string; dealIds: Record<string, string> }): Promise<ClubIds>;
}

/** "Sam de la Cruz" → Sam / de la Cruz. One word → that word and an empty last name. */
export function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/);
  return { firstName: parts[0] ?? '', lastName: parts.slice(1).join(' ') };
}

function dealAmounts(o: OrderForCrm): Pick<CrmDeal, 'amountCents' | 'regritCents' | 'discountCode' | 'discountCents' | 'postageCents' | 'gstCents'> {
  const code = o.discount_code ?? null;
  if (o.amount_cents != null) {
    return {
      amountCents: Number(o.amount_cents),
      regritCents: Number(o.subtotal_cents ?? o.amount_cents),
      discountCode: Number(o.discount_cents ?? 0) > 0 ? code : null,
      discountCents: Number(o.discount_cents ?? 0),
      postageCents: o.postage_cents != null ? Number(o.postage_cents) : null,
      gstCents: o.gst_cents != null ? Number(o.gst_cents) : null,
    };
  }
  const regrit = o.paddle_count * PRICE_PER_PADDLE_CENTS;
  const discount = o.discount_kind && o.discount_value != null
    ? discountCents({ kind: o.discount_kind, value: Number(o.discount_value) }, o.paddle_count, PRICE_PER_PADDLE_CENTS)
    : 0;
  return { amountCents: regrit - discount, regritCents: regrit, discountCode: code, discountCents: discount, postageCents: null, gstCents: null };
}

export function mapOrder(o: OrderForCrm): { contact: CrmContact; deal: CrmDeal } {
  return {
    contact: {
      // HubSpot matches contacts by email regardless of case; send one form so they always match.
      email: o.email.trim().toLowerCase(),
      ...splitName(o.name),
      phone: o.phone,
      suburb: o.suburb,
      state: o.state,
      postcode: o.postcode,
      hasReviewed: o.contact_has_review,
    },
    deal: {
      reference: o.reference,
      name: o.is_test ? `[TEST] ${o.reference}` : o.reference,
      // SCRUM-81/63: once accepted, the total and its parts as fixed at Accept; before that, the
      // re-grit estimate with any code's discount taken off (postage isn't known yet).
      ...dealAmounts(o),
      paddleCount: o.paddle_count,
      isTest: o.is_test,
      status: o.status,
      reviewed: o.has_review,
    },
  };
}

/**
 * The deal pipeline: one stage per order status, in workflow order (AC4). Probability 1 marks a
 * stage closed-won and 0 closed-lost, as HubSpot reads them.
 */
export const STAGES: Readonly<Record<OrderStatus, { label: string; probability: number }>> = {
  submitted: { label: 'Submitted', probability: 0.1 },
  questions: { label: 'Questions', probability: 0.1 },
  accepted: { label: 'Accepted', probability: 0.3 },
  paid: { label: 'Paid', probability: 0.6 },
  in_queue: { label: 'In queue', probability: 0.8 },
  regritted: { label: 'Re-gritted', probability: 0.9 },
  posted_back: { label: 'Posted back', probability: 0.9 },
  completed: { label: 'Completed', probability: 1 },
  rejected: { label: 'Rejected', probability: 0 },
  withdrawn: { label: 'Withdrawn', probability: 0 },
  lapsed: { label: 'Lapsed', probability: 0 },
  // SCRUM-84: refunded in full. hubspot-setup creates the stage.
  refunded: { label: 'Refunded', probability: 0 },
};

/** Stages in display order. */
export const STAGE_ORDER: readonly OrderStatus[] = STATUSES;

// ── Clubs (SCRUM-85 AC8) ──────────────────────────────────────────────────────

/** A club as a CRM company: its name only (the billing address stays in our database). */
export interface CrmCompany {
  clubId: string;
  /** `[TEST] …` for clubs made outside production. */
  name: string;
  isTest: boolean;
}

/** The club's billing contact: name and email only. */
export interface CrmClubContact {
  email: string;
  firstName: string;
  lastName: string;
}

/** A batch as a deal: amount = the invoice total (an estimate at the club price before), stage = batch status. */
export interface CrmBatchDeal {
  reference: string;
  name: string;
  amountCents: number;
  paddleCount: number;
  isTest: boolean;
  status: BatchStatus;
}

export interface ClubIds {
  companyId: string;
  contactId: string;
  /** Batch reference → deal id. */
  dealIds: Record<string, string>;
}

/** Club data as the sync reads it from the database. */
export interface ClubForCrm {
  id: string;
  name: string;
  is_test: boolean;
  billing_name: string;
  billing_email: string;
  crm_company_id: string | null;
  crm_contact_id: string | null;
  batches: { reference: string; status: BatchStatus; paddle_count: number; unchanged_count: number; invoice_total: number | null; crm_deal_id: string | null }[];
}

/** The club price a paddle, for a batch's estimate before it's invoiced. */
const CLUB_ESTIMATE_CENTS = 5400;

export function mapClub(c: ClubForCrm): { company: CrmCompany; contact: CrmClubContact; deals: CrmBatchDeal[] } {
  const tag = (s: string) => (c.is_test ? `[TEST] ${s}` : s);
  return {
    company: { clubId: c.id, name: tag(c.name), isTest: c.is_test },
    contact: { email: c.billing_email.trim().toLowerCase(), ...splitName(c.billing_name) },
    deals: c.batches.map((b) => ({
      reference: b.reference,
      name: tag(`${b.reference} (${c.name})`),
      // Invoiced: the total as issued. Before (or with nothing invoiced): the paddles to re-grit at the club price.
      amountCents: b.invoice_total !== null ? Number(b.invoice_total) : b.status === 'cancelled' ? 0 : (b.paddle_count - b.unchanged_count) * CLUB_ESTIMATE_CENTS,
      paddleCount: b.paddle_count,
      isTest: c.is_test,
      status: b.status,
    })),
  };
}

/**
 * Club batches' stages. The free CRM has one deal pipeline, so they sit after the order stages in
 * the same pipeline, prefixed "Club batch:" (with a paid HubSpot plan they could move to their own).
 */
export const CLUB_STAGES: Readonly<Record<BatchStatus, { label: string; probability: number }>> = {
  collected: { label: 'Club batch: collected', probability: 0.5 },
  returned: { label: 'Club batch: returned', probability: 0.8 },
  invoiced: { label: 'Club batch: invoiced', probability: 0.9 },
  paid: { label: 'Club batch: paid', probability: 1 },
  cancelled: { label: 'Club batch: cancelled', probability: 0 },
};
export const CLUB_STAGE_ORDER: readonly BatchStatus[] = BATCH_STATUSES;

/** Every stage we own in the pipeline, in order: orders' first, then club batches'. */
export const PIPELINE_STAGES: readonly { key: string; label: string; probability: number }[] = [
  ...STAGE_ORDER.map((s) => ({ key: s, ...STAGES[s] })),
  ...CLUB_STAGE_ORDER.map((s) => ({ key: `club:${s}`, ...CLUB_STAGES[s] })),
];
