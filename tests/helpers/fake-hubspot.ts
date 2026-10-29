/**
 * An in-memory HubSpot for tests (SCRUM-74): answers the CRM v3 calls the adapter and the setup
 * script make, records every request, and can be told to fail.
 */
export interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

interface Stage {
  id: string;
  label: string;
  displayOrder: number;
  metadata: { probability: string };
}

export interface FakeHubSpot {
  fetch: typeof fetch;
  calls: Recorded[];
  portalId: string;
  contacts: Map<string, { id: string; properties: Record<string, string> }>;
  deals: Map<string, { properties: Record<string, string>; contacts: Set<string> }>;
  stages: Stage[];
  groups: Set<string>;
  properties: Map<string, Record<string, unknown>>;
  /** Status codes to answer the next requests with, in order. */
  failNext: number[];
}

/** HubSpot's default stages in a new portal. */
const DEFAULT_STAGES = ['Appointment scheduled', 'Qualified to buy', 'Presentation scheduled', 'Decision maker bought-in', 'Contract sent', 'Closed won', 'Closed lost'];

export function fakeHubSpot(opts: { portalId?: string } = {}): FakeHubSpot {
  let nextId = 1000;
  const id = () => String(nextId++);
  const hs: FakeHubSpot = {
    fetch: undefined as unknown as typeof fetch,
    calls: [],
    portalId: opts.portalId ?? '111',
    contacts: new Map(),
    deals: new Map(),
    stages: DEFAULT_STAGES.map((label, i) => ({ id: `default-${i}`, label, displayOrder: i, metadata: { probability: '0.5' } })),
    groups: new Set(['deals:dealinformation', 'contacts:contactinformation']),
    properties: new Map(),
    failNext: [],
  };

  const json = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  hs.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname;
    hs.calls.push({ method, path, body });
    const fail = hs.failNext.shift();
    if (fail) return json(fail, { message: 'failing on purpose' });
    if (!String((init?.headers as Record<string, string>)?.Authorization ?? '').startsWith('Bearer pat-')) return json(401);

    let m: RegExpMatchArray | null;
    if (method === 'GET' && path === '/account-info/v3/details') return json(200, { portalId: Number(hs.portalId) });

    if (method === 'POST' && path === '/crm/v3/objects/contacts/batch/upsert') {
      const input0 = body.inputs[0];
      const existing = hs.contacts.get(input0.id);
      const c = existing ?? { id: id(), properties: {} };
      c.properties = { ...c.properties, ...input0.properties };
      hs.contacts.set(input0.id, c);
      return json(200, { results: [{ id: c.id }] });
    }
    if (method === 'POST' && path === '/crm/v3/objects/contacts/gdpr-delete') {
      for (const [k, c] of hs.contacts) if (c.id === body.objectId) hs.contacts.delete(k);
      return json(204);
    }
    if (method === 'POST' && path === '/crm/v3/objects/deals/search') {
      const want = body.filterGroups[0].filters[0].value;
      const found = [...hs.deals].find(([, d]) => d.properties.pmp_reference === want);
      return json(200, { results: found ? [{ id: found[0] }] : [] });
    }
    if (method === 'POST' && path === '/crm/v3/objects/deals') {
      const dealId = id();
      hs.deals.set(dealId, { properties: body.properties, contacts: new Set((body.associations ?? []).map((a: { to: { id: string } }) => a.to.id)) });
      return json(201, { id: dealId });
    }
    if ((m = path.match(/^\/crm\/v3\/objects\/deals\/(\d+)$/))) {
      const d = hs.deals.get(m[1]!);
      if (!d) return json(404);
      if (method === 'PATCH') {
        d.properties = { ...d.properties, ...body.properties };
        return json(200, { id: m[1] });
      }
      if (method === 'DELETE') {
        hs.deals.delete(m[1]!);
        return json(204);
      }
    }
    if (method === 'PUT' && (m = path.match(/^\/crm\/v4\/objects\/deals\/(\d+)\/associations\/default\/contacts\/(\d+)$/))) {
      hs.deals.get(m[1]!)?.contacts.add(m[2]!);
      return json(200, {});
    }

    if (path === '/crm/v3/pipelines/deals/default' && method === 'GET') {
      return json(200, { id: 'default', stages: [...hs.stages].sort((a, b) => a.displayOrder - b.displayOrder) });
    }
    if (path === '/crm/v3/pipelines/deals/default/stages' && method === 'POST') {
      const s: Stage = { id: id(), label: body.label, displayOrder: body.displayOrder, metadata: body.metadata };
      hs.stages.push(s);
      return json(201, s);
    }
    if ((m = path.match(/^\/crm\/v3\/pipelines\/deals\/default\/stages\/([\w-]+)$/)) && method === 'PATCH') {
      const s = hs.stages.find((x) => x.id === m![1]);
      if (!s) return json(404);
      Object.assign(s, body);
      return json(200, s);
    }

    // Properties and their groups, per object (deals, contacts): kept as "<object>:<name>".
    if ((m = path.match(/^\/crm\/v3\/properties\/(deals|contacts)\/groups$/))) {
      const object = m[1]!;
      if (method === 'GET') {
        return json(200, { results: [...hs.groups].filter((g) => g.startsWith(`${object}:`)).map((g) => ({ name: g.slice(object.length + 1) })) });
      }
      hs.groups.add(`${object}:${body.name}`);
      return json(201, body);
    }
    if ((m = path.match(/^\/crm\/v3\/properties\/(deals|contacts)$/)) && method === 'POST') {
      hs.properties.set(`${m[1]}:${body.name}`, body);
      return json(201, body);
    }
    if ((m = path.match(/^\/crm\/v3\/properties\/(deals|contacts)\/(\w+)$/))) {
      const p = hs.properties.get(`${m[1]}:${m[2]}`);
      if (!p) return json(404);
      if (method === 'PATCH') Object.assign(p, body);
      return json(200, p);
    }
    return json(404, { message: `fake HubSpot has no ${method} ${path}` });
  }) as typeof fetch;

  return hs;
}
