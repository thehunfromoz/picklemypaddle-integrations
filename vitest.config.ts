import { defineConfig } from 'vitest/config';

// PGlite takes a few seconds to start on a CI runner (the first database in each file is a new
// instance; the rest are fast clones), and the container test runs the suite on real Postgres.
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 60_000 } });
