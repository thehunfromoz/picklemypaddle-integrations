/**
 * The order database (SCRUM-64): a thin interface over PostgreSQL.
 *
 * The service talks to a real Postgres through `pg`. Tests use the same interface over PGlite
 * (Postgres compiled to WebAssembly, in-process) or, in CI, a real Postgres container
 * (tests/helpers/db.ts), so every query runs against genuine Postgres SQL either way.
 */
import pg from 'pg';

export interface Queryable {
  /** One parameterised statement ($1, $2, ...). */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Several statements, no parameters (migrations). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /** Runs fn in one transaction: committed if it resolves, rolled back if it throws. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Postgres error codes we act on. */
export const PG_UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return !!e && e.code === PG_UNIQUE_VIOLATION && (!constraint || e.constraint === constraint);
}

/** A pool of connections to a real Postgres server. */
export function createPgDb(
  connectionString: string,
  options: Partial<pg.PoolConfig> = {},
  onConnect?: (client: pg.PoolClient) => void,
): Db {
  const pool = new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, ...options });
  if (onConnect) pool.on('connect', onConnect);
  // An idle client losing its connection must not crash the process; the next query reconnects.
  pool.on('error', (err) => console.error(JSON.stringify({ event: 'db_pool_error', error: err.name })));
  return {
    query: (sql, params) => pool.query(sql, params) as never,
    async exec(sql) {
      await pool.query(sql);
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: (sql, params) => client.query(sql, params) as never,
          exec: async (sql) => {
            await client.query(sql);
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
