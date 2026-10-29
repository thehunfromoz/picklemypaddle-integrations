/**
 * "Back in the post by" = arrival + 10 NSW business days (SCRUM-73 AC1, AC2, AC6).
 */
import { describe, expect, it } from 'vitest';
import { addBusinessDays, backInPostBy, isBusinessDay, promiseState, sydneyDate } from '../src/orders/dates.js';
import { HOLIDAYS_COVER_THROUGH, NSW_HOLIDAY_DATES, NSW_PUBLIC_HOLIDAYS } from '../src/orders/holidays.js';

describe('promise dates (arrival + 10 NSW business days)', () => {
  // Worked by hand against the NSW Government's list (src/orders/holidays.ts).
  it.each([
    ['an ordinary Friday', '2026-11-06', '2026-11-20'],
    ['a Saturday arrival counts from Monday', '2026-11-07', '2026-11-20'],
    ['over Christmas and New Year (25, 26 and the 28th, then 1 Jan)', '2026-12-18', '2027-01-06'],
    ['New Year’s Eve', '2026-12-31', '2027-01-15'],
    ['Easter 2026 (Good Friday and Easter Monday)', '2026-04-02', '2026-04-20'],
    ['Anzac Day on a Saturday: the additional Monday (27 Apr 2026)', '2026-04-20', '2026-05-05'],
    ['Easter 2027', '2027-03-25', '2027-04-12'],
    ["the King's Birthday (14 Jun 2027)", '2027-06-04', '2027-06-21'],
    ['the Labour Day long weekend, which is also the daylight-saving switch (4–5 Oct 2026)', '2026-10-02', '2026-10-19'],
    ['the August Bank Holiday is a working day (not a public holiday)', '2026-07-31', '2026-08-14'],
    // (Not one that runs into 2028: its holidays aren't published yet.)
    ['Christmas 2027 (the 27th and 28th are additional days)', '2027-12-15', '2027-12-31'],
  ])('%s: arrives %s → back in the post by %s', (_label, arrived, promise) => {
    expect(backInPostBy(arrived)).toBe(promise);
  });

  it('never lands on a weekend or a holiday', () => {
    for (let day = new Date(Date.UTC(2026, 0, 1)); day <= new Date(Date.UTC(2027, 11, 31)); day.setUTCDate(day.getUTCDate() + 1)) {
      const promise = backInPostBy(day.toISOString().slice(0, 10));
      expect(isBusinessDay(promise), `${day.toISOString().slice(0, 10)} → ${promise}`).toBe(true);
    }
  });
});

describe('Sydney dates across daylight-saving changes (AC6)', () => {
  it('reads "today" in Sydney on both sides of each switch', () => {
    // Clocks go forward at 2 am on Sunday 4 Oct 2026 (AEST +10 → AEDT +11).
    expect(sydneyDate(new Date('2026-10-03T14:30:00Z'))).toBe('2026-10-04'); // 00:30 AEST
    expect(sydneyDate(new Date('2026-10-04T12:59:00Z'))).toBe('2026-10-04'); // 23:59 AEDT
    expect(sydneyDate(new Date('2026-10-04T13:00:00Z'))).toBe('2026-10-05'); // 00:00 AEDT
    // Clocks go back at 3 am on Sunday 5 Apr 2026 (AEDT +11 → AEST +10).
    expect(sydneyDate(new Date('2026-04-04T13:30:00Z'))).toBe('2026-04-05'); // 00:30 AEDT
    expect(sydneyDate(new Date('2026-04-05T13:59:00Z'))).toBe('2026-04-05'); // 23:59 AEST
    expect(sydneyDate(new Date('2026-04-05T14:00:00Z'))).toBe('2026-04-06'); // 00:00 AEST
  });
});

describe('promise state for the admin (AC5)', () => {
  const at = (iso: string) => new Date(`${iso}T02:00:00Z`); // midday in Sydney
  it('is "soon" within 2 business days, "late" once passed', () => {
    expect(promiseState('2026-11-20', at('2026-11-16'))).toBe('ok'); // Mon, due Fri
    expect(promiseState('2026-11-20', at('2026-11-18'))).toBe('soon'); // Wed
    expect(promiseState('2026-11-20', at('2026-11-20'))).toBe('soon'); // the day itself
    expect(promiseState('2026-11-20', at('2026-11-23'))).toBe('late');
    // Counted in business days: due Monday, flagged from the Thursday before.
    expect(promiseState('2026-11-23', at('2026-11-18'))).toBe('ok');
    expect(promiseState('2026-11-23', at('2026-11-19'))).toBe('soon');
  });
});

describe('the holiday list (AC2)', () => {
  it('covers the next 12 months (update src/orders/holidays.ts when this fails)', () => {
    const yearAhead = sydneyDate(new Date(Date.now() + 366 * 24 * 60 * 60 * 1000));
    expect(
      yearAhead <= HOLIDAYS_COVER_THROUGH,
      `NSW public holidays are listed only to ${HOLIDAYS_COVER_THROUGH}; add the next year from nsw.gov.au/about-nsw/public-holidays`,
    ).toBe(true);
  });

  it('has the fixed holidays for every year it covers, in order, without duplicates', () => {
    const years = new Set(NSW_PUBLIC_HOLIDAYS.map((h) => h.date.slice(0, 4)));
    expect([...years].at(-1)).toBe(HOLIDAYS_COVER_THROUGH.slice(0, 4));
    for (const y of years) {
      for (const md of ['01-01', '01-26', '04-25', '12-25', '12-26']) expect(NSW_HOLIDAY_DATES.has(`${y}-${md}`), `${y}-${md}`).toBe(true);
    }
    const dates = NSW_PUBLIC_HOLIDAYS.map((h) => h.date);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it('is what addBusinessDays uses by default', () => {
    expect(addBusinessDays('2026-12-24', 2)).toBe('2026-12-30'); // skips 25, 26 (Sat), 27 (Sun), 28
  });
});
