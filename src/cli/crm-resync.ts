/**
 * Queues a CRM sync of every order (SCRUM-74 AC7): after a HubSpot outage, or after production
 * switches to its own portal. The running service's worker then pushes them at its usual pace.
 *
 *   sudo docker compose -p pmp-staging exec integrations node dist/cli/crm-resync.js
 */
import { ConfigError, loadConfig } from '../config.js';
import { resyncAll } from '../crm/sync.js';
import { createPgDb } from '../db/db.js';

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
if (!config.HUBSPOT_ACCESS_TOKEN) console.warn('HubSpot isn’t configured here: the jobs will be marked skipped.');

const db = createPgDb(config.DATABASE_URL, { max: 1 });
try {
  const n = await resyncAll(db, new Date());
  console.log(`Queued ${n} order(s) for a CRM sync. The service sends them over the next few minutes.`);
} finally {
  await db.close();
}
