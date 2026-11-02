/**
 * TEST ONLY (SCRUM-75): moves a TEST order's dates back in time, so the retention rules can be
 * seen working on staging without waiting a year. Refused in production, and for any order that
 * isn't a TEST order.
 *
 *   sudo docker compose -f compose.staging.yml exec integrations node dist/cli/backdate-order.js PMP-XXXXX 13
 *   sudo docker compose -f compose.staging.yml exec integrations node dist/cli/backdate-order.js PMP-XXXXX 15d
 *
 * moves every date on the order (placed, each status change, arrival, reminders, payments, its
 * emails and notes) back by that many months, or days with a "d" (SCRUM-83). Then
 * `retention-run.js --dry-run` or `unpaid-run.js` shows what is now due.
 */
import { ConfigError, loadConfig } from '../config.js';
import { createPgDb } from '../db/db.js';
import { REFERENCE_RE } from '../orders/model.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(78);
  }
  throw err;
}
if (config.APP_ENV === 'production') {
  console.error('Refused: back-dating is for TEST orders outside production only.');
  process.exit(1);
}
const [reference, amountText = ''] = process.argv.slice(2);
const days = /^\d{1,4}d$/.test(amountText) ? Number(amountText.slice(0, -1)) : null;
const months = days === null ? Number(amountText) : 0;
if (!reference || !REFERENCE_RE.test(reference) || (days === null ? !Number.isInteger(months) || months < 1 || months > 72 : days < 1 || days > 2200)) {
  console.error('Usage: node dist/cli/backdate-order.js PMP-XXXXX <months, 1 to 72 | days, e.g. 15d>');
  process.exit(2);
}

const shift = days === null ? `${months} months` : `${days} days`;
const db = createPgDb(config.DATABASE_URL, { max: 1 });
try {
  await db.tx(async (q) => {
    const { rows } = await q.query<{ id: string; is_test: boolean }>('SELECT id, is_test FROM orders WHERE reference = $1 FOR UPDATE', [reference]);
    const order = rows[0];
    if (!order) throw new Error(`No order ${reference}.`);
    if (!order.is_test) throw new Error(`Refused: ${reference} isn't a TEST order.`);
    await q.query(
      `UPDATE orders SET created_at = created_at - $2::interval, status_changed_at = status_changed_at - $2::interval,
              consent_at = consent_at - $2::interval, tournament_ack_at = tournament_ack_at - $2::interval,
              arrived_on = arrived_on - $2::interval, promise_on = promise_on - $2::interval,
              review_reminder_at = review_reminder_at - $2::interval,
              payment_reminder_at = payment_reminder_at - $2::interval, terms_date = terms_date - $2::interval
        WHERE id = $1`,
      [order.id, shift],
    );
    await q.query('UPDATE status_history SET at = at - $2::interval WHERE order_id = $1', [order.id, shift]);
    await q.query('UPDATE order_notes SET at = at - $2::interval WHERE order_id = $1', [order.id, shift]);
    await q.query('UPDATE payments SET paid_at = paid_at - $2::interval, recorded_at = recorded_at - $2::interval WHERE order_id = $1', [order.id, shift]);
    await q.query('UPDATE stripe_sessions SET created_at = created_at - $2::interval, expires_at = expires_at - $2::interval WHERE order_id = $1', [order.id, shift]);
    await q.query('UPDATE reviews SET created_at = created_at - $2::interval, permission_at = permission_at - $2::interval WHERE order_id = $1', [order.id, shift]);
  });
  console.log(`${reference}: every date moved back ${shift}. Next: node dist/cli/retention-run.js --dry-run, or node dist/cli/unpaid-run.js`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
