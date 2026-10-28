/**
 * Sending email (SCRUM-69). Order logic talks to `EmailSender`; Resend is one implementation,
 * so the provider can be swapped without touching anything else.
 *
 * The API key is read from settings only and never logged. Errors carry a short code (an HTTP
 * status or a network error name), never the provider's message, which can quote the request.
 */

/** Automatic emails come from sales@ and replies go to info@ (decided 20 and 26 Oct 2026). */
export const FROM = 'PickleMyPaddle <sales@picklemypaddle.com>';
export const REPLY_TO = 'info@picklemypaddle.com';
/** Where Attila's new-order alert goes (forwarded to the business Gmail). */
export const ALERT_TO = 'sales@picklemypaddle.com';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** The provider drops a repeat with the same key (Resend keeps keys for 24 hours). */
  idempotencyKey: string;
}

export interface EmailSender {
  readonly name: string;
  send(message: EmailMessage): Promise<{ id: string }>;
}

/**
 * A failed send. `permanent` means retrying won't help (a rejected request or a bad key), so the
 * outbox gives up at once and shows it on the admin page; anything else is retried with backoff.
 */
export class SendError extends Error {
  constructor(
    readonly code: string,
    readonly permanent: boolean,
  ) {
    super(`email send failed: ${code}`);
    this.name = 'SendError';
  }
}

const RESEND_URL = 'https://api.resend.com/emails';

export function resendSender(apiKey: string, fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): EmailSender {
  return {
    name: 'resend',
    async send(m) {
      let res: Response;
      try {
        res = await fetchImpl(RESEND_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': m.idempotencyKey,
            'User-Agent': 'picklemypaddle-integrations',
          },
          body: JSON.stringify({ from: FROM, to: [m.to], reply_to: REPLY_TO, subject: m.subject, text: m.text, html: m.html }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new SendError(`network:${(err as Error)?.name ?? 'error'}`, false);
      }
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { id?: unknown };
        return { id: typeof body.id === 'string' ? body.id : '' };
      }
      await res.body?.cancel().catch(() => undefined);
      // 429 (rate limit) and 5xx are worth retrying; other 4xx (bad key, invalid request) are not.
      throw new SendError(`http:${res.status}`, !(res.status === 429 || res.status >= 500));
    },
  };
}
