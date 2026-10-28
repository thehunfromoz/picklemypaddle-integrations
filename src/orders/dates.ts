/**
 * Calendar dates for the turnaround promise: back in the post within 10 business days of the
 * paddles arriving (decided 6 Oct 2026).
 *
 * Business days here skip weekends and the dates in `holidays`. NSW public holidays arrive
 * with SCRUM-73 (queue position and "back in the post by"); until then none are skipped, so a
 * date that spans one is a day early. Dates are plain YYYY-MM-DD calendar dates in Sydney.
 */

export const TURNAROUND_BUSINESS_DAYS = 10;

/** Today's date in Sydney, as YYYY-MM-DD. */
export function sydneyDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The calendar date `days` business days after `start` (YYYY-MM-DD in, YYYY-MM-DD out). */
export function addBusinessDays(start: string, days: number, holidays: ReadonlySet<string> = new Set()): string {
  const [y, m, d] = start.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  let left = days;
  while (left > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const iso = date.toISOString().slice(0, 10);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !holidays.has(iso)) left--;
  }
  return date.toISOString().slice(0, 10);
}

export const backInPostBy = (arrivedOn: string) => addBusinessDays(arrivedOn, TURNAROUND_BUSINESS_DAYS);
