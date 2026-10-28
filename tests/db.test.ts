/** Migrations (SCRUM-64): empty → latest, and re-running changes nothing. */
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { currentVersion, LATEST_VERSION, migrate, MIGRATIONS } from '../src/db/migrations.js';
import { DB_BACKEND, emptyDb } from './helpers/db.js';

let db: Db | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

const tables = async (d: Db) =>
  (await d.query<{ t: string }>(
    "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY 1",
  )).rows.map((r) => r.t);

describe(`migrations (${DB_BACKEND})`, () => {
  it('build the order schema from an empty database', async () => {
    db = await emptyDb();
    expect(await migrate(db)).toBe(LATEST_VERSION);
    expect(await tables(db)).toEqual([
      'app_secrets', 'orders', 'outbox', 'paddles', 'photos', 'rate_limit_events', 'reviews', 'schema_migrations', 'status_history', 'status_tokens',
    ]);
  });

  it('do nothing when run again', async () => {
    db = await emptyDb();
    await migrate(db);
    const before = await db.query('SELECT version, applied_at FROM schema_migrations ORDER BY version');
    expect(await migrate(db)).toBe(LATEST_VERSION);
    expect((await db.query('SELECT version, applied_at FROM schema_migrations ORDER BY version')).rows).toEqual(before.rows);
    expect(await currentVersion(db)).toBe(LATEST_VERSION);
  });

  it('have unique, increasing versions', () => {
    const v = MIGRATIONS.map((m) => m.version);
    expect(v).toEqual([...v].sort((a, b) => a - b));
    expect(new Set(v).size).toBe(v.length);
  });

  it('keep photo bytes out of the database (paths and metadata only)', async () => {
    db = await emptyDb();
    await migrate(db);
    const cols = (await db.query<{ c: string; t: string }>(
      "SELECT column_name AS c, data_type AS t FROM information_schema.columns WHERE table_name = 'photos' AND table_schema = current_schema()",
    )).rows;
    expect(cols.map((c) => c.c).sort()).toEqual(['bytes', 'created_at', 'height', 'id', 'paddle_id', 'path', 'side', 'width']);
    expect(cols.some((c) => c.t === 'bytea')).toBe(false);
  });
});
