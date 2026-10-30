/**
 * TEST ONLY (SCRUM-75): moves a TEST order's dates back in time, so the retention rules can be
 * seen working on staging without waiting a year. Refused in production, and for any order that
 * isn't a TEST order.
 *
 *   sudo docker compose -f compose.staging.yml exec integrations node dist/cli/backdate-order.js PMP-XXXXX 13
 *
 * moves every date on the order (placed, each status change, arrival, reminders, its emails and
 * notes) back by that many months. Then `retention-run.js --dry-run` shows what is now due.
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
const [reference, monthsText] = process.argv.slice(2);
const months = Number(monthsText);
if (!reference || !REFERENCE_RE.test(reference) || !Number.isInteger(months) || months < 1 || months > 72) {
  console.error('Usage: node dist/cli/backdate-order.js PMP-XXXXX <months, 1 to 72>');
  process.exit(2);
}

const db = createPgDb(config.DATABASE_URL, { max: 1 });
try {
  await db.tx(async (q) => {
    const { rows } = await q.query<{ id: string; is_test: boolean }>('SELECT id, is_test FROM orders WHERE reference = $1 FOR UPDATE', [reference]);
    const order = rows[0];
    if (!order) throw new Error(`No order ${reference}.`);
    if (!order.is_test) throw new Error(`Refused: ${reference} isn't a TEST order.`);
    const shift = `${months} months`;
    await q.query(
      `UPDATE orders SET created_at = created_at - $2::interval, status_changed_at = status_changed_at - $2::interval,
              consent_at = consent_at - $2::interval, tournament_ack_at = tournament_ack_at - $2::interval,
              arrived_on = arrived_on - $2::interval, promise_on = promise_on - $2::interval,
              review_reminder_at = review_reminder_at - $2::interval
        WHERE id = $1`,
      [order.id, shift],
    );
    await q.query('UPDATE status_history SET at = at - $2::interval WHERE order_id = $1', [order.id, shift]);
    await q.query('UPDATE order_notes SET at = at - $2::interval WHERE order_id = $1', [order.id, shift]);
    await q.query('UPDATE reviews SET created_at = created_at - $2::interval, permission_at = permission_at - $2::interval WHERE order_id = $1', [order.id, shift]);
  });
  console.log(`${reference}: every date moved back ${months} month(s). Next: node dist/cli/retention-run.js --dry-run`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
