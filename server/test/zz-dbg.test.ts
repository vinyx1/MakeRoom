import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { conversationOf, runTurn } from '../src/agent/turn.ts';
import { createDb } from '../src/db/client.ts';
import * as s from '../src/db/schema.ts';
import { seedShop } from '../src/db/seed.ts';
it('dbg', async () => {
  const { db, pool } = createDb();
  const d = await seedShop(db, { sessionKey: randomUUID() });
  const lines: string[] = [];
  const cfg = { client: new Anthropic(), model: 'claude-haiku-5-5', effort: 'medium' as const, turnCap: 60 };
  for (let i = 0; i < 3; i++) {
    const r = await runTurn(db, cfg, { shopId: d.shop.id, customerId: d.customer('Alice').id, event: { kind: 'customer_message', text: 'Shoot ran over. Can I keep the camera until Thursday at 10am?' } }, (l) => lines.push(l));
    lines.push('TOOLS ' + JSON.stringify(r.toolCalls.map(c => c.name)));
    await db.delete(s.proposals).where(eq(s.proposals.shopId, d.shop.id));
  }
  const conv = await conversationOf(db, d.shop.id, d.customer('Alice').id, d.now);
  for (const m of await db.select().from(s.messages).where(eq(s.messages.conversationId, conv.id)).orderBy(s.messages.at)) lines.push(`${m.author}: ${m.body} ${m.cardRevisionIds.length ? '[card]' : ''}`);
  writeFileSync('/private/tmp/claude-501/-Users-vince/afc35fac-5584-422a-944a-0f5582d3fb43/scratchpad/agentdbg/out.txt', lines.join('\n'));
  await pool.end();
}, 120000);
