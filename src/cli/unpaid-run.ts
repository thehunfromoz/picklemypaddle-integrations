/**
 * Runs the unpaid-order jobs now (SCRUM-83): the day-14 payment reminder and the day-30 lapse.
 * The service runs the same jobs once a day by itself; this is for trying them on staging after
 * `backdate-order.js PMP-XXXXX 15d` (or 31d).
 *
 *   sudo docker compose -f compose.staging.yml exec integrations node dist/cli/unpaid-run.js
 *
 * The reminder is queued in the outbox; the running service sends it within a minute. Open
 * Checkout Sessions of lapsed orders are marked expired here; with a Stripe key they are also
 * expired at Stripe.
 */
import { ConfigError, loadConfig } from '../config.js';
import { createPgDb } from '../db/db.js';
import { runAutoTransitions } from '../orders/auto.js';
import { runPaymentReminders } from '../orders/payment-reminder.js';
import { stripeClient } from '../payments/stripe.js';

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

const db = createPgDb(config.DATABASE_URL, { max: 1 });
const now = new Date();
const isProduction = config.APP_ENV === 'production';
try {
  const reminders = await runPaymentReminders(db, now);
  const payments = config.STRIPE_SECRET_KEY
    ? { db, stripe: stripeClient(config.STRIPE_SECRET_KEY, config.STRIPE_API_BASE), isProduction, now: () => now }
    : null;
  const auto = await runAutoTransitions(db, now, isProduction, payments);
  console.log(`Payment reminders queued: ${reminders}. Lapsed: ${auto.lapsed} (unpaid or no reply). Completed: ${auto.completed}.`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
