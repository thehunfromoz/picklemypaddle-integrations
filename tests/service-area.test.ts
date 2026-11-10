/** The service area check (SCRUM-102): the suburbs list decides a club's default method. */
import { describe, expect, it } from 'vitest';
import data from '../src/clubs/service-area-suburbs.json' with { type: 'json' };
import { checkServiceArea, defaultFulfilment, isInServiceArea, normaliseSuburb, SERVICE_AREA_SUBURBS, SERVICE_AREA_VERSION } from '../src/clubs/service-area.js';

describe('normalising', () => {
  it('ignores case, spaces, punctuation and a trailing NSW', () => {
    expect(normaliseSuburb('  CARINGBAH   ')).toBe('caringbah');
    expect(normaliseSuburb('Bateau   Bay, NSW'.replace(',', ''))).toBe('bateau bay');
    expect(normaliseSuburb('Terrigal NSW')).toBe('terrigal');
    expect(normaliseSuburb('Mt. Druitt')).toBe('mount druitt');
  });
  it('treats St and Saint, Mt and Mount as the same', () => {
    expect(normaliseSuburb('St Marys')).toBe(normaliseSuburb('Saint Marys'));
    expect(normaliseSuburb('Mt Druitt')).toBe(normaliseSuburb('Mount Druitt'));
  });
});

describe('matching', () => {
  it('real examples: inside the area are local', () => {
    for (const [suburb, postcode] of [['Hornsby', '2077'], ['Epping', '2121'], ['Manly', '2095'], ['Castle Hill', '2154']] as const) {
      expect(isInServiceArea({ suburb, postcode })).toBe(true);
      expect(defaultFulfilment({ suburb, postcode })).toBe('local');
    }
  });
  it('real examples: outside are postal', () => {
    for (const [suburb, postcode] of [['Campbelltown', '2560'], ['Mount Annan', '2567'], ['Milperra', '2214'], ['Terrigal', '2260']] as const) {
      expect(isInServiceArea({ suburb, postcode })).toBe(false);
      expect(defaultFulfilment({ suburb, postcode })).toBe('postal');
    }
  });
  it('matches whatever the case, spacing, Saint/St or Mount/Mt', () => {
    expect(isInServiceArea({ suburb: ' hornsby ', postcode: '2077' })).toBe(true);
    expect(isInServiceArea({ suburb: 'SAINT IVES', postcode: '2075' })).toBe(true);
    expect(isInServiceArea({ suburb: 'Mt Colah NSW', postcode: '2079' })).toBe(true);
    expect(isInServiceArea({ suburb: 'Mount  Colah', postcode: ' 2079 ' })).toBe(true);
  });
  it('a suburb with two postcodes matches either', () => {
    const two = SERVICE_AREA_SUBURBS.find((s) => s.postcodes.length > 1)!;
    for (const postcode of two.postcodes) expect(isInServiceArea({ suburb: two.suburb, postcode })).toBe(true);
  });
  it('with no postcode, the name alone decides', () => {
    expect(isInServiceArea({ suburb: 'Hornsby' })).toBe(true);
    expect(isInServiceArea({ suburb: 'Hornsby', postcode: '' })).toBe(true);
    expect(isInServiceArea({ suburb: 'Campbelltown' })).toBe(false);
  });
  it('the right suburb with the wrong postcode is outside and flagged for review', () => {
    expect(checkServiceArea({ suburb: 'Hornsby', postcode: '2560' })).toEqual({ inside: false, reason: 'postcode_mismatch', needsReview: true });
    expect(defaultFulfilment({ suburb: 'Hornsby', postcode: '2560' })).toBe('postal');
  });
  it('an unknown suburb is postal, and is not flagged', () => {
    expect(checkServiceArea({ suburb: 'Nowhereville', postcode: '2000' })).toEqual({ inside: false, reason: 'unknown_suburb', needsReview: false });
    expect(isInServiceArea({ suburb: '' })).toBe(false);
  });
});

describe('the list', () => {
  it('is the JSON file, with its version and count, and every entry is matchable', () => {
    expect(SERVICE_AREA_VERSION).toBe(data.version);
    expect(data.count).toBe(data.suburbs.length);
    for (const s of data.suburbs) for (const p of s.postcodes) expect(isInServiceArea({ suburb: s.suburb, postcode: p })).toBe(true);
  });
  it('names no address or home suburb: only suburbs and postcodes', () => {
    for (const s of data.suburbs) expect(Object.keys(s).sort()).toEqual(['postcodes', 'state', 'suburb']);
  });
});
