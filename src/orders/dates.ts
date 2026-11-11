/**
 * Calendar dates for the turnaround promise: back in the post within 10 business days of the
 * paddles arriving (decided 6 Oct 2026).
 *
 * Business days skip weekends and NSW public holidays (SCRUM-73, ./holidays.ts). Dates are plain
 * YYYY-MM-DD calendar dates in Sydney, counted with UTC arithmetic so daylight-saving changes
 * can never shift a day; only "today" depends on the moment, and sydneyDate reads it in Sydney.
 */
import { NSW_HOLIDAY_DATES } from './holidays.js';

/**
 * The default turnaround, in business days: the ONE place to change it. Emails and the club
 * agreement read it; the website's copy says "usually 10" in `siteData` (a test there fails if
 * this number moves without it). Attila can set another number for one order or batch when he
 * accepts it, within TURNAROUND_MIN to TURNAROUND_MAX (SCRUM-105).
 */
export const TURNAROUND_BUSINESS_DAYS = 10;
export const TURNAROUND_MIN = 1;
/** About three months of business days. */
export const TURNAROUND_MAX = 65;

/** A turnaround typed in a form or sent: a whole number from TURNAROUND_MIN to TURNAROUND_MAX, or null. */
export function parseTurnaround(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,3}$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isInteger(n) && n >= TURNAROUND_MIN && n <= TURNAROUND_MAX ? n : null;
}

/** Today's date in Sydney, as YYYY-MM-DD. */
export function sydneyDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The calendar date `days` business days after `start` (YYYY-MM-DD in, YYYY-MM-DD out). */
export function addBusinessDays(start: string, days: number, holidays: ReadonlySet<string> = NSW_HOLIDAY_DATES): string {
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

export const backInPostBy = (arrivedOn: string, days: number = TURNAROUND_BUSINESS_DAYS) => addBusinessDays(arrivedOn, days);

/** Is this calendar date a business day (not a weekend, not an NSW public holiday)? */
export function isBusinessDay(iso: string, holidays: ReadonlySet<string> = NSW_HOLIDAY_DATES): boolean {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays.has(iso);
}

/**
 * How a promise date stands today (SCRUM-73 AC5): 'late' once it has passed, 'soon' when it is
 * at most 2 business days away, otherwise 'ok'.
 */
export function promiseState(promiseOn: string, now: Date): 'ok' | 'soon' | 'late' {
  const today = sydneyDate(now);
  if (today > promiseOn) return 'late';
  return addBusinessDays(today, 2) >= promiseOn ? 'soon' : 'ok';
}
