// Starts the API: `npm start` (or `npm run dev` to restart on changes). Needs Postgres (`docker compose up -d`,
// then `npm run db:migrate`) and the PayPal sandbox credentials in server/.env.

import '../env.ts';
import { existsSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { createAgentService } from '../agent/service.ts';
import { createAutoReply } from '../demo/auto-reply.ts';
import { createDb } from '../db/client.ts';
import { payPalGateway } from '../payments/paypal.ts';
import { buildApp, sweepExpiries } from './app.ts';
import { cleanupStaleShops } from './shops.ts';

const production = process.env.NODE_ENV === 'production';
const { db, pool } = createDb();
const webRoot = new URL('../../../web/dist/', import.meta.url).pathname;
const gateway = payPalGateway();
// Sonnet 5.5 for the live demo (decided 2026-10-29: Opus 5.5 was ~$0.04/turn); AGENT_MODEL overrides.
const agent = createAgentService(db, {
  client: process.env.ANTHROPIC_API_KEY ? new Anthropic() : null,
  model: process.env.AGENT_MODEL ?? 'claude-sonnet-5-5',
  effort: (process.env.AGENT_EFFORT as 'low' | 'medium' | 'high' | undefined) ?? 'medium',
  turnCap: Number(process.env.AGENT_TURN_CAP ?? 60),
  dailySpendCapUsd: Number(process.env.AGENT_DAILY_SPEND_USD ?? 5),
}, (msg) => app.log.info(msg), {}, createAutoReply(db, gateway));
const app = buildApp({
  db,
  gateway,
  agent,
  paypalClientId: process.env.PAYPAL_CLIENT_ID,
  secureCookies: production,
  rateLimit: true,
  // Off in development, where resets and fresh sessions are constant. Railway's edge is the one proxy in front.
  shopsPerIpPerHour: production ? Number(process.env.SHOPS_PER_IP_PER_HOUR ?? 5) : undefined,
  trustedProxies: production ? 1 : undefined,
  // Shown beside the PayPal button so a judge can log in to the sandbox popup (CLAUDE.md "Judge mode").
  sandboxBuyer: process.env.PAYPAL_SANDBOX_BUYER_EMAIL
    ? { email: process.env.PAYPAL_SANDBOX_BUYER_EMAIL, password: process.env.PAYPAL_SANDBOX_BUYER_PASSWORD ?? '' }
    : undefined,
  // `npm run dev:test-card`: pay with the sandbox test card from a terminal client (scripts/try.ts).
  allowTestCard: process.env.DEV_TEST_CARD === '1' && !production,
  // In production the server hosts the frontend too; `npm run build` in web/ makes this folder.
  webRoot: production && existsSync(webRoot) ? webRoot : undefined,
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

// Old shops: their rows and open holds shouldn't outlive the visitor's interest.
const cleanup = async () => {
  try {
    const removed = await cleanupStaleShops(db, gateway);
    if (removed) app.log.info({ removed }, 'removed stale shops');
  } catch (e) {
    app.log.error(e, 'stale shop cleanup failed');
  }
};
const cleanupTimer = setInterval(cleanup, 3600_000);
void cleanup();

agent.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, async () => {
    clearInterval(sweep);
    clearInterval(cleanupTimer);
    agent.stop();
    await agent.drain();
    await app.close();
    await pool.end();
    process.exit(0);
  });

await app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? '127.0.0.1' });
