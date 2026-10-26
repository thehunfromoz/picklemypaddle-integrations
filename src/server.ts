import { serve } from '@hono/node-server';
import { ConfigError, describeConfig, loadConfig, type Config } from './config.js';
import { createApp } from './app.js';
import { createPgDb } from './db/db.js';
import { migrate } from './db/migrations.js';
import { startJobs } from './jobs.js';
import { log, logError } from './log.js';
import { loadAbuseKeys, TrustedProxies } from './orders/abuse.js';
import { fsPhotoStore } from './orders/photos.js';

function configOrExit(): Readonly<Config> {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Names the problem settings, never their values. Exit code 78 = configuration error.
      console.error(`picklemypaddle-integrations will not start.\n${err.message}`);
      process.exit(78);
    }
    throw err;
  }
}

const config = configOrExit();
const db = createPgDb(config.DATABASE_URL);

// The schema must be current before we accept a single request (SCRUM-64). If it can't be
// brought up to date, exit: the container never becomes healthy and staging rolls back.
let version: number;
try {
  version = await migrate(db);
} catch (err) {
  logError('migration_failed', err);
  process.exit(1);
}
log('database_ready', { migration: version });

const photos = fsPhotoStore(config.PHOTO_DIR);
const app = createApp(config, {
  db,
  photos,
  keys: await loadAbuseKeys(db),
  trusted: new TrustedProxies(config.TRUSTED_PROXIES),
  mailer: null, // order emails arrive with SCRUM-69
});

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`integrations listening on :${info.port}`, describeConfig(config));
});
// SCRUM-67: a slow upload gets at most 2 minutes.
const http = server as unknown as { requestTimeout: number; headersTimeout: number };
http.requestTimeout = 120_000;
http.headersTimeout = 30_000;

const stopJobs = startJobs(db, photos);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopJobs();
    server.close(() => void db.close().finally(() => process.exit(0)));
  });
}
