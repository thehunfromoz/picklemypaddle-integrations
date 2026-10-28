/**
 * The CRM mirror (SCRUM-74): what an order looks like in a CRM, independent of which CRM.
 *
 * One-way: the order database is the master and every sync overwrites the CRM's copy. The
 * contact carries only what Attila needs to recognise a customer. Never the street address,
 * photos, paddle details or the status-link token (AC3); `mapOrder` is the only place order
 * data is turned into CRM data, and its tests assert that.
 */
import { PRICE_PER_PADDLE_CENTS, STATUSES, type OrderStatus } from '../orders/model.js';

export interface CrmContact {
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  suburb: string;
  state: string;
  postcode: string;
}

export interface CrmDeal {
  /** The order reference, e.g. PMP-7K3QX. */
  reference: string;
  /** `[TEST] PMP-…` for TEST orders (AC8). */
  name: string;
  amountCents: number;
  paddleCount: number;
  isTest: boolean;
  status: OrderStatus;
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
  /** Permanent deletion (erasure on request, SCRUM-75). */
  deleteContact(id: string): Promise<void>;
  deleteDeal(id: string): Promise<void>;
}

/** "Sam de la Cruz" → Sam / de la Cruz. One word → that word and an empty last name. */
export function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/);
  return { firstName: parts[0] ?? '', lastName: parts.slice(1).join(' ') };
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
    },
    deal: {
      reference: o.reference,
      name: o.is_test ? `[TEST] ${o.reference}` : o.reference,
      // Return postage is added by SCRUM-9.
      amountCents: o.paddle_count * PRICE_PER_PADDLE_CENTS,
      paddleCount: o.paddle_count,
      isTest: o.is_test,
      status: o.status,
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
};

/** Stages in display order. */
export const STAGE_ORDER: readonly OrderStatus[] = STATUSES;
