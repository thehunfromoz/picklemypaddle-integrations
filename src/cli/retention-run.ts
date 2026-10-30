/**
 * Runs the daily retention job now (SCRUM-75), or with --dry-run lists what is due without
 * deleting anything. The service runs the same job once a day by itself.
 *
 *   sudo docker compose -f compose.staging.yml exec integrations node dist/cli/retention-run.js --dry-run
 *   sudo docker compose -f compose.staging.yml exec integrations node dist/cli/retention-run.js
 *
 * Prints counts and references (it's run by Attila, at his terminal); the job's own log lines
 * hold counts only.
 */
import { ConfigError, loadConfig } from '../config.js';
import { hubspotAdapter, hubspotClient, portalIdOf } from '../crm/hubspot.js';
import { createPgDb } from '../db/db.js';
import { sydneyDate } from '../orders/dates.js';
import { fsPhotoStore } from '../orders/photos.js';
import { retentionOrders, rulesDue, runRetention, upcomingDeletions } from '../orders/retention.js';

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

const dryRun = process.argv.includes('--dry-run');
const db = createPgDb(config.DATABASE_URL, { max: 1 });
const now = new Date();
try {
  if (dryRun) {
    const due = (await retentionOrders(db)).map((o) => ({ o, rules: rulesDue(o, now) })).filter((x) => x.rules.length);
    console.log(due.length ? `Due now (${sydneyDate(now)}):` : `Nothing is due now (${sydneyDate(now)}).`);
    for (const { o, rules } of due) console.log(`  ${o.reference}${o.isTest ? ' [TEST]' : ''}: ${rules.join(', ')}`);
    const soon = (await upcomingDeletions(db, now)).filter((u) => u.due > sydneyDate(now));
    if (soon.length) {
      console.log('Coming up in the next 14 days:');
      for (const u of soon) console.log(`  ${u.due} ${u.reference}: ${u.rule}`);
    }
    console.log('Dry run: nothing was deleted.');
  } else {
    const hubspot = config.HUBSPOT_ACCESS_TOKEN ? hubspotClient(config.HUBSPOT_ACCESS_TOKEN, config.HUBSPOT_API_BASE) : null;
    const crm = hubspot
      ? { db, adapter: hubspotAdapter(hubspot), portalId: () => portalIdOf(hubspot), expectedPortalId: config.HUBSPOT_PORTAL_ID ?? null, now: () => new Date() }
      : null;
    const run = await runRetention({ db, photos: fsPhotoStore(config.PHOTO_DIR), crm }, now);
    console.log(`Deleted: photos of ${run.photos} order(s), ${run.enquiries} order(s) that never went ahead, ${run.paid} paid order(s) past 5 years.`);
    if (run.waiting) console.log(`${run.waiting} due order(s) are waiting for HubSpot; they'll be tried again on the next run.`);
  }
} finally {
  await db.close();
}
