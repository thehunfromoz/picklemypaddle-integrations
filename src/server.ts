import { serve } from '@hono/node-server';
import { ConfigError, describeConfig, loadConfig, type Config } from './config.js';
import { createApp } from './app.js';

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
const app = createApp(config);
const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`integrations listening on :${info.port}`, describeConfig(config));
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
