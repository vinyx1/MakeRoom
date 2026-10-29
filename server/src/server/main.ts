// Starts the API: `npm start` (or `npm run dev` to restart on changes). Needs Postgres (`docker compose up -d`,
// then `npm run db:migrate`) and the PayPal sandbox credentials in server/.env.

import '../env.ts';
import Anthropic from '@anthropic-ai/sdk';
import { createAgentService } from '../agent/service.ts';
import { createAutoReply } from '../demo/auto-reply.ts';
import { createDb } from '../db/client.ts';
import { payPalGateway } from '../payments/paypal.ts';
import { buildApp, sweepExpiries } from './app.ts';

const { db, pool } = createDb();
const gateway = payPalGateway();
// Sonnet 5.5 for the live demo (decided 2026-10-29: Opus 5.5 was ~$0.04/turn); AGENT_MODEL overrides.
const agent = createAgentService(db, {
  client: process.env.ANTHROPIC_API_KEY ? new Anthropic() : null,
  model: process.env.AGENT_MODEL ?? 'claude-sonnet-5-5',
  effort: (process.env.AGENT_EFFORT as 'low' | 'medium' | 'high' | undefined) ?? 'medium',
  turnCap: Number(process.env.AGENT_TURN_CAP ?? 60),
}, (msg) => app.log.info(msg), {}, createAutoReply(db, gateway));
const app = buildApp({
  db,
  gateway,
  agent,
  paypalClientId: process.env.PAYPAL_CLIENT_ID,
  secureCookies: process.env.NODE_ENV === 'production',
  // Shown beside the PayPal button so a judge can log in to the sandbox popup (CLAUDE.md "Judge mode").
  sandboxBuyer: process.env.PAYPAL_SANDBOX_BUYER_EMAIL
    ? { email: process.env.PAYPAL_SANDBOX_BUYER_EMAIL, password: process.env.PAYPAL_SANDBOX_BUYER_PASSWORD ?? '' }
    : undefined,
  // `npm run dev:test-card`: pay with the sandbox test card from a terminal client (scripts/try.ts).
  allowTestCard: process.env.DEV_TEST_CARD === '1' && process.env.NODE_ENV !== 'production',
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

agent.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, async () => {
    clearInterval(sweep);
    agent.stop();
    await agent.drain();
    await app.close();
    await pool.end();
    process.exit(0);
  });

await app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? '127.0.0.1' });
