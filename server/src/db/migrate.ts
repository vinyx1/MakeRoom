import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client.ts';

const { db, pool } = createDb();
await migrate(db, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname });
await pool.end();
console.log('Migrations applied.');
