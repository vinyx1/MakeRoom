// Starts the API: `npm start` (or `npm run dev` to restart on changes). Needs Postgres (`docker compose up -d`,
// then `npm run db:migrate`) and the PayPal sandbox credentials in server/.env.

import '../env.ts';
import Anthropic from '@anthropic-ai/sdk';
import { createAgentService } from '../agent/service.ts';
import { createDb } from '../db/client.ts';
import { payPalGateway } from '../payments/paypal.ts';
import { buildApp, sweepExpiries } from './app.ts';

const { db, pool } = createDb();
const gateway = payPalGateway();
// The live-demo model is still an open decision (spikes/agent/FINDINGS.md): set AGENT_MODEL to switch.
const agent = createAgentService(db, {
  client: process.env.ANTHROPIC_API_KEY ? new Anthropic() : null,
  model: process.env.AGENT_MODEL ?? 'claude-opus-5-5',
  effort: (process.env.AGENT_EFFORT as 'low' | 'medium' | 'high' | undefined) ?? 'medium',
  turnCap: Number(process.env.AGENT_TURN_CAP ?? 60),
}, (msg) => app.log.info(msg));
const app = buildApp({
  db,
  gateway,
  agent,
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
