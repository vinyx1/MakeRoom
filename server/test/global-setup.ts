// Recreates the test database from the migrations once per run. Needs `docker compose up -d`.
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { createDb } from '../src/db/client.ts';
import { TEST_DATABASE_URL } from '../vitest.config.ts';

export async function setup() {
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL.replace(/\/makeroom_test$/, '/makeroom') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS makeroom_test WITH (FORCE)');
  await admin.query('CREATE DATABASE makeroom_test');
  await admin.end();

  const { db, pool } = createDb(TEST_DATABASE_URL);
  await migrate(db, { migrationsFolder: new URL('../drizzle', import.meta.url).pathname });
  await pool.end();
}
