import pg from 'pg';

import { config } from '../config/env.js';

const { Pool } = pg;

let pool = null;
let usingPostgres = false;

/**
 * Opens the Postgres pool.
 *
 * Returns false when there is no connection string, which is not a failure: it
 * is how a checkout runs with no database at all, and the repositories fall
 * back to the in-memory driver.
 *
 * Throws when a connection string is set and the database behind it cannot be
 * reached. That is a fault rather than a mode, and it used to fall back to the
 * same in-memory store — which booted an application that looked entirely
 * healthy, accepted writes, and lost every one of them on the next restart.
 * plugins/db.js catches this and records the subsystem as down instead.
 */
export async function connect() {
  if (!config.connectionString) {
    console.log('ℹ️ DB_STRING not set. Using the in-memory store.');
    return false;
  }

  try {
    pool = new Pool({
      connectionString: config.connectionString,
      // TLS is the connection string's business: pg parses DB_STRING after this
      // object and its sslmode wins over anything set here. A hosted database
      // wants sslmode=verify-full — bare 'require' means the same today, but is
      // due to loosen to "encrypt, verify nothing" in pg 9.
      connectionTimeoutMillis: 5000,
    });

    const client = await pool.connect();
    client.release();

    usingPostgres = true;
    console.log('✅ Connected to PostgreSQL database.');
    return true;
  } catch (err) {
    if (pool) await pool.end().catch(() => {});
    pool = null;
    usingPostgres = false;
    throw err;
  }
}

export function isPostgres() {
  return usingPostgres;
}

/** Runs a query on the pool, or on `client` when inside a transaction. */
export function query(text, params = [], client = null) {
  return (client || pool).query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function close() {
  if (pool) {
    await pool.end();
    pool = null;
    usingPostgres = false;
  }
}
