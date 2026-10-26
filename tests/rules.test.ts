/** The shared order rules (SCRUM-65 AC2): one table of valid and invalid cases per field. */
import { describe, expect, it } from 'vitest';
import { ACCEPTED_PHOTO_TYPES, MAX_LENGTHS, MAX_PADDLES, validateOrder, validatePhoto, type OrderInput } from '../src/orders/rules.js';

const photo = { name: 'face.jpg', size: 500_000, type: 'image/jpeg' };
const valid = (): OrderInput => ({
  name: 'Test Player',
  email: 'test@example.com',
  phone: '',
  street: '1 Court St',
  suburb: 'Sydney',
  state: 'NSW',
  postcode: '2000',
  consent: true,
  tournamentAck: true,
  paddles: [{ brand: 'Selkirk', model: '', front: photo, back: photo }],
});

type Case = [field: keyof OrderInput, value: unknown, ok: boolean];
const cases: Case[] = [
  ['name', 'A', true], ['name', '  ', false], ['name', 'x'.repeat(MAX_LENGTHS.name + 1), false],
  ['email', 'a@b.co', true], ['email', 'nope', false], ['email', 'a b@c.d', false], ['email', `${'a'.repeat(250)}@b.co`, false],
  ['phone', '', true], ['phone', '0412 345 678', true], ['phone', '+61 2 9999 9999', true], ['phone', 'abc', false], ['phone', '1'.repeat(31), false],
  ['street', '1 Court St', true], ['street', '', false], ['street', 'x'.repeat(MAX_LENGTHS.street + 1), false],
  ['suburb', 'Manly', true], ['suburb', '', false],
  ['state', 'NSW', true], ['state', 'WA', true], ['state', 'nsw', false], ['state', 'XX', false], ['state', '', false],
  ['postcode', '2000', true], ['postcode', '0800', true], ['postcode', '200', false], ['postcode', '20000', false], ['postcode', 'abcd', false],
  ['consent', true, true], ['consent', false, false],
  ['tournamentAck', true, true], ['tournamentAck', false, false],
];

describe('validateOrder: each field', () => {
  for (const [field, value, ok] of cases) {
    it(`${field} = ${JSON.stringify(value).slice(0, 30)} is ${ok ? 'valid' : 'refused'}`, () => {
      const errors = validateOrder({ ...valid(), [field]: value });
      if (ok) expect(errors[field]).toBeUndefined();
      else expect(errors[field]).toBeDefined();
    });
  }

  it('accepts a complete order', () => expect(validateOrder(valid())).toEqual({}));

  it('needs 1 to 10 paddles', () => {
    const p = valid().paddles[0]!;
    expect(validateOrder({ ...valid(), paddles: [] }).paddles).toBeDefined();
    expect(validateOrder({ ...valid(), paddles: Array(MAX_PADDLES).fill(p) })).toEqual({});
    expect(validateOrder({ ...valid(), paddles: Array(MAX_PADDLES + 1).fill(p) }).paddles).toBeDefined();
  });

  it('reports paddle problems by position, with the form\'s keys', () => {
    const p = valid().paddles[0]!;
    const e = validateOrder({ ...valid(), paddles: [p, { brand: '', model: 'x'.repeat(81), front: null, back: { ...photo, type: 'image/heic' } }] });
    expect(Object.keys(e).sort()).toEqual(['paddles.1.back', 'paddles.1.brand', 'paddles.1.front', 'paddles.1.model']);
  });
});

describe('validatePhoto (SCRUM-66)', () => {
  it('accepts JPEG, PNG and WebP only: HEIC is left to iOS', () => {
    expect(ACCEPTED_PHOTO_TYPES).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    for (const type of ACCEPTED_PHOTO_TYPES) expect(validatePhoto({ ...photo, type }, 'front')).toBeNull();
    for (const type of ['image/heic', 'image/heif', 'image/svg+xml', 'application/pdf']) {
      expect(validatePhoto({ ...photo, type }, 'front')).toMatch(/JPEG, PNG or WebP/);
    }
  });

  it('refuses missing and over-10-MB photos', () => {
    expect(validatePhoto(null, 'front')).toMatch(/Add a photo/);
    expect(validatePhoto({ ...photo, size: 0 }, 'back')).toMatch(/Add a photo/);
    expect(validatePhoto({ ...photo, size: 10 * 1024 * 1024 + 1 }, 'back')).toMatch(/10 MB/);
  });
});
