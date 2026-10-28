/**
 * Applies the HubSpot pipeline stages and custom deal properties defined in src/crm/hubspot.ts
 * (SCRUM-74 AC5). Idempotent: running it again changes nothing.
 *
 * On staging (inside the integrations container, which has the settings):
 *
 *   sudo docker compose -p pmp-staging exec integrations node dist/cli/hubspot-setup.js --dry-run
 *   sudo docker compose -p pmp-staging exec integrations node dist/cli/hubspot-setup.js
 *
 * It first checks the key belongs to HUBSPOT_PORTAL_ID (and, outside production, that this is
 * the test portal), so it can't change the wrong account. Stages that aren't ours are listed but
 * left alone. Exit codes: 0 done (or nothing to do), 1 failed, 78 settings missing or wrong.
 */
import { ConfigError, loadConfig } from '../config.js';
import { applySetup, describeChange, HubSpotError, hubspotClient, planSetup, portalIdOf } from '../crm/hubspot.js';

const dryRun = process.argv.includes('--dry-run');

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
if (!config.HUBSPOT_ACCESS_TOKEN || !config.HUBSPOT_PORTAL_ID) {
  console.error('HUBSPOT_ACCESS_TOKEN and HUBSPOT_PORTAL_ID must be set.');
  process.exit(78);
}

const client = hubspotClient(config.HUBSPOT_ACCESS_TOKEN, config.HUBSPOT_API_BASE);
try {
  const portal = await portalIdOf(client);
  if (portal !== config.HUBSPOT_PORTAL_ID) {
    console.error(`The key belongs to portal ${portal}, not HUBSPOT_PORTAL_ID ${config.HUBSPOT_PORTAL_ID}. Nothing changed.`);
    process.exit(78);
  }
  console.log(`Portal ${portal} (${config.APP_ENV}). ${dryRun ? 'Dry run: nothing will change.' : ''}`);

  const plan = await planSetup(client);
  if (plan.changes.length === 0) console.log('Already up to date.');
  for (const c of plan.changes) console.log(`  ${dryRun ? 'would' : 'will'} ${describeChange(c)}`);
  if (plan.unusedStages.length) {
    console.log(`Stages not used by PickleMyPaddle (left alone; delete them in HubSpot if empty): ${plan.unusedStages.join(', ')}`);
  }
  if (!dryRun && plan.changes.length) {
    await applySetup(client, plan);
    const after = await planSetup(client);
    if (after.changes.length) {
      console.error(`Still different after applying:\n${after.changes.map((c) => `  ${describeChange(c)}`).join('\n')}`);
      process.exit(1);
    }
    console.log('Done.');
  }
} catch (err) {
  if (err instanceof HubSpotError) {
    const hint =
      err.status === 401 ? ' (the key was refused: check it in the secrets file)'
      : err.status === 403 ? ' (missing scope: the key needs crm.schemas.deals.read/write for this)'
      : err.status === 400 ? ' (HubSpot refused the change: a free-plan limit? Record it on SCRUM-74)'
      : '';
    console.error(`HubSpot said ${err.code}${hint}`);
    process.exit(1);
  }
  throw err;
}
