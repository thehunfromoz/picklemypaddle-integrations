/**
 * Prices, GST and return postage (SCRUM-81): the pure rules, with no database.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { POSTAGE_TABLES, ZONES, type PostageTable } from '../src/pricing/postage-data.js';
import { postageGuide, postageTableOn, quotePostage, zonesFor, type PostageQuote } from '../src/pricing/postage.js';
import { gstIncluded, isValidAbn, priceListOn, priceNote, taxWording, termsOn } from '../src/pricing/terms.js';

const DAY = '2026-10-30';
const ok = (q: ReturnType<typeof quotePostage>): PostageQuote => {
  if (!q.ok) throw new Error(`expected a quote, got: ${q.reason}`);
  return q;
};

describe('terms on a date', () => {
  const tax = { gstRegisteredFrom: '2027-03-01' };

  it('is A$60 a paddle and A$54 for clubs', () => {
    const t = termsOn(DAY, { gstRegisteredFrom: null });
    expect([t.pricePerPaddleCents, t.clubRemitPerPaddleCents, t.treatment]).toEqual([6000, 5400, 'not_registered']);
    expect(t.version).toBe('price:2026-01-01;gst:none');
  });

  it('switches to GST-inclusive on the registration day, not the day before', () => {
    expect(termsOn('2027-02-28', tax).treatment).toBe('not_registered');
    expect(termsOn('2027-03-01', tax).treatment).toBe('gst_inclusive');
    expect(termsOn('2027-03-02', tax).treatment).toBe('gst_inclusive');
    expect(termsOn('2027-03-01', tax).version).toBe('price:2026-01-01;gst:from-2027-03-01');
    // The price itself doesn't change: A$60 includes the GST from that day.
    expect(termsOn('2027-03-01', tax).pricePerPaddleCents).toBe(6000);
  });

  it('takes the latest price list in force, and refuses a date before any', () => {
    const lists = [
      { from: '2026-01-01', pricePerPaddleCents: 6000, clubRemitPerPaddleCents: 5400 },
      { from: '2027-07-01', pricePerPaddleCents: 6500, clubRemitPerPaddleCents: 5850 },
    ];
    expect(priceListOn('2027-06-30', lists).pricePerPaddleCents).toBe(6000);
    expect(priceListOn('2027-07-01', lists).pricePerPaddleCents).toBe(6500);
    expect(() => priceListOn('2025-12-31', lists)).toThrow(/no price list/);
  });

  it('works out the GST included as one eleventh, to the nearest cent, only once registered', () => {
    expect(gstIncluded(6000, 'gst_inclusive')).toBe(545);
    expect(gstIncluded(7350, 'gst_inclusive')).toBe(668);
    expect(gstIncluded(8225, 'gst_inclusive')).toBe(748);
    expect(gstIncluded(6000, 'not_registered')).toBe(0);
  });

  it('words documents as "Invoice" with no GST before registration, never "tax invoice"', () => {
    const before = taxWording('not_registered', 8225);
    expect(before).toEqual({ heading: 'Invoice', gstLine: 'No GST has been charged' });
    expect(JSON.stringify(before).toLowerCase()).not.toContain('tax invoice');
    expect(taxWording('gst_inclusive', 8225)).toEqual({ heading: 'Tax invoice', gstLine: 'Total includes GST of A$7.48' });
    expect(priceNote('not_registered')).toMatch(/No GST/);
    expect(priceNote('gst_inclusive')).toBe('Prices include GST.');
  });

  it('checks ABNs with the ATO checksum', () => {
    expect(isValidAbn('51 824 753 556')).toBe(true);
    expect(isValidAbn('51824753557')).toBe(false);
    expect(isValidAbn('5182475355')).toBe(false);
    expect(isValidAbn('abcdefghijk')).toBe(false);
  });
});

describe('return postage', () => {
  // The cubic rules stay in the code for when they're needed again (post launch).
  const cubic: PostageTable[] = [{ ...POSTAGE_TABLES[0]!, basis: 'cubic' }];

  it('uses the 1 July 2026 table, on actual weight, and has 16 zones of prices in every band over 5 kg', () => {
    expect(postageTableOn(DAY).from).toBe('2026-07-01');
    expect(postageTableOn(DAY).basis).toBe('actual');
    for (const band of POSTAGE_TABLES[0]!.byZone) expect(Object.keys(band.cents).sort()).toEqual([...ZONES].sort());
  });

  it('prices 1–10 paddles on actual weight, absorbing the packaging for a single paddle (decided 2 Nov 2026)', () => {
    const expected: Record<number, [string, number, number, number]> = {
      // paddles: [packing, chargeable kg, Australia Post cents, packaging charged cents]
      1: ['padded bag', 0.36, 1170, 0],
      2: ['padded bag', 0.64, 1600, 200],
      3: ['box', 1.29, 2025, 350],
      5: ['box', 1.85, 2025, 350],
      9: ['box', 2.97, 2025, 350],
      10: ['box', 3.25, 2445, 350],
    };
    for (const [n, [packing, kg, postage, packaging]] of Object.entries(expected)) {
      const q = ok(quotePostage(Number(n), '2000', DAY));
      expect([q.packing, q.chargeableKg, q.postageCents, q.packagingCents], `${n} paddles`).toEqual([packing, kg, postage, packaging]);
      expect(q.cents).toBe(postage + packaging);
    }
    const one = ok(quotePostage(1, '2000', DAY));
    expect([one.cents, one.packagingCostCents]).toEqual([1170, 200]); // A$11.70; the A$2 bag is on us
  });

  it('is one national price for every order up to 10 paddles (all under 5 kg on actual weight)', () => {
    for (let n = 1; n <= 10; n++) {
      expect(ok(quotePostage(n, '6725', DAY)).cents, `${n} paddles`).toBe(ok(quotePostage(n, '2000', DAY)).cents);
      expect(ok(quotePostage(n, '6725', DAY)).zone).toBeUndefined();
    }
  });

  it('on cubic weight, goes over 5 kg for big boxes and prices them by zone', () => {
    expect([ok(quotePostage(1, '2000', DAY, cubic)).chargeableKg, ok(quotePostage(1, '2000', DAY, cubic)).postageCents]).toEqual([1.67, 2025]);
    const far = ok(quotePostage(10, '6725', DAY, cubic)); // Broome, WA: zone W3
    expect([far.chargeableKg, far.zone, far.postageCents]).toEqual([7.82, 'W3', 5160]);
    expect(ok(quotePostage(10, '0800', DAY, cubic)).zone).toBe('NT1');
  });

  it('maps postcodes to zones, taking the cheaper of two for border postcodes', () => {
    const table = postageTableOn(DAY);
    expect(zonesFor('2000', table)).toEqual(['N1']);
    expect(zonesFor('2880', table)).toEqual(['S2']); // Broken Hill counts as SA
    expect(zonesFor('2485', table).sort()).toEqual(['N2', 'Q1']);
    expect(zonesFor('6798', table)).toEqual([]); // Christmas Island: not in the table
    expect(zonesFor('20000', table)).toEqual([]);
    const tweed = ok(quotePostage(10, '2485', DAY, cubic));
    expect([tweed.zone, tweed.postageCents]).toEqual(['Q1', 3000]); // 8 kg band: N2 30.60, Q1 30.00
  });

  it('refuses (so Accept needs a typed amount) when it can’t price the parcel', () => {
    expect(quotePostage(10, '6798', DAY, cubic)).toMatchObject({ ok: false, reason: expect.stringMatching(/zone table/) });
    expect(quotePostage(11, '2000', DAY)).toMatchObject({ ok: false, reason: expect.stringMatching(/No packing/) });
    expect(quotePostage(0, '2000', DAY).ok).toBe(false);
    // Under 5 kg a postcode outside the zone table is fine (one national price).
    expect(ok(quotePostage(10, '6798', DAY)).cents).toBe(2795);
  });

  it('gives the website one price per paddle count', () => {
    const guide = postageGuide(DAY);
    expect(guide.map((g) => g.paddles)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(guide[0]).toEqual({ paddles: 1, minCents: 1170, maxCents: 1170 });
    expect(guide[1]).toEqual({ paddles: 2, minCents: 1800, maxCents: 1800 });
    expect(guide[9]).toEqual({ paddles: 10, minCents: 2795, maxCents: 2795 });
  });
});

describe('pricing settings', () => {
  const base = { APP_ENV: 'staging', DATABASE_URL: 'postgres://u:p@db:5432/pmp', PUBLIC_SITE_ORIGIN: 'http://home-server:8088', EMAIL_ALLOWLIST: 'a@example.com' };
  const problems = (env: Record<string, string>) => {
    try {
      loadConfig({ ...base, ...env });
      return [];
    } catch (err) {
      return (err as { problems: string[] }).problems;
    }
  };

  it('accepts a real date and ABN, and refuses bad ones by name without echoing them', () => {
    expect(problems({ GST_REGISTERED_FROM: '2027-03-01', BUSINESS_ABN: '51 824 753 556' })).toEqual([]);
    expect(problems({ GST_REGISTERED_FROM: '2027-02-30' })).toEqual(['GST_REGISTERED_FROM must be a real calendar date (YYYY-MM-DD)']);
    expect(problems({ GST_REGISTERED_FROM: '1/3/2027' })[0]).toMatch(/^GST_REGISTERED_FROM must be a date/);
    const abn = problems({ BUSINESS_ABN: '51824753557' });
    expect(abn).toEqual(['BUSINESS_ABN must be a valid 11-digit ABN']);
    expect(abn.join()).not.toContain('51824753557');
  });

  it('lets staging try a GST date without an ABN, but not production', () => {
    expect(problems({ GST_REGISTERED_FROM: '2027-03-01' })).toEqual([]);
    const prod = problems({ APP_ENV: 'production', RESEND_API_KEY: 're_x', GST_REGISTERED_FROM: '2027-03-01' });
    expect(prod.some((p) => p.startsWith('BUSINESS_ABN is required in production when GST_REGISTERED_FROM'))).toBe(true);
  });

  it('needs the ABN in production once Stripe is set up', () => {
    const key = ['sk', 'live', 'abc123'].join('_');
    const secret = ['whsec', 'abc123'].join('_');
    const prod = problems({ APP_ENV: 'production', RESEND_API_KEY: 're_x', STRIPE_SECRET_KEY: key, STRIPE_WEBHOOK_SECRET: secret });
    expect(prod.some((p) => p.startsWith('BUSINESS_ABN is required in production once STRIPE_SECRET_KEY'))).toBe(true);
    expect(problems({ APP_ENV: 'production', RESEND_API_KEY: 're_x', STRIPE_SECRET_KEY: key, STRIPE_WEBHOOK_SECRET: secret, BUSINESS_ABN: '51824753556' })).toEqual([]);
  });

  it('names the seller PickleMyPaddle unless BUSINESS_NAME says otherwise, and refuses a placeholder (SCRUM-84)', () => {
    expect(loadConfig(base).BUSINESS_NAME).toBe('PickleMyPaddle');
    expect(loadConfig({ ...base, BUSINESS_NAME: '  Pickle My Paddle  ' }).BUSINESS_NAME).toBe('Pickle My Paddle');
    expect(problems({ BUSINESS_NAME: '[To confirm: name]' })).toEqual(['BUSINESS_NAME still says [To confirm…]']);
  });
});
