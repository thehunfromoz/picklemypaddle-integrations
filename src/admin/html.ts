/**
 * A tiny HTML builder for the admin pages (SCRUM-72). Everything interpolated into `html` is
 * escaped unless it is itself the result of `html` (or `raw`), so customer-typed text can never
 * become markup. No client-side script anywhere: the admin's CSP allows none.
 */

export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

/** Trusted markup only: never pass anything a customer typed. */
export const raw = (markup: string) => new Html(markup);

function part(value: unknown): string {
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(part).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? '';
  values.forEach((v, i) => {
    out += part(v) + (strings[i + 1] ?? '');
  });
  return new Html(out);
}

const SYDNEY_DATETIME = new Intl.DateTimeFormat('en-AU', {
  timeZone: 'Australia/Sydney',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const SYDNEY_DATE = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', day: 'numeric', month: 'short', year: 'numeric' });

export const when = (at: Date | string) => SYDNEY_DATETIME.format(new Date(at));
export const day = (at: Date | string) => SYDNEY_DATE.format(new Date(at));

/** A calendar date (YYYY-MM-DD) shown as e.g. 16 Nov 2026, without a time-zone shift. */
export function calendarDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

export const dollars = (cents: number) => `A$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
