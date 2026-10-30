/**
 * Return-postage data (SCRUM-81): Australia Post Parcel Post, posted in Sydney, plus how we pack.
 *
 * DATA ONLY. Each table is in force from its date; Australia Post changes prices each July, so add
 * a new entry then (copy the last one, change what changed) and never edit an old one: accepted
 * orders keep the postage they were quoted, but quotes for a past date must stay reproducible.
 *
 * Source: Australia Post, "Domestic Parcel Post charges as at 1 July 2026, posted in Sydney (N1)"
 * (parcel-post-guide-ms101-syd-n1.pdf), Tables 1–3, read 30 Oct 2026.
 *
 * Paddle size and weight: the largest regulation paddle (17 in / 43.2 cm long, ~21 cm wide,
 * ~2 cm thick with an edge guard, 200–255 g) plus 10% each way for packing (Attila, 30 Oct 2026).
 * Packaging costs are estimates (per unit, from pack prices) until Attila buys stock.
 */

export type Zone = 'N1' | 'N2' | 'V1' | 'V2' | 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'S1' | 'S2' | 'NT1' | 'W1' | 'W2' | 'W3' | 'T1' | 'NF';

export const ZONES: readonly Zone[] = ['N1', 'N2', 'V1', 'V2', 'Q1', 'Q2', 'Q3', 'Q4', 'S1', 'S2', 'NT1', 'W1', 'W2', 'W3', 'T1', 'NF'];

/** One way of packing: used for paddle counts from minPaddles to maxPaddles. Sizes in cm, weights in kg. */
export interface Packing {
  name: string;
  minPaddles: number;
  maxPaddles: number;
  lengthCm: number;
  widthCm: number;
  /** Depth when empty (padding, walls); each paddle adds the paddle's thickness. */
  baseDepthCm: number;
  tareKg: number;
  /** What the packaging and fill cost us, added to the postage. */
  costCents: number;
}

export interface PostageTable {
  from: string;
  source: string;
  /**
   * 'cubic': charge on the greater of actual and cubic weight (Australia Post may apply it to any
   * own-packaging parcel; safe). 'actual': actual weight only (cheaper; a counter may still cube).
   */
  basis: 'cubic' | 'actual';
  /** Cubic weight = volume in m³ × this (Australia Post: 250). */
  cubicFactor: number;
  paddle: { lengthCm: number; widthCm: number; thicknessCm: number; weightKg: number };
  packings: readonly Packing[];
  /** Up to 5 kg: one national price. Ascending upper limits in kg. */
  flat: readonly { upToKg: number; cents: number }[];
  /** Over 5 kg: whole-kg bands (over N-1 up to N kg), a price per destination zone. */
  byZone: readonly { upToKg: number; cents: Readonly<Record<Zone, number>> }[];
  /** Destination zone by postcode (Table 3). A postcode in two zones takes the cheaper charge. */
  zones: readonly { zone: Zone; ranges: readonly (readonly [number, number])[] }[];
}

const row = (upToKg: number, ...dollars: number[]) => {
  if (dollars.length !== ZONES.length) throw new Error(`postage row ${upToKg} kg has ${dollars.length} zones`);
  return { upToKg, cents: Object.fromEntries(ZONES.map((z, i) => [z, Math.round(dollars[i]! * 100)])) as Record<Zone, number> };
};

