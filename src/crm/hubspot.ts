/**
 * HubSpot implementation of the CRM mirror (SCRUM-74), over HubSpot's CRM v3 REST API with a
 * service key. Free CRM: the single default deal pipeline, with one stage per order status, and
 * three custom deal properties. Both are defined here as code and applied by
 * `src/cli/hubspot-setup.ts` (AC5).
 *
 * Errors carry an HTTP status or network error name only, never HubSpot's message, which can
 * quote the request (an email address, say).
 */
import type { OrderStatus } from '../orders/model.js';
import { STAGE_ORDER, STAGES, type CrmAdapter, type CrmContact, type CrmDeal, type CrmIds } from './crm.js';

export class HubSpotError extends Error {
  constructor(
    readonly status: number | null,
    readonly code: string,
    readonly permanent: boolean,
  ) {
    super(`HubSpot request failed: ${code}`);
    this.name = 'HubSpotError';
  }
}

export interface HubSpotClient {
  request<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T>;
}

export function hubspotClient(token: string, base = 'https://api.hubapi.com', fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): HubSpotClient {
  const root = base.replace(/\/$/, '');
  return {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      let res: Response;
      try {
        res = await fetchImpl(`${root}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            'User-Agent': 'picklemypaddle-integrations',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new HubSpotError(null, `network:${(err as Error)?.name ?? 'error'}`, false);
      }
      if (res.status === 204) return undefined as T;
      if (res.ok) return (await res.json()) as T;
      await res.body?.cancel().catch(() => undefined);
      // 429 (rate limit: 100 requests per 10 s) and 5xx are worth retrying; other 4xx are not.
      throw new HubSpotError(res.status, `http:${res.status}`, !(res.status === 429 || res.status >= 500));
    },
  };
}

// ── What we define in HubSpot (AC5) ───────────────────────────────────────────

export const PIPELINE_ID = 'default';
export const PROPERTY_GROUP = { name: 'picklemypaddle', label: 'PickleMyPaddle' } as const;

export interface PropertyDef {
  name: string;
  label: string;
  type: 'string' | 'number' | 'bool';
  fieldType: 'text' | 'number' | 'booleancheckbox';
  description: string;
  options?: { label: string; value: string; displayOrder: number }[];
}

export const DEAL_PROPERTIES: readonly PropertyDef[] = [
  { name: 'pmp_reference', label: 'Order reference', type: 'string', fieldType: 'text', description: 'PickleMyPaddle order reference (PMP-…). Set by the integrations service.' },
  { name: 'pmp_paddle_count', label: 'Paddles', type: 'number', fieldType: 'number', description: 'Number of paddles in the order. Set by the integrations service.' },
  {
    name: 'pmp_is_test',
    label: 'Test order',
    type: 'bool',
    fieldType: 'booleancheckbox',
    description: 'A TEST order placed outside production. Set by the integrations service.',
    options: [
      { label: 'Yes', value: 'true', displayOrder: 0 },
      { label: 'No', value: 'false', displayOrder: 1 },
    ],
  },
];

/** HubSpot's own association type: deal → contact. */
const DEAL_TO_CONTACT = 3;

// ── The adapter ───────────────────────────────────────────────────────────────

interface Stage {
  id: string;
  label: string;
  displayOrder: number;
  metadata?: { probability?: string };
}
interface Pipeline {
  id: string;
  stages: Stage[];
}

const norm = (s: string) => s.trim().toLowerCase();

export function hubspotAdapter(client: HubSpotClient): CrmAdapter & { stageIds(): Promise<Record<OrderStatus, string>> } {
  let cached: Record<OrderStatus, string> | null = null;

  async function stageIds(): Promise<Record<OrderStatus, string>> {
    if (cached) return cached;
    const pipeline = await client.request<Pipeline>('GET', `/crm/v3/pipelines/deals/${PIPELINE_ID}`);
    const byLabel = new Map(pipeline.stages.map((s) => [norm(s.label), s.id]));
    const out = {} as Record<OrderStatus, string>;
    for (const status of STAGE_ORDER) {
      const id = byLabel.get(norm(STAGES[status].label));
      // A stage missing from HubSpot means the setup script hasn't run against this portal.
      if (!id) throw new HubSpotError(null, 'stage_missing', true);
      out[status] = id;
    }
    cached = out;
    return out;
  }

  const contactProperties = (c: CrmContact) => ({
    email: c.email,
    firstname: c.firstName,
    lastname: c.lastName,
    phone: c.phone ?? '',
    city: c.suburb,
    state: c.state,
    zip: c.postcode,
  });

  const dealProperties = (d: CrmDeal, stageId: string) => ({
    dealname: d.name,
    amount: (d.amountCents / 100).toFixed(2),
    pipeline: PIPELINE_ID,
    dealstage: stageId,
    pmp_reference: d.reference,
    pmp_paddle_count: String(d.paddleCount),
    pmp_is_test: String(d.isTest),
  });

  async function upsertContact(c: CrmContact): Promise<string> {
    const r = await client.request<{ results: { id: string }[] }>('POST', '/crm/v3/objects/contacts/batch/upsert', {
      inputs: [{ idProperty: 'email', id: c.email, properties: contactProperties(c) }],
    });
    const id = r.results?.[0]?.id;
    if (!id) throw new HubSpotError(null, 'contact_upsert_empty', false);
    return id;
  }

  async function findDeal(reference: string): Promise<string | null> {
    const r = await client.request<{ results: { id: string }[] }>('POST', '/crm/v3/objects/deals/search', {
      filterGroups: [{ filters: [{ propertyName: 'pmp_reference', operator: 'EQ', value: reference }] }],
      properties: ['pmp_reference'],
      limit: 1,
    });
    return r.results?.[0]?.id ?? null;
  }

  const associate = (dealId: string, contactId: string) =>
    client.request('PUT', `/crm/v4/objects/deals/${dealId}/associations/default/contacts/${contactId}`);

  return {
    name: 'hubspot',
    stageIds,

    async sync(contact, deal, known) {
      const contactId = await upsertContact(contact);
      const properties = dealProperties(deal, (await stageIds())[deal.status]);

      // Update the deal we know about; if it was deleted in HubSpot, find it again or recreate it.
      let dealId = known.dealId ?? null;
      if (dealId) {
        try {
          await client.request('PATCH', `/crm/v3/objects/deals/${dealId}`, { properties });
        } catch (err) {
          if (!(err instanceof HubSpotError && err.status === 404)) throw err;
          dealId = null;
        }
      }
      // Not known (or gone): one may exist from a sync that crashed before saving its ID.
      let found = false;
      if (!dealId) {
        dealId = await findDeal(deal.reference);
        found = dealId !== null;
        if (dealId) await client.request('PATCH', `/crm/v3/objects/deals/${dealId}`, { properties });
      }
      if (!dealId) {
        const created = await client.request<{ id: string }>('POST', '/crm/v3/objects/deals', {
          properties,
          associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: DEAL_TO_CONTACT }] }],
        });
        return { contactId, dealId: created.id } satisfies CrmIds;
      }
      if (found || known.contactId !== contactId) await associate(dealId, contactId);
      return { contactId, dealId };
    },

    async deleteContact(id) {
      // GDPR delete: permanent, and HubSpot also blocks the address from being re-created by forms.
      await client.request('POST', '/crm/v3/objects/contacts/gdpr-delete', { objectId: id });
    },

    async deleteDeal(id) {
      try {
        await client.request('DELETE', `/crm/v3/objects/deals/${id}`);
      } catch (err) {
        if (!(err instanceof HubSpotError && err.status === 404)) throw err;
      }
    },
  };
}

/** The portal (account) a key belongs to, so staging can prove it's talking to the test portal. */
export async function portalIdOf(client: HubSpotClient): Promise<string> {
  const r = await client.request<{ portalId: number | string }>('GET', '/account-info/v3/details');
  return String(r.portalId);
}

// ── Setup as code (AC5) ───────────────────────────────────────────────────────

export type SetupChange =
  | { kind: 'create_group' }
  | { kind: 'create_property'; property: PropertyDef }
  | { kind: 'update_property'; property: PropertyDef; differences: string[] }
  | { kind: 'create_stage'; status: OrderStatus; label: string; displayOrder: number; probability: number }
  | { kind: 'update_stage'; status: OrderStatus; id: string; label: string; displayOrder: number; probability: number; differences: string[] };

export interface SetupPlan {
  changes: SetupChange[];
  /** Stages in the pipeline that aren't ours: left alone, listed so Attila can remove them. */
  unusedStages: string[];
}

interface RemoteProperty {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  groupName: string;
}

export async function planSetup(client: HubSpotClient): Promise<SetupPlan> {
  const changes: SetupChange[] = [];

  const groups = await client.request<{ results: { name: string }[] }>('GET', '/crm/v3/properties/deals/groups');
  if (!groups.results.some((g) => g.name === PROPERTY_GROUP.name)) changes.push({ kind: 'create_group' });

  for (const p of DEAL_PROPERTIES) {
    let remote: RemoteProperty | null = null;
    try {
      remote = await client.request<RemoteProperty>('GET', `/crm/v3/properties/deals/${p.name}`);
    } catch (err) {
      if (!(err instanceof HubSpotError && err.status === 404)) throw err;
    }
    if (!remote) {
      changes.push({ kind: 'create_property', property: p });
      continue;
    }
    const differences = [
      remote.label !== p.label ? `label "${remote.label}" → "${p.label}"` : null,
      remote.type !== p.type ? `type ${remote.type} → ${p.type} (HubSpot may refuse; delete the property first)` : null,
      remote.fieldType !== p.fieldType ? `field type ${remote.fieldType} → ${p.fieldType}` : null,
      remote.groupName !== PROPERTY_GROUP.name ? `group ${remote.groupName} → ${PROPERTY_GROUP.name}` : null,
    ].filter((d): d is string => d !== null);
    if (differences.length) changes.push({ kind: 'update_property', property: p, differences });
  }

  const pipeline = await client.request<Pipeline>('GET', `/crm/v3/pipelines/deals/${PIPELINE_ID}`);
  const ours = new Set(STAGE_ORDER.map((s) => norm(STAGES[s].label)));
  // Position is checked as order, not as exact numbers: HubSpot numbers stages across the whole
  // pipeline (its own default stages included), so ours land at 1..11 rather than 0..10.
  const found = STAGE_ORDER.map((status) => pipeline.stages.find((s) => norm(s.label) === norm(STAGES[status].label)));
  const present = found.filter((s): s is Stage => s !== undefined);
  const inOrder = present.every((s, i) => i === 0 || present[i - 1]!.displayOrder < s.displayOrder);
  STAGE_ORDER.forEach((status, displayOrder) => {
    const want = STAGES[status];
    const have = found[displayOrder];
    if (!have) {
      changes.push({ kind: 'create_stage', status, label: want.label, displayOrder, probability: want.probability });
      return;
    }
    const prob = Number(have.metadata?.probability ?? NaN);
    const differences = [
      have.label !== want.label ? `label "${have.label}" → "${want.label}"` : null,
      !inOrder && have.displayOrder !== displayOrder ? `position ${have.displayOrder} → ${displayOrder}` : null,
      prob !== want.probability ? `probability ${have.metadata?.probability ?? 'unset'} → ${want.probability}` : null,
    ].filter((d): d is string => d !== null);
    if (differences.length) {
      changes.push({ kind: 'update_stage', status, id: have.id, label: want.label, displayOrder, probability: want.probability, differences });
    }
  });
  const unusedStages = pipeline.stages.filter((s) => !ours.has(norm(s.label))).map((s) => s.label);
  return { changes, unusedStages };
}

export async function applySetup(client: HubSpotClient, plan: SetupPlan): Promise<void> {
  for (const c of plan.changes) {
    switch (c.kind) {
      case 'create_group':
        await client.request('POST', '/crm/v3/properties/deals/groups', { ...PROPERTY_GROUP, displayOrder: -1 });
        break;
      case 'create_property':
        await client.request('POST', '/crm/v3/properties/deals', { ...c.property, groupName: PROPERTY_GROUP.name });
        break;
      case 'update_property': {
        const { name, ...rest } = c.property;
        await client.request('PATCH', `/crm/v3/properties/deals/${name}`, { ...rest, groupName: PROPERTY_GROUP.name });
        break;
      }
      case 'create_stage':
        await client.request('POST', `/crm/v3/pipelines/deals/${PIPELINE_ID}/stages`, {
          label: c.label,
          displayOrder: c.displayOrder,
          metadata: { probability: String(c.probability) },
        });
        break;
      case 'update_stage':
        await client.request('PATCH', `/crm/v3/pipelines/deals/${PIPELINE_ID}/stages/${c.id}`, {
          label: c.label,
          displayOrder: c.displayOrder,
          metadata: { probability: String(c.probability) },
        });
        break;
    }
  }
}

export function describeChange(c: SetupChange): string {
  switch (c.kind) {
    case 'create_group':
      return `create deal property group "${PROPERTY_GROUP.label}"`;
    case 'create_property':
      return `create deal property ${c.property.name} ("${c.property.label}", ${c.property.type})`;
    case 'update_property':
      return `update deal property ${c.property.name}: ${c.differences.join('; ')}`;
    case 'create_stage':
      return `create stage "${c.label}" at position ${c.displayOrder} (probability ${c.probability})`;
    case 'update_stage':
      return `update stage "${c.label}": ${c.differences.join('; ')}`;
  }
}
