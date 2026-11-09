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
import { taxWording, type TaxTreatment } from '../pricing/terms.js';
import { PRICE_PER_PADDLE_CENTS } from '../orders/model.js';
import { describeDiscount, discountCents, type DiscountBenefit } from '../orders/rules.js';

export const TEMPLATES = [
  'customer_submitted',
  'alert_submitted',
  'accepted',
  'in_queue',
  'posted_back',
  'rejected',
  'links',
  'alert_review',
  'review_reminder',
  'payment_reminder',
  'alert_payment',
  'payment_received',
  'refund_issued',
  'club_invoice',
  'club_lead_ack',
  'alert_club_lead',
  'club_agreement',
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
  /** Accepted: the total to pay, including return postage (SCRUM-81). */
  amountCents?: number;
  /** Accepted: the re-grit price for all paddles, and the return postage. */
  subtotalCents?: number;
  postageCents?: number;
  /** Accepted (SCRUM-63): the discount fixed at Accept, and the code that gave it. */
  discountCents?: number;
  discountCode?: string;
  /** Payment reminder (SCRUM-83): the Sydney day the order lapses if still unpaid. */
  lapsesOn?: string;
  /** Payment alert (SCRUM-83): what needs Attila's attention, in a few words. */
  problem?: string;
  /** Payment alert for a club batch: the card payment was refunded in Stripe (not "wasn't applied"). */
  refund?: boolean;
  /** Submitted (SCRUM-63): the code on the order and what it gives, confirmed at Accept. */
  discountOffer?: DiscountBenefit & { code: string };
  /** Accepted: the GST included, and whether GST applies (from the terms frozen at Accept). */
  gstCents?: number;
  taxTreatment?: TaxTreatment;
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
  /** Posted back: the status page's review form (SCRUM-33). */
  reviewUrl?: string;
  /** SCRUM-84: the receipt or credit note this email links (its printable page). */
  document?: { number: string; url: string };
  /** Refund issued (SCRUM-84): this refund, and whether the payment is now refunded in full. */
  refundCents?: number;
  refundFull?: boolean;
  /** Review alert: the review, shown only when the customer gave permission to quote it. */
  review?: { quote: string; firstName: string; suburb: string; permission: boolean };
  /** SCRUM-85: club emails. `reference` is then the batch's (PMPB-…), `firstName` the billing contact's. */
  club?: { name: string };
  /** SCRUM-93: an enquiry from the Clubs page's form (the club's contact, not its billing contact). */
  enquiry?: boolean;
  /** SCRUM-94: the club agreement, with its text, the Schedule and the private printable page. */
  agreement?: {
    title: string;
    label: string;
    dated: string;
    sections: { heading: string; blocks: ({ p: string } | { list: string[] })[] }[];
    schedule: [string, string][];
    url: string;
  };
  /** SCRUM-93 alert: the club was already on file, so this is a second enquiry. */
  duplicate?: boolean;
  /** SCRUM-85: a club invoice, from its frozen snapshot, and its private page (view, print, pay by card). */
  invoice?: {
    number: string;
    url: string;
    paddles: number;
    /** GST-exclusive invoices only. */
    subtotalCents?: number;
    gstCents: number;
    totalCents: number;
    dueOn: string;
    treatment: TaxTreatment;
    payId: string;
    /** Whether the invoice's page takes card payments (SCRUM-85, second part). */
    payByCard: boolean;
  };
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
const AGREEMENT_TEST_BANNER = 'TEST AGREEMENT: this email comes from the PickleMyPaddle staging site. It is not a real agreement, and nothing needs replying to.';
const ENQUIRY_TEST_BANNER = 'TEST ENQUIRY: this email comes from the PickleMyPaddle staging site. No real club has made an enquiry.';
const CLUB_TEST_BANNER = 'TEST INVOICE: this email comes from the PickleMyPaddle staging site. Nothing is owed or charged.';

function need<K extends keyof TemplateContext>(ctx: TemplateContext, key: K, template: TemplateName): NonNullable<TemplateContext[K]> {
  const v = ctx[key];
  if (v === undefined || v === null || v === '') throw new Error(`template ${template} needs ${String(key)}`);
  return v as NonNullable<TemplateContext[K]>;
}

function footer(ctx: TemplateContext, forCustomer: boolean): Block[] {
  const lines = ['PickleMyPaddle: pickleball paddle re-grits, a small business operated out of Sydney.', ctx.siteUrl];
  if (forCustomer && ctx.agreement) lines.push('Questions? Just reply to this email.', `You’re getting this as the contact for ${ctx.club?.name ?? 'your club'}.`);
  else if (forCustomer && ctx.enquiry) lines.push('Questions? Just reply to this email.', 'You’re getting this because you filled in the “Talk to us about your club” form on our Clubs page.');
  else if (forCustomer && ctx.club) lines.push('Questions? Just reply to this email.', `You’re getting this as the billing contact for ${ctx.club.name}.`);
  else if (forCustomer) lines.push('Questions? Just reply to this email.', 'You’re getting this because an order was placed with this email address.');
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
          // Same estimate the order form showed: the re-grit price is fixed, only return postage isn't.
          { p: `Your estimate is ${money(n * PRICE_PER_PADDLE_CENTS)} for re-gritting${n > 1 ? ` (${money(PRICE_PER_PADDLE_CENTS)} a paddle)` : ''}, plus return postage. Once we’ve accepted your order, we’ll email the total with postage, how to pay and where to post your ${paddleWord(n)}.` },
          // SCRUM-63: the code is applied, and confirmed when the order is accepted.
          ...(ctx.discountOffer
            ? [{ p: `Code applied: ${ctx.discountOffer.code} (${describeDiscount(ctx.discountOffer)}), so ${money(discountCents(ctx.discountOffer, n, PRICE_PER_PADDLE_CENTS))} off the re-grit. It’s confirmed when we accept your order. Return postage is still payable.` }]
            : []),
          ...statusBlocks(need(ctx, 'statusUrl', name)),
          { p: tournament(n) },
          { p: 'Thanks,\nPickleMyPaddle' },
        ],
      };
    }

    case 'payment_reminder': {
      // SCRUM-83: day 14, once. The lapse date and the order page's Pay now; no Stripe link.
      const ref = need(ctx, 'reference', name);
      const n = need(ctx, 'paddles', name).length;
      const lapses = longDate(need(ctx, 'lapsesOn', name));
      return {
        customer: true,
        subject: `${ref} is waiting for payment`,
        blocks: [
          { p: `Hi ${need(ctx, 'firstName', name)},` },
          { p: `Your order ${ref} is waiting for payment${ctx.amountCents !== undefined ? ` (${money(ctx.amountCents)}, including return postage)` : ''}. It lapses on ${lapses} if it’s still unpaid then, and you’re welcome to order again any time.` },
          { button: { label: 'Pay now on your order page', url: need(ctx, 'statusUrl', name) } },
          { p: `Changed your mind, or have a question about your ${paddleWord(n)}? Just reply to this email.` },
          statusBlocks(need(ctx, 'statusUrl', name))[1]!,
          { p: 'Thanks,\nPickleMyPaddle' },
        ],
      };
    }

    case 'alert_payment': {
      // SCRUM-83: a payment that wasn't applied. Reference, what happened and the admin link only.
      const ref = need(ctx, 'reference', name);
      if (ctx.club && ctx.refund) {
        // SCRUM-85: an applied club card payment was refunded in Stripe. Nothing else has changed.
        return {
          customer: false,
          subject: `Payment to check: ${ref}`,
          blocks: [
            { p: `A Stripe card payment for club batch ${ref} (${ctx.club.name}) was changed in Stripe: ${need(ctx, 'problem', name)}. The invoice and batch haven’t been touched, so check the balance by hand.` },
            ctx.adminUrl ? { button: { label: 'Open the batch in admin', url: ctx.adminUrl } } : { p: 'Open the batch in admin.' },
          ],
        };
      }
      if (ctx.club) {
        // SCRUM-85: a club's card payment for a batch invoice. Nothing is reinstated; it's a refund.
        return {
          customer: false,
          subject: `Payment to check: ${ref}`,
          blocks: [
            { p: `A Stripe card payment for club batch ${ref} (${ctx.club.name}) wasn’t applied: ${need(ctx, 'problem', name)}. The club was charged and nothing was refunded. Refund it in the Stripe dashboard.` },
            ctx.adminUrl ? { button: { label: 'Open the batch in admin', url: ctx.adminUrl } } : { p: 'Open the batch in admin.' },
          ],
        };
      }
      return {
        customer: false,
        subject: `Payment to check: ${ref}`,
        blocks: [
          { p: `A Stripe payment for ${ref} wasn’t applied: ${need(ctx, 'problem', name)}. Nothing was refunded and the order hasn’t moved. Check it in admin: a late payment can be reinstated there, or refund it in the Stripe dashboard.` },
          ctx.adminUrl ? { button: { label: 'Open it in admin', url: ctx.adminUrl } } : { p: 'Open the order in admin.' },
        ],
      };
    }

    case 'payment_received': {
      // SCRUM-84: at Paid. The receipt's number and link, and where to post the paddles.
      const ref = need(ctx, 'reference', name);
      const n = need(ctx, 'paddles', name).length;
      const doc = need(ctx, 'document', name);
      return {
        customer: true,
        subject: `Payment received for ${ref}: now post your ${paddleWord(n)}`,
        blocks: [
          { p: `Hi ${need(ctx, 'firstName', name)},` },
          { p: `Thanks: we’ve received your payment${ctx.amountCents !== undefined ? ` of ${money(ctx.amountCents)}` : ''} for order ${ref}.` },
          { kv: [['Receipt', doc.number], ...(ctx.amountCents !== undefined ? [['Paid', money(ctx.amountCents)] as [string, string]] : [])] },
          { button: { label: 'View or print your receipt', url: doc.url } },
          { h: 'Now post your ' + paddleWord(n) },
          { p: '[To confirm: postal address and packing tips]' },
          { p: `We’ll email you when ${plural(n, 'it arrives', 'they arrive')}, and ${plural(n, 'it’ll', 'they’ll')} be back in the post within 10 business days of arriving.` },
          ...statusBlocks(need(ctx, 'statusUrl', name)),
          { p: 'Thanks,\nPickleMyPaddle' },
        ],
      };
    }

    case 'refund_issued': {
      // SCRUM-84: every refund, full or partial, with its credit note.
      const ref = need(ctx, 'reference', name);
      const doc = need(ctx, 'document', name);
      const cents = need(ctx, 'refundCents', name);
      return {
        customer: true,
        subject: `Refund for ${ref}`,
        blocks: [
          { p: `Hi ${need(ctx, 'firstName', name)},` },
          { p: ctx.refundFull
            ? `We’ve refunded ${money(cents)} for order ${ref} to the card you paid with. Your payment has now been refunded in full.`
            : `We’ve refunded ${money(cents)} of your payment for order ${ref} to the card you paid with.` },
          { kv: [['Credit note', doc.number], ['Refunded', money(cents)]] },
          { button: { label: 'View or print your credit note', url: doc.url } },
          { p: 'Refunds usually take 5 to 10 business days to show on your statement, depending on your bank.' },
          statusBlocks(need(ctx, 'statusUrl', name))[1]!,
          { p: 'Thanks,\nPickleMyPaddle' },
        ],
      };
    }

    case 'club_invoice': {
      // SCRUM-85: on return of a batch. The invoice in brief, its private page, and how to pay.
      const batch = need(ctx, 'reference', name);
      const club = need(ctx, 'club', name);
      const inv = need(ctx, 'invoice', name);
      const amounts: [string, string][] = inv.treatment === 'gst_exclusive' && inv.subtotalCents !== undefined
        ? [['Subtotal (excluding GST)', money(inv.subtotalCents)], ['GST (10%)', money(inv.gstCents)], ['Total', money(inv.totalCents)]]
        : [['Total', money(inv.totalCents)]];
      return {
        customer: true,
        subject: `Invoice ${inv.number} for ${club.name}: ${inv.paddles} ${paddleWord(inv.paddles)} re-gritted`,
        blocks: [
          { p: `Hi ${need(ctx, 'firstName', name)},` },
          { p: `Your batch ${batch} is back: ${inv.paddles} ${paddleWord(inv.paddles)} re-gritted for ${club.name}. Here’s the invoice.` },
          { kv: [['Invoice', inv.number], ['Batch', batch], ...amounts, ['Due by', longDate(inv.dueOn)]] },
          ...(inv.treatment === 'not_registered' ? [{ small: 'No GST has been charged.' } as Block] : []),
          { button: { label: inv.payByCard ? 'View, print or pay by card' : 'View or print the invoice', url: inv.url } },
          { h: 'How to pay' },
          { list: [
            `PayID or bank transfer to ${inv.payId}, with ${inv.number} as the reference`,
            ...(inv.payByCard ? ['By card, with the button above'] : []),
            'In cash, at your club’s next pickup or delivery',
          ] },
          { p: 'Payment is in full for each invoice.' },
          { small: 'The invoice link is private to your club: anyone who has it can see and pay this invoice, so please don’t forward it outside your committee.' },
          { p: 'Thanks for working with us,\nAttila, PickleMyPaddle' },
        ],
      };
    }

    case 'club_lead_ack': {
      // SCRUM-93: the acknowledgement to whoever filled in the Clubs page form.
            return {
        customer: true,
        // Nothing but the first name is the submitter's own text: anyone can type someone else's address.
        subject: 'Thanks for getting in touch about your club',
        blocks: [
          { p: `Hi ${need(ctx, 'firstName', name)},` },
          { p: `Thanks for telling us about your club. We’ll reply within 1 business day with a few times for a short chat about re-gripping your members’ paddles.` },
          { p: 'If there’s anything you forgot to say, just reply to this email.' },
          { p: 'Talk soon,\nAttila, PickleMyPaddle' },
        ],
      };
    }

    case 'club_agreement': {
      // SCRUM-94: the full text, so it can be read in the email; the page is for printing.
      const a = need(ctx, 'agreement', name);
      const club = need(ctx, 'club', name);
      const sectionBlocks: Block[] = a.sections.flatMap((s) => [
        { h: s.heading } as Block,
        ...s.blocks.map((b): Block => ('p' in b ? { p: b.p } : { list: b.list })),
      ]);
      return {
        customer: true,
        subject: `Club agreement ${a.label} for ${club.name}: please reply “I agree”`,
        blocks: [
          { p: `Hi ${need(ctx, 'firstName', name)},` },
          { p: `Here is our club agreement (version ${a.label}, dated ${longDate(a.dated)}) for ${club.name}, in full below. Please read it. If the club agrees, reply to this email with the words “I agree”. If not, reply and tell us which part.` },
          { p: 'Nothing in it applies until the club has accepted it.' },
          { button: { label: 'View or print the agreement', url: a.url } },
          { small: 'This link is private to your club: please keep it within your committee.' },
          { h: a.title },
          ...sectionBlocks,
          { h: 'Schedule: the club’s details' },
          { kv: a.schedule },
          { p: 'Thanks for working with us,\nAttila, PickleMyPaddle' },
        ],
      };
    }

    case 'alert_club_lead': {
      // SCRUM-93: club name and the admin link only; the details are in admin.
      const club = need(ctx, 'club', name);
      return {
        customer: false,
        subject: `Club enquiry: ${club.name}`,
        blocks: [
          { p: ctx.duplicate
            ? `Another enquiry from ${club.name}, which is already on file. No acknowledgement was sent. Promise: a reply within 1 business day with meeting times.`
            : `New club enquiry from ${club.name}. Promise: a reply within 1 business day with meeting times.` },
          ctx.adminUrl ? { button: { label: 'Open the club in admin', url: ctx.adminUrl } } : { p: 'Open the club in admin.' },
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
      const subtotal = ctx.subtotalCents ?? n * PRICE_PER_PADDLE_CENTS;
      const postage = ctx.postageCents;
      const amount = ctx.amountCents ?? subtotal - (ctx.discountCents ?? 0) + (postage ?? 0);
      const each = n > 0 ? Math.round(subtotal / n) : PRICE_PER_PADDLE_CENTS;
      const gst = taxWording(ctx.taxTreatment ?? 'not_registered', amount).gstLine;
      return {
        customer: true,
        subject: `${ref} accepted: how to pay and post your ${paddleWord(n)}`,
        blocks: [
          { p: `Hi ${need(ctx, 'firstName', name)},` },
          { p: `Good news: we’ve checked your photos and we can re-grit your ${paddleWord(n)}.` },
          {
            kv: [
              ['Re-grit', `${n} × ${money(each)} (both faces)`],
              ...(ctx.discountCents && ctx.discountCode ? [[`Discount (${ctx.discountCode})`, `−${money(ctx.discountCents)}`] as [string, string]] : []),
              ...(postage !== undefined ? [['Return postage', money(postage)] as [string, string]] : []),
              ['Total', postage !== undefined ? money(amount) : `${money(amount)} plus return postage`],
              ['GST', gst],
            ],
          },
          // SCRUM-82: never a Stripe link (they expire); Pay now is on the private order page.
          { p: 'Pay by card on your private order page: card details go straight to Stripe, our payment provider, and never to us.' },
          { button: { label: 'Pay now on your order page', url: need(ctx, 'statusUrl', name) } },
          { h: 'Then post your ' + paddleWord(n) },
          { p: '[To confirm: postal address and packing tips]' },
          { p: `We’ll email you when ${plural(n, 'it arrives', 'they arrive')}, and ${plural(n, 'it’ll', 'they’ll')} be back in the post within 10 business days of arriving.` },
          // The Pay now button above is the order page link; just the privacy note here.
          statusBlocks(need(ctx, 'statusUrl', name))[1]!,
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
          { p: `Your status page shows how many paddles are ahead of yours while ${plural(n, 'it waits', 'they wait')}, and we’ll email you again with a tracking number when we post ${plural(n, 'it', 'them')} back.` },
          ...statusBlocks(need(ctx, 'statusUrl', name)),
          // SCRUM-84: the receipt, again, for anyone who missed the payment email.
          ...(ctx.document ? [{ button: { label: `Your receipt (${ctx.document.number})`, url: ctx.document.url } }] : []),
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
          // SCRUM-33: the testimonial request.
          { h: 'How did we do?' },
          { p: `Once you’ve had a hit with your ${paddleWord(n)}, we’d love a short review. It takes a minute, and you choose whether we may quote it on our website (with just your first name and suburb).` },
          { button: { label: 'Leave a short review', url: need(ctx, 'reviewUrl', name) } },
          { p: 'Thanks,\nPickleMyPaddle' },
        ],
      };
    }

    // SCRUM-80: the one reminder, 10 days after posting back, when no review has come in.
    case 'review_reminder': {
      const ref = need(ctx, 'reference', name);
      const n = need(ctx, 'paddles', name).length;
      return {
        customer: true,
        subject: `${plural(n, 'How’s the re-gritted paddle', 'How are the re-gritted paddles')}? (${ref})`,
        blocks: [
          { p: `Hi ${need(ctx, 'firstName', name)},` },
          { p: `Your ${paddleWord(n)} should have been back with you for a little while now. If you’ve had a hit, we’d love to hear how ${plural(n, 'it plays', 'they play')}.` },
          { p: 'A short review takes a minute, and you choose whether we may quote it on our website (with just your first name and suburb).' },
          { button: { label: 'Leave a short review', url: need(ctx, 'reviewUrl', name) } },
          { p: 'This is the only reminder we’ll send about it.' },
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

    case 'alert_review': {
      // Like the order alert: the review itself only when the customer said it may be published.
      const ref = need(ctx, 'reference', name);
      const r = need(ctx, 'review', name);
      return {
        customer: false,
        subject: `Review for ${ref} (${r.permission ? 'may quote' : 'not for quoting'})`,
        blocks: r.permission
          ? [
              { p: `A review for ${ref}, with permission to quote it as first name and suburb:` },
              { quote: r.quote },
              { p: `${r.firstName}, ${r.suburb}` },
              { p: 'To publish it, add it to src/data/testimonials.json in picklemypaddle-site by pull request (the section shows from 3).' },
            ]
          : [
              { p: `A review for ${ref}. The customer did not give permission to quote it, so it stays private.` },
              ctx.adminUrl ? { button: { label: 'Read it in admin', url: ctx.adminUrl } } : { p: 'Read it in the order database (the admin page comes with SCRUM-72).' },
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
  const blocks: Block[] = [...(ctx.test ? [{ quote: ctx.agreement ? AGREEMENT_TEST_BANNER : ctx.enquiry ? ENQUIRY_TEST_BANNER : ctx.club ? CLUB_TEST_BANNER : TEST_BANNER }] : []), ...built.blocks, ...footer(ctx, built.customer)];
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
    // Accepted (SCRUM-81): 2 paddles, the calculated postage for a padded bag (actual weight + bag).
    subtotalCents: 12000,
    postageCents: 1800,
    amountCents: 13800,
    gstCents: 0,
    taxTreatment: 'not_registered',
    links: [
      { reference: 'PMP-7K3QX', url: `${site}/order/status#${'T'.repeat(43)}` },
      { reference: 'PMP-9ABCD', url: `${site}/order/status#${'U'.repeat(43)}` },
    ],
    reviewUrl: `${site}/order/status?review=1#${'T'.repeat(43)}`,
    // SCRUM-83: accepted 2 Nov 2026, lapses 30 days later.
    lapsesOn: '2026-12-02',
    // SCRUM-84: the receipt (or, for the refund email, a credit note) and a partial refund.
    document: name === 'refund_issued'
      ? { number: 'PMP-CN-0001', url: `${site}/order/document?n=PMP-CN-0001#${'T'.repeat(43)}` }
      : { number: 'PMP-INV-0001', url: `${site}/order/document?n=PMP-INV-0001#${'T'.repeat(43)}` },
    refundCents: 1800,
    refundFull: false,
    problem: 'it arrived after the order lapsed',
    ...(name === 'club_invoice'
      ? {
          reference: 'PMPB-4K7QX',
          firstName: 'Jo',
          club: { name: 'Inner West Pickleball Club' },
          invoice: {
            number: 'PMP-INV-0042',
            url: `${site}/club/invoice?n=PMP-INV-0042#${'T'.repeat(43)}`,
            paddles: 23,
            gstCents: 0,
            totalCents: 124200,
            dueOn: '2026-11-18',
            treatment: 'not_registered' as const,
            payId: 'payments@picklemypaddle.com',
            payByCard: false,
          },
        }
      : {}),
    ...(name === 'club_lead_ack' || name === 'alert_club_lead'
      ? {
          reference: undefined,
          firstName: 'Jo',
          club: { name: 'Inner West Pickleball Club' },
          enquiry: true,
          adminUrl: 'https://pmp-prod.tail8bc7ae.ts.net/admin/clubs/00000000-0000-4000-8000-000000000001',
        }
      : {}),
    ...(name === 'club_agreement'
      ? {
          reference: undefined,
          firstName: 'Jo',
          club: { name: 'Inner West Pickleball Club' },
          agreement: {
            title: 'Club partner agreement',
            label: '0.1',
            dated: '2026-11-04',
            sections: [{ heading: '1. Who this agreement is between', blocks: [{ p: '1.1 This agreement is between us and the club named in the Schedule.' }, { list: ['a first point;', 'a second point.'] }] }],
            schedule: [['Club name', 'Inner West Pickleball Club'], ['Usual way of paying', 'PayID, card or cash']] as [string, string][],
            url: `${site}/club/agreement#${'T'.repeat(43)}`,
          },
        }
      : {}),
    review: { quote: 'Feels brand new: the spin is back. Quick turnaround too.', firstName: 'Sam', suburb: 'Newtown', permission: true },
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
