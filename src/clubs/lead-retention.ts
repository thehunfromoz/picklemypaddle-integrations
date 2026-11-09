/**
 * Retention for club leads (SCRUM-93, decided 9 Nov 2026): a club that never became a customer is
 * deleted 12 months after anyone last did anything with it: its record, and its company and
 * contact in HubSpot. "Never became a customer" means no billing details and no batches, so an
 * Active club (or one that was) is never touched by this rule.
 *
 * HubSpot is cleaned first; if that fails the lead waits for the next run, so no personal data is
 * left behind there. Idempotent. Counts only in logs, never who.
 */
import { checkPortal, type CrmDeps } from '../crm/sync.js';
import type { Db } from '../db/db.js';
import { log, logError } from '../log.js';
import { sydneyDate } from '../orders/dates.js';
import { addMonths } from '../orders/retention.js';

export const LEAD_RETENTION_MONTHS = 12;

export interface LeadRetentionDeps {
  db: Db;
  /** Null: HubSpot isn't configured here, so there is nothing to clean up there. */
  crm: CrmDeps | null;
}

interface StaleLead {
  id: string;
  name: string;
  crm_company_id: string | null;
  crm_contact_id: string | null;
  contact_email: string | null;
}

/** Leads whose last activity (a Sydney day) is more than 12 months before today's. */
export async function staleLeads(db: Db, now: Date): Promise<StaleLead[]> {
  const cutoff = addMonths(sydneyDate(now), -LEAD_RETENTION_MONTHS);
  const { rows } = await db.query<StaleLead>(
    `SELECT c.id, c.name, c.crm_company_id, c.crm_contact_id, c.contact_email
       FROM clubs c
      WHERE c.status IN ('lead', 'meeting', 'agreement_sent', 'inactive')
        AND c.billing_email IS NULL
        AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.club_id = c.id)
        AND (c.last_activity_at AT TIME ZONE 'Australia/Sydney')::date < $1::date
      ORDER BY c.created_at`,
    [cutoff],
  );
  return rows;
}

/** The contact is deleted unless a customer with that address still has an order (the contact is shared). */
async function contactStillNeeded(db: Db, email: string | null): Promise<boolean> {
  if (!email) return false;
  const lower = email.trim().toLowerCase();
  const plain = lower.replace(/\+[^@]*@/, '@');
  const { rows } = await db.query<{ n: number | string }>(
    'SELECT count(*) AS n FROM orders WHERE email_norm IN ($1, $2) AND NOT is_smoke AND erased_at IS NULL',
    [lower, plain],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

export async function runLeadRetention(deps: LeadRetentionDeps, now: Date): Promise<{ leads: number; waiting: number }> {
  const out = { leads: 0, waiting: 0 };
  for (const lead of await staleLeads(deps.db, now)) {
    try {
      const crm = deps.crm;
      if (crm?.adapter && (lead.crm_company_id || lead.crm_contact_id)) {
        if ((await checkPortal(crm)) === 'mismatch') throw new Error('crm_portal_mismatch');
        if (lead.crm_company_id) await crm.adapter.deleteCompany?.(lead.crm_company_id);
        if (lead.crm_contact_id && !(await contactStillNeeded(deps.db, lead.contact_email))) await crm.adapter.deleteContact(lead.crm_contact_id);
      }
      await deps.db.query('DELETE FROM clubs WHERE id = $1', [lead.id]);
      out.leads++;
    } catch (err) {
      out.waiting++;
      logError('lead_retention_waiting', err);
    }
  }
  log('lead_retention_run', { ...out });
  return out;
}
