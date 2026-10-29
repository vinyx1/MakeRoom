import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { createAgentService } from '../src/agent/service.ts';
import { conversationOf } from '../src/agent/turn.ts';
import { createDb } from '../src/db/client.ts';
import * as s from '../src/db/schema.ts';
import { seedShop } from '../src/db/seed.ts';
import { ownerEditBooking } from '../src/owner/edit-booking.ts';
import { seedPrepayments } from '../src/payments/prepay.ts';
import { createRequesterOrder, ownerDecision, requestChange, requesterAccept, resolveDraft } from '../src/proposals/flow.ts';
import { fakeGateway } from './fake-gateway.ts';
it('live', async () => {
  const { db, pool } = createDb();
  const gw = fakeGateway();
  const d = await seedShop(db, { sessionKey: randomUUID() });
  await seedPrepayments(db, gw, d.shop.id);
  const agent = createAgentService(db, { client: new Anthropic(), model: 'claude-sonnet-5-5', effort: 'medium', turnCap: 60 });
  await agent.poll();
  const at = (day: number, hour: number) => DateTime.fromJSDate(d.now, { zone: d.shop.timezone }).startOf('week').plus({ days: day }).set({ hour }).toJSDate();
  // Scenario 2 to the owner's approval
  const dana = d.bookingOf('Dana');
  const dr: any = await ownerEditBooking(db, gw, d.shop.id, { bookingId: dana.id, unitId: dana.unitId!, startsAt: dana.startsAt, endsAt: at(4, 9), basedOnVersion: 1, attestedCustomerIds: [dana.customerId] });
  const res: any = await resolveDraft(db, d.shop.id, { draftId: dr.draftId });
  await ownerDecision(db, gw, d.shop.id, { proposalId: res.proposal.id, revisionId: res.revisions[0].id, decision: 'approve', factAnswers: { [d.facts[0]!.id]: 'yes' } });
  // Scenario 6 on Alice
  const alice = d.customer('Alice').id;
  const off: any = await requestChange(db, d.shop.id, { customerId: alice, request: { kind: 'extend', bookingId: d.bookingOf('Alice').id, newEndsAt: at(3, 10) } });
  await createRequesterOrder(db, gw, d.shop.id, { proposalId: off.proposal.id, customerId: alice });
  await requesterAccept(db, gw, d.shop.id, { proposalId: off.proposal.id, customerId: alice });
  const bob = d.bookingOf('Bob');
  await ownerEditBooking(db, gw, d.shop.id, { bookingId: bob.id, unitId: bob.unitId!, startsAt: at(3, 14), endsAt: bob.endsAt, basedOnVersion: 1, attestedCustomerIds: [bob.customerId], override: true });
  await agent.poll(); await agent.drain();
  const out: string[] = [];
  for (const name of ['Dana', 'Alice', 'Bob']) {
    const conv = await conversationOf(db, d.shop.id, d.customer(name).id, d.now);
    for (const m of await db.select().from(s.messages).where(eq(s.messages.conversationId, conv.id)).orderBy(s.messages.at)) out.push(`${name} | ${m.author} ${m.cardRevisionIds.length ? '[card]' : ''} ${m.body}`);
  }
  for (const t of await db.select().from(s.activityLog).where(eq(s.activityLog.shopId, d.shop.id))) if (t.kind === 'agent_turn') { const p: any = t.payload; out.push(`TURN ${p.event} fallback=${p.fallback} err=${p.error} tools=${p.toolCalls.map((c: any) => c.name + (c.ok ? '' : ':' + c.code)).join(',')} $${p.costUsd.toFixed(4)}`); }
  writeFileSync('/private/tmp/claude-501/-Users-vince/afc35fac-5584-422a-944a-0f5582d3fb43/scratchpad/agentdbg/live.txt', out.join('\n'));
  await pool.end();
}, 240000);
