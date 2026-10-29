// Starts the API: `npm start` (or `npm run dev` to restart on changes). Needs Postgres (`docker compose up -d`,
// then `npm run db:migrate`) and the PayPal sandbox credentials in server/.env.

import { existsSync } from 'node:fs';
import { createDb } from '../db/client.ts';
import { payPalGateway } from '../payments/paypal.ts';
import { buildApp, sweepExpiries } from './app.ts';

const envFile = new URL('../../.env', import.meta.url).pathname;
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { db, pool } = createDb();
const gateway = payPalGateway();
const app = buildApp({
  db,
  gateway,
  paypalClientId: process.env.PAYPAL_CLIENT_ID,
  secureCookies: process.env.NODE_ENV === 'production',
  logger: true,
});

// Approval timeouts fire on their own, not only on the next click.
let sweeping = false;
const sweep = setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    const expired = await sweepExpiries(db, gateway);
    if (expired.length) app.log.info({ expired }, 'expired proposals');
  } catch (e) {
    app.log.error(e, 'expiry sweep failed');
  } finally {
    sweeping = false;
  }
}, 10_000);

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, async () => {
    clearInterval(sweep);
    await app.close();
    await pool.end();
    process.exit(0);
  });

await app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? '127.0.0.1' });
