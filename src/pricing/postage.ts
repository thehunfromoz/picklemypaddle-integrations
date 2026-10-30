/**
 * Return postage, worked out from size and weight (SCRUM-81; decided 30 Oct 2026).
 *
 * For N paddles going back to a postcode: choose the packing for N, work out its size and weight,
 * charge on the greater of actual and cubic weight (or actual only, per the table's basis), find
 * the Australia Post price (one national price up to 5 kg; by destination zone above), and add
 * what the packaging costs. The result pre-fills Accept in admin; Attila can override it there,
 * with a reason. If no price can be found (a postcode outside the table, or too heavy) the quote
 * says why and Accept needs the amount typed in.
 */
import { POSTAGE_TABLES, type Packing, type PostageTable, type Zone } from './postage-data.js';

export interface PostageQuote {
  ok: true;
  cents: number;
  postageCents: number;
  packagingCents: number;
  packing: string;
  actualKg: number;
  cubicKg: number;
  chargeableKg: number;
  /** Only when over 5 kg (the price depends on where it goes). */
  zone?: Zone;
  /** Which table: its date. Saved with the order. */
  table: string;
  basis: PostageTable['basis'];
}

export interface PostageRefusal {
  ok: false;
  reason: string;
}

export function postageTableOn(date: string, tables: readonly PostageTable[] = POSTAGE_TABLES): PostageTable {
  let found: PostageTable | undefined;
  for (const t of tables) if (t.from <= date && (!found || t.from > found.from)) found = t;
  if (!found) throw new Error(`no postage table in force on ${date}`);
  return found;
}

/** The destination zones for a postcode (two for a few border postcodes), or none. */
export function zonesFor(postcode: string, table: PostageTable): Zone[] {
  if (!/^\d{4}$/.test(postcode)) return [];
  const n = Number(postcode);
  return table.zones.filter((z) => z.ranges.some(([lo, hi]) => n >= lo && n <= hi)).map((z) => z.zone);
}

/** Up to the next 10 g, so a parcel is never priced into a lighter band than it is (float noise aside). */
const round2 = (kg: number) => Math.ceil(kg * 100 - 1e-6) / 100;

export function packingFor(paddles: number, table: PostageTable): Packing | undefined {
  return table.packings.find((p) => paddles >= p.minPaddles && paddles <= p.maxPaddles);
}

export function quotePostage(paddles: number, postcode: string, date: string, tables: readonly PostageTable[] = POSTAGE_TABLES): PostageQuote | PostageRefusal {
  const table = postageTableOn(date, tables);
  if (!Number.isInteger(paddles) || paddles < 1) return { ok: false, reason: 'No paddles to post.' };
  const packing = packingFor(paddles, table);
  if (!packing) return { ok: false, reason: `No packing is set up for ${paddles} paddles: enter the postage.` };

  const depthCm = packing.baseDepthCm + paddles * table.paddle.thicknessCm;
  const actualKg = round2(packing.tareKg + paddles * table.paddle.weightKg);
  const cubicKg = round2(((packing.lengthCm * packing.widthCm * depthCm) / 1_000_000) * table.cubicFactor);
  const chargeableKg = table.basis === 'cubic' ? Math.max(actualKg, cubicKg) : actualKg;

  const base = { packing: packing.name, actualKg, cubicKg, chargeableKg, table: table.from, basis: table.basis, packagingCents: packing.costCents };
  const flat = table.flat.find((b) => chargeableKg <= b.upToKg);
  if (flat) return { ok: true, ...base, postageCents: flat.cents, cents: flat.cents + packing.costCents };

  const band = table.byZone.find((b) => chargeableKg <= b.upToKg);
  if (!band) return { ok: false, reason: `Over ${table.byZone[table.byZone.length - 1]?.upToKg ?? 5} kg: enter the postage.` };
  const zones = zonesFor(postcode, table);
  if (zones.length === 0) return { ok: false, reason: `Postcode ${postcode} isn’t in Australia Post’s zone table: enter the postage.` };
  // A postcode in two zones takes the cheaper charge (Table 3).
  const zone = zones.reduce((best, z) => (band.cents[z] < band.cents[best] ? z : best));
  return { ok: true, ...base, zone, postageCents: band.cents[zone], cents: band.cents[zone] + packing.costCents };
}

/** For the website: the postage for each paddle count, as a single price or a range by zone. */
export function postageGuide(date: string, tables: readonly PostageTable[] = POSTAGE_TABLES): { paddles: number; minCents: number; maxCents: number }[] {
  const table = postageTableOn(date, tables);
  const max = Math.max(...table.packings.map((p) => p.maxPaddles));
  const out: { paddles: number; minCents: number; maxCents: number }[] = [];
  for (let n = 1; n <= max; n++) {
    const prices = table.zones
      .map((z) => quotePostage(n, String(z.ranges[0]![0]).padStart(4, '0'), date, tables))
      .filter((q): q is PostageQuote => q.ok)
      .map((q) => q.cents);
    if (prices.length) out.push({ paddles: n, minCents: Math.min(...prices), maxCents: Math.max(...prices) });
  }
  return out;
}
