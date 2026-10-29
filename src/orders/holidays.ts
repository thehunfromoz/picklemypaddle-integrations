/**
 * NSW public holidays (SCRUM-73), for the "back in the post by" promise.
 *
 * Source: https://nsw.gov.au/about-nsw/public-holidays (NSW Government), checked 29 Oct 2026.
 * That page publishes two years ahead; 2028 isn't out yet. Includes the additional days NSW
 * gives when a holiday falls on a weekend (Anzac Day too, from 2026). The August Bank Holiday is
 * left out: the page says it isn't a declared public holiday, and PickleMyPaddle works that day.
 *
 * Weekend dates are listed as published even though weekends are skipped anyway.
 *
 * KEEP IT CURRENT: tests/holidays.test.ts fails once this list doesn't cover the next 12 months
 * (from 1 Jan 2027 with the list below), so add the next year as soon as NSW publishes it.
 */

export interface PublicHoliday {
  date: string; // YYYY-MM-DD
  name: string;
}

export const NSW_PUBLIC_HOLIDAYS: readonly PublicHoliday[] = [
  { date: '2026-01-01', name: "New Year's Day" },
  { date: '2026-01-26', name: 'Australia Day' },
  { date: '2026-04-03', name: 'Good Friday' },
  { date: '2026-04-04', name: 'Easter Saturday' },
  { date: '2026-04-05', name: 'Easter Sunday' },
  { date: '2026-04-06', name: 'Easter Monday' },
  { date: '2026-04-25', name: 'Anzac Day' },
  { date: '2026-04-27', name: 'Anzac Day (additional day)' },
  { date: '2026-06-08', name: "King's Birthday" },
  { date: '2026-10-05', name: 'Labour Day' },
  { date: '2026-12-25', name: 'Christmas Day' },
  { date: '2026-12-26', name: 'Boxing Day' },
  { date: '2026-12-28', name: 'Boxing Day (additional day)' },

  { date: '2027-01-01', name: "New Year's Day" },
  { date: '2027-01-26', name: 'Australia Day' },
  { date: '2027-03-26', name: 'Good Friday' },
  { date: '2027-03-27', name: 'Easter Saturday' },
  { date: '2027-03-28', name: 'Easter Sunday' },
  { date: '2027-03-29', name: 'Easter Monday' },
  { date: '2027-04-25', name: 'Anzac Day' },
  { date: '2027-04-26', name: 'Anzac Day (additional day)' },
  { date: '2027-06-14', name: "King's Birthday" },
  { date: '2027-10-04', name: 'Labour Day' },
  { date: '2027-12-25', name: 'Christmas Day' },
  { date: '2027-12-26', name: 'Boxing Day' },
  { date: '2027-12-27', name: 'Christmas Day (additional day)' },
  { date: '2027-12-28', name: 'Boxing Day (additional day)' },
];

/** The last day the list is known to be complete for. */
export const HOLIDAYS_COVER_THROUGH = '2027-12-31';

export const NSW_HOLIDAY_DATES: ReadonlySet<string> = new Set(NSW_PUBLIC_HOLIDAYS.map((h) => h.date));
