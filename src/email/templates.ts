/**
 * Order email templates (SCRUM-69): the customer's key moments, Attila's alert and the
 * "email me my links" reply.
 *
 * Every template is written once as a list of blocks and rendered twice, as plain text and as
 * simple branded HTML (inline styles, no remote images, no tracking), so the two can't drift.
 * Every value from the order is escaped in the HTML.
 *
 * Copy is drafted by Claude and approved by Attila on staging (SCRUM-69 AC9). Facts not yet
 * known are written `[To confirm: …]`; production refuses to start while any template still
 * contains one (see `placeholdersIn` and server.ts).
 */
import { PRICE_PER_PADDLE_CENTS } from '../orders/model.js';

export const TEMPLATES = [
  'customer_submitted',
  'alert_submitted',
  'accepted',
  'in_queue',
  'posted_back',
  'rejected',
  'links',
] as const;
export type TemplateName = (typeof TEMPLATES)[number];

export interface PaddleFacts {
  brand: string;
  model: string | null;
}

/** Everything a template may use. Each template reads only what it needs. */
export interface TemplateContext {
  /** True outside production: [TEST] subjects and a banner (SCRUM-69 AC6). */
  test: boolean;
  /** The site, for the footer and links, e.g. https://www.picklemypaddle.com. */
  siteUrl: string;
  reference?: string;
  firstName?: string;
  paddles?: PaddleFacts[];
  /** The order's private status page, with a freshly minted token. */
  statusUrl?: string;
  /** Attila's tailnet admin link for this order; null until the admin exists (SCRUM-71/72). */
  adminUrl?: string | null;
  /** Accepted: total in cents, before return postage. */
  amountCents?: number;
  /** Accepted: Stripe payment link (SCRUM-9). */
  paymentUrl?: string;
  /** In queue: YYYY-MM-DD. */
  arrivedOn?: string;
  /** In queue: YYYY-MM-DD. */
  backInPostBy?: string;
  /** Posted back. */
  trackingNumber?: string;
  /** Rejected: Attila's reason, shown to the customer as typed. */
  reason?: string;
  /** Links: one per order. */
  links?: { reference: string; url: string }[];
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

// ── Blocks ────────────────────────────────────────────────────────────────────

type Block =
  | { p: string }
  | { h: string }
  | { list: string[] }
  | { kv: [string, string][] }
  | { button: { label: string; url: string } }
  | { quote: string }
  | { small: string };

const BRAND = { blue: '#4565A6', green: '#78A472', greenText: '#3F6B3E', ink: '#1E2E52', bg: '#FBFAF6' } as const;

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function toText(blocks: Block[]): string {
  return blocks
    .map((b) => {
      if ('p' in b) return b.p;
      if ('h' in b) return b.h.toUpperCase();
      if ('list' in b) return b.list.map((i) => `  - ${i}`).join('\n');
      if ('kv' in b) return b.kv.map(([k, v]) => `  ${k}: ${v}`).join('\n');
      if ('button' in b) return `${b.button.label}:\n${b.button.url}`;
      if ('quote' in b) return b.quote.split('\n').map((l) => `  > ${l}`).join('\n');
      return b.small;
    })
    .join('\n\n')
    .concat('\n');
}

const P = `margin:0 0 16px;font-size:16px;line-height:1.5;color:${BRAND.ink}`;

function toHtml(blocks: Block[], subject: string): string {
  const body = blocks
    .map((b) => {
      if ('p' in b) return `<p style="${P}">${escapeHtml(b.p).replace(/\n/g, '<br>')}</p>`;
      if ('h' in b) return `<h2 style="margin:24px 0 8px;font-size:17px;color:${BRAND.ink}">${escapeHtml(b.h)}</h2>`;
      if ('list' in b) {
        return `<ul style="margin:0 0 16px;padding-left:20px;color:${BRAND.ink}">${b.list
          .map((i) => `<li style="margin:0 0 4px;font-size:16px;line-height:1.5">${escapeHtml(i)}</li>`)
          .join('')}</ul>`;
      }
      if ('kv' in b) {
        return `<table role="presentation" style="margin:0 0 16px;border-collapse:collapse">${b.kv
          .map(
            ([k, v]) =>
              `<tr><td style="padding:2px 16px 2px 0;font-size:15px;color:${BRAND.ink};opacity:.75;vertical-align:top">${escapeHtml(k)}</td>` +
              `<td style="padding:2px 0;font-size:15px;color:${BRAND.ink};font-weight:600">${escapeHtml(v)}</td></tr>`,
          )
          .join('')}</table>`;
      }
      if ('button' in b) {
        return `<p style="margin:8px 0 24px"><a href="${escapeHtml(b.button.url)}" style="display:inline-block;background:${BRAND.blue};color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;padding:12px 20px;border-radius:8px">${escapeHtml(b.button.label)}</a></p>`;
      }
      if ('quote' in b) {
        return `<blockquote style="margin:0 0 16px;padding:8px 16px;border-left:4px solid ${BRAND.green};color:${BRAND.ink};font-size:16px;line-height:1.5">${escapeHtml(b.quote).replace(/\n/g, '<br>')}</blockquote>`;
      }
      return `<p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:${BRAND.ink};opacity:.75">${escapeHtml(b.small).replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${BRAND.bg};font-family:'Work Sans',Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" style="background:${BRAND.bg};border-collapse:collapse"><tr><td style="padding:24px 12px">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;border-collapse:separate">
<tr><td style="padding:20px 24px;border-bottom:4px solid ${BRAND.green}"><span style="font-family:Sora,Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;color:${BRAND.blue}">Pickle<span style="color:${BRAND.greenText}">My</span>Paddle</span></td></tr>
<tr><td style="padding:24px">
${body}
</td></tr></table>
</td></tr></table>
</body></html>
`;
}

// ── Wording helpers ───────────────────────────────────────────────────────────

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
export const paddleWord = (n: number) => plural(n, 'paddle', 'paddles');
export const money = (cents: number) => `A$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

/** "Friday 13 November 2026" from YYYY-MM-DD (a calendar date, so no time zone shifts it). */
export function longDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(y, m - 1, d)))
    .replace(',', '');
}

const paddleLine = (p: PaddleFacts) => (p.model ? `${p.brand} ${p.model}` : p.brand);

const tournament = (n: number) =>
  `A reminder: re-gritted paddles aren’t allowed in sanctioned tournaments, so keep ${plural(n, 'this one', 'these')} for social and club play.`;
const TEST_BANNER = 'TEST ORDER: this email comes from the PickleMyPaddle staging site. Nothing is charged or posted.';

function need<K extends keyof TemplateContext>(ctx: TemplateContext, key: K, template: TemplateName): NonNullable<TemplateContext[K]> {
  const v = ctx[key];
  if (v === undefined || v === null || v === '') throw new Error(`template ${template} needs ${String(key)}`);
  return v as NonNullable<TemplateContext[K]>;
}

function footer(ctx: TemplateContext, forCustomer: boolean): Block[] {
  const lines = ['PickleMyPaddle: pickleball paddle re-grits, a small business operated out of Sydney.', ctx.siteUrl];
  if (forCustomer) lines.push('Questions? Just reply to this email.', 'You’re getting this because an order was placed with this email address.');
  return [{ small: lines.join('\n') }];
}

function statusBlocks(url: string): Block[] {
  return [
    { button: { label: 'See your order’s progress', url } },
    { small: 'This link is private to you: anyone who has it can see your order’s progress, but not your name or address. If you lose it, use “Email me my links” on the status page.' },
  ];
}

// ── The templates ─────────────────────────────────────────────────────────────

function build(name: TemplateName, ctx: TemplateContext): { subject: string; blocks: Block[]; customer: boolean } {
  switch (name) {
    case 'customer_submitted': {
      const ref = need(ctx, 'reference', name);
      const paddles = need(ctx, 'paddles', name);
      const n = paddles.length;
      return {
        customer: true,
        subject: `We’ve got your order ${ref}`,
        blocks: [
          { p: `Hi ${need(ctx, 'firstName', name)},` },
          { p: `Thanks for your order. Your reference is ${ref}.` },
          { h: `Your ${paddleWord(n)}` },
          { list: paddles.map(paddleLine) },
          { h: 'What happens next' },
          { p: `We’ll look at your photos and reply within 1 business day, either to confirm we can re-grit your ${paddleWord(n)} or with a question. There’s nothing to pay yet.` },
          { p: `Once we’ve accepted your order, we’ll email the price, how to pay and where to post your ${paddleWord(n)}.` },
          ...statusBlocks(need(ctx, 'statusUrl', name)),
          { p: tournament(n) },
          { p: 'Thanks,\nPickleMyPaddle' },
        ],
      };
    }

    case 'alert_submitted': {
      // Reference, count and admin link only: no customer details or photos (SCRUM-69 AC4).
      const ref = need(ctx, 'reference', name);
      const n = need(ctx, 'paddles', name).length;
      return {
        customer: false,
        subject: `New order ${ref} (${n} ${paddleWord(n)})`,
        blocks: [
          { p: `New order ${ref}: ${n} ${paddleWord(n)} to review. Promise: a reply within 1 business day.` },
          ctx.adminUrl
            ? { button: { label: 'Open it in admin', url: ctx.adminUrl } }
            : { p: 'The admin page isn’t set up yet (SCRUM-71/72): look the order up in the database for now.' },
        ],
      };
    }

    case 'accepted': {
      const ref = need(ctx, 'reference', name);
      const n = need(ctx, 'paddles', name).length;
      const amount = ctx.amountCents ?? n * PRICE_PER_PADDLE_CENTS;
      return {
        customer: true,
        subject: `${ref} accepted: how to pay and post your ${paddleWord(n)}`,
        blocks: [
          { p: `Hi ${need(ctx, 'firstName', name)},` },
          { p: `Good news: we’ve checked your photos and we can re-grit your ${paddleWord(n)}.` },
          {
            kv: [
              ['Re-grit', `${n} × ${money(PRICE_PER_PADDLE_CENTS)} (both faces)`],
              ['Total', `${money(amount)} plus return postage`],
            ],
          },
          ctx.paymentUrl
            ? { button: { label: 'Pay now', url: ctx.paymentUrl } }
            : { p: '[To confirm: payment link and how return postage is shown, added by SCRUM-9]' },
          { h: 'Then post your ' + paddleWord(n) },
          { p: '[To confirm: postal address and packing tips]' },
          { p: `We’ll email you when ${plural(n, 'it arrives', 'they arrive')}, and ${plural(n, 'it’ll', 'they’ll')} be back in the post within 10 business days of arriving.` },
          ...statusBlocks(need(ctx, 'statusUrl', name)),
          { p: 'Thanks,\nPickleMyPaddle' },
        ],
      };
    }

    case 'in_queue': {
      const ref = need(ctx, 'reference', name);
      const n = need(ctx, 'paddles', name).length;
      return {
        customer: true,
        subject: `Your ${paddleWord(n)} arrived (${ref})`,
        blocks: [
          { p: `Hi ${need(ctx, 'firstName', name)},` },
          { p: `Your ${paddleWord(n)} arrived on ${longDate(need(ctx, 'arrivedOn', name))} and ${plural(n, 'is', 'are')} now in the re-grit queue.` },
          { kv: [['Back in the post by', longDate(need(ctx, 'backInPostBy', name))]] },
          { p: `Your status page shows where you are in the queue, and we’ll email you again with a tracking number when we post ${plural(n, 'it', 'them')} back.` },
          ...statusBlocks(need(ctx, 'statusUrl', name)),
          { p: 'Thanks,\nPickleMyPaddle' },
        ],
      };
    }

    case 'posted_back': {
      const ref = need(ctx, 'reference', name);
      const n = need(ctx, 'paddles', name).length;
      return {
        customer: true,
        subject: `Your ${paddleWord(n)} ${plural(n, 'is', 'are')} on the way back (${ref})`,
        blocks: [
          { p: `Hi ${need(ctx, 'firstName', name)},` },
          { p: `Your ${paddleWord(n)} ${plural(n, 'has', 'have')} been re-gritted and posted back to you.` },
          { kv: [['Tracking number', need(ctx, 'trackingNumber', name)]] },
          { p: `Enjoy the fresh grit. ${tournament(n)}` },
          ...statusBlocks(need(ctx, 'statusUrl', name)),
          { p: 'Thanks,\nPickleMyPaddle' },
        ],
      };
    }

    case 'rejected': {
      const ref = need(ctx, 'reference', name);
      const n = need(ctx, 'paddles', name).length;
      return {
        customer: true,
        subject: `About your order ${ref}`,
        blocks: [
          { p: `Hi ${need(ctx, 'firstName', name)},` },
          { p: `Thanks for sending photos of your ${paddleWord(n)}. Unfortunately we can’t re-grit ${plural(n, 'it', 'them')}:` },
          { quote: need(ctx, 'reason', name) },
          { p: 'You haven’t been charged anything. If you have questions, or think we’ve got it wrong, just reply to this email.' },
          { p: 'Thanks,\nPickleMyPaddle' },
        ],
      };
    }

    case 'links': {
      const links = need(ctx, 'links', name);
      return {
        customer: true,
        subject: `Your PickleMyPaddle order ${plural(links.length, 'link', 'links')}`,
        blocks: [
          { p: 'Hi,' },
          { p: `You (or someone using your email address) asked for links to your orders. Here ${plural(links.length, 'it is', 'they are')}:` },
          ...links.map((l): Block => ({ button: { label: `Order ${l.reference}`, url: l.url } })),
          { small: 'Older links for these orders no longer work. If you didn’t ask for this, you can ignore this email.' },
        ],
      };
    }
  }
}

export function render(name: TemplateName, ctx: TemplateContext): RenderedEmail {
  const built = build(name, ctx);
  const subject = ctx.test ? `[TEST] ${built.subject}` : built.subject;
  const blocks: Block[] = [...(ctx.test ? [{ quote: TEST_BANNER }] : []), ...built.blocks, ...footer(ctx, built.customer)];
  return { subject, text: toText(blocks), html: toHtml(blocks, subject) };
}

/** Sample data for every template: previews, snapshot tests and the placeholder check. */
export function sampleContext(name: TemplateName, test: boolean): TemplateContext {
  const site = test ? 'http://home-server:8088' : 'https://www.picklemypaddle.com';
  return {
    test,
    siteUrl: site,
    reference: 'PMP-7K3QX',
    firstName: 'Sam',
    paddles: [
      { brand: 'Selkirk', model: 'Vanguard Power Air' },
      { brand: 'JOOLA', model: null },
    ],
    statusUrl: `${site}/order/status#${'T'.repeat(43)}`,
    adminUrl: 'https://pmp-prod.tail8bc7ae.ts.net/admin/orders/PMP-7K3QX',
    arrivedOn: '2026-11-02',
    backInPostBy: '2026-11-16',
    trackingNumber: '33XYZ0123456789',
    reason: 'The face has a crack near the edge guard, and re-gritting would make it worse.',
    links: [
      { reference: 'PMP-7K3QX', url: `${site}/order/status#${'T'.repeat(43)}` },
      { reference: 'PMP-9ABCD', url: `${site}/order/status#${'U'.repeat(43)}` },
    ],
    ...(name === 'links' ? { reference: undefined } : {}),
  };
}

/** Every `[To confirm: …]` left in the templates (rendered with sample data). */
export function placeholdersIn(): { template: TemplateName; placeholder: string }[] {
  const out: { template: TemplateName; placeholder: string }[] = [];
  for (const t of TEMPLATES) {
    for (const m of render(t, sampleContext(t, false)).text.matchAll(/\[To confirm:[^\]]*\]/g)) out.push({ template: t, placeholder: m[0] });
  }
  return out;
}
