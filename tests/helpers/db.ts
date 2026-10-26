/**
 * A fresh, empty, migrated order database for each test (SCRUM-64).
 *
 *  - TEST_DATABASE_URL set (CI's container test): a new schema on that real Postgres server.
 *  - otherwise: PGlite, Postgres compiled to WebAssembly, in-process.
 *
 * Either way the SQL runs on genuine Postgres. DB_BACKEND says which one ran, and CI prints it
 * as an annotation, so a green tick shows the database tests really ran against Postgres.
 */
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createPgDb, type Db } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrations.js';

export const DB_BACKEND = process.env.TEST_DATABASE_URL ? 'postgres' : 'pglite';

function wrap(pg: PGlite): Db {
  return {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: async (sql) => {
      await pg.exec(sql);
    },
    tx: (fn) =>
      pg.transaction((t) =>
        fn({
          query: (sql, params) => t.query(sql, params) as never,
          exec: async (sql) => {
            await t.exec(sql);
          },
        }),
      ),
    close: async () => {
      if (!pg.closed) await pg.close();
    },
  };
}

async function postgresDb(url: string): Promise<Db> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = createPgDb(url, { max: 1 });
  await admin.exec(`CREATE SCHEMA ${schema}`);
  await admin.close();
  // Queries queue on a client in order, so this runs before anything the test sends.
  const db = createPgDb(url, {}, (client) => void client.query(`SET search_path TO ${schema}`));
  return {
    ...db,
    async close() {
      await db.exec(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
      await db.close();
    },
  };
}

/** An empty database (no tables). */
export async function emptyDb(): Promise<Db> {
  return process.env.TEST_DATABASE_URL ? postgresDb(process.env.TEST_DATABASE_URL) : wrap(new PGlite());
}

// Starting PGlite takes seconds; cloning an already-migrated one takes a fraction of that.
let template: Promise<PGlite> | undefined;
async function migratedTemplate(): Promise<PGlite> {
  template ??= (async () => {
    const pg = new PGlite();
    await migrate(wrap(pg));
    return pg;
  })();
  return template;
}

/** An empty database migrated to the latest schema. */
export async function testDb(): Promise<Db> {
  if (process.env.TEST_DATABASE_URL) {
    const db = await postgresDb(process.env.TEST_DATABASE_URL);
    await migrate(db);
    return db;
  }
  return wrap((await (await migratedTemplate()).clone()) as PGlite);
}