export const POSTAGE_TABLES: readonly PostageTable[] = [
  {
    from: '2026-07-01',
    source: 'Australia Post Parcel Post charges as at 1 July 2026, posted in Sydney (N1)',
    basis: 'cubic',
    cubicFactor: 250,
    paddle: { lengthCm: 47.5, widthCm: 23, thicknessCm: 2.2, weightKg: 0.28 },
    packings: [
      // A padded bag about 48 × 36 cm (e.g. Jiffy #7) for one or two paddles: ~A$2 each.
      { name: 'padded bag', minPaddles: 1, maxPaddles: 2, lengthCm: 50, widthCm: 36, baseDepthCm: 1.5, tareKg: 0.08, costCents: 200 },
      // A box about 50 × 25 cm, as deep as the paddles need, with bubble wrap: ~A$3.50 each.
      { name: 'box', minPaddles: 3, maxPaddles: 10, lengthCm: 50, widthCm: 25, baseDepthCm: 3, tareKg: 0.45, costCents: 350 },
    ],
    flat: [
      { upToKg: 0.25, cents: 1020 },
      { upToKg: 0.5, cents: 1170 },
      { upToKg: 1, cents: 1600 },
      { upToKg: 3, cents: 2025 },
      { upToKg: 5, cents: 2445 },
    ],
    //               N1     N2     V1     V2     Q1     Q2     Q3     Q4     S1     S2     NT1    W1     W2     W3     T1     NF
    byZone: [
      row(6,  24.70, 26.50, 26.30, 27.00, 26.30, 27.60, 29.30, 29.75, 26.90, 28.75, 33.40, 29.45, 33.25, 33.50, 28.35, 30.65),
      row(7,  24.95, 28.55, 28.15, 29.55, 28.15, 30.75, 34.15, 35.05, 29.35, 33.05, 42.35, 34.45, 42.05, 42.55, 32.25, 36.85),
      row(8,  25.20, 30.60, 30.00, 32.10, 30.00, 33.90, 39.00, 40.35, 31.80, 37.35, 51.30, 39.45, 50.85, 51.60, 36.15, 43.05),
      row(9,  25.45, 32.65, 31.85, 34.65, 31.85, 37.05, 43.85, 45.65, 34.25, 41.65, 60.25, 44.45, 59.65, 60.65, 40.05, 49.25),
      row(10, 25.70, 34.70, 33.70, 37.20, 33.70, 40.20, 48.70, 50.95, 36.70, 45.95, 69.20, 49.45, 68.45, 69.70, 43.95, 55.45),
      row(11, 25.95, 36.75, 35.55, 39.75, 35.55, 43.35, 53.55, 56.25, 39.15, 50.25, 78.15, 54.45, 77.25, 78.75, 47.85, 61.65),
      row(12, 26.20, 38.80, 37.40, 42.30, 37.40, 46.50, 58.40, 61.55, 41.60, 54.55, 87.10, 59.45, 86.05, 87.80, 51.75, 67.85),
    ],
    zones: [
      { zone: 'N1', ranges: [[1000, 2263], [2500, 2530], [2555, 2574], [2740, 2786], [2890, 2890]] },
      {
        zone: 'N2',
        ranges: [[200, 299], [2264, 2484], [2485, 2486], [2487, 2499], [2531, 2554], [2575, 2639], [2640, 2641], [2642, 2647], [2649, 2714], [2716, 2716],
          [2720, 2730], [2787, 2879], [2881, 2889], [2891, 2898], [2900, 2999], [3689, 3690], [4225, 4225]],
      },
      { zone: 'NF', ranges: [[2899, 2899]] },
      { zone: 'V1', ranges: [[3000, 3220], [3335, 3341], [3425, 3443], [3750, 3811], [3910, 3920], [3926, 3944], [3972, 3978], [3980, 3983], [8000, 8999]] },
      {
        zone: 'V2',
        ranges: [[2640, 2641], [2648, 2648], [2715, 2715], [2717, 2719], [2731, 2739], [3221, 3334], [3342, 3424], [3444, 3688], [3689, 3690], [3691, 3749],
          [3812, 3909], [3921, 3925], [3945, 3971], [3979, 3979], [3984, 3999]],
      },
      { zone: 'Q1', ranges: [[2485, 2486], [4000, 4224], [4225, 4225], [4226, 4299], [4500, 4549], [9000, 9299], [9400, 9596], [9700, 9799]] },
      { zone: 'Q2', ranges: [[4300, 4449], [4550, 4699], [9597, 9599], [9880, 9919]] },
      { zone: 'Q3', ranges: [[4450, 4499], [4700, 4805], [9920, 9959]] },
      { zone: 'Q4', ranges: [[4806, 4899]] },
      { zone: 'S1', ranges: [[5000, 5199], [5800, 5999]] },
      // Broken Hill (2880) is treated as South Australia.
      { zone: 'S2', ranges: [[2880, 2880], [5200, 5749]] },
      { zone: 'NT1', ranges: [[800, 999]] },
      { zone: 'W1', ranges: [[6000, 6214], [6800, 6999]] },
      { zone: 'W2', ranges: [[6215, 6699]] },
      { zone: 'W3', ranges: [[6700, 6797]] },
      { zone: 'T1', ranges: [[7000, 7150], [7155, 7999]] },
    ],
  },
];
