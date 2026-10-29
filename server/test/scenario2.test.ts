// Demo Scenario 2, "The owner drags, the agent asks", end to end: drag → red draft → Resolve with agent → owner
// card with a fact question → Yes + approve → Save as fact → Dana pays → Eve accepts → commit. Plus judge D8 (the
// owner answers No), a customer's fact question, and Scenario 6's messages, with the agent on templates.

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { afterAll, describe, expect, it } from 'vitest';
import { createAgentService } from '../src/agent/service.ts';
import { createAutoReply } from '../src/demo/auto-reply.ts';
import { TurnState, makeTools } from '../src/agent/tools.ts';
import { type AgentConfig, conversationOf } from '../src/agent/turn.ts';
import { createDb } from '../src/db/client.ts';
import * as s from '../src/db/schema.ts';
import { seedShop } from '../src/db/seed.ts';
import { ownerEditBooking } from '../src/owner/edit-booking.ts';
import { saveFact } from '../src/owner/facts.ts';
import { seedPrepayments } from '../src/payments/prepay.ts';
import { affectedAccept, createRequesterOrder, ownerDecision, requestChange, requesterAccept, resolveDraft } from '../src/proposals/flow.ts';
import { fakeGateway } from './fake-gateway.ts';

const { db, pool } = createDb();
afterAll(() => pool.end());

type Seeded = Awaited<ReturnType<typeof seedShop>>;
const templates: AgentConfig = { client: null, model: 'none', effort: 'low', turnCap: 60 };

function at(d: Seeded, day: 'Thu' | 'Fri', hour: number) {
  return DateTime.fromJSDate(d.now, { zone: d.shop.timezone }).startOf('week').plus({ days: day === 'Thu' ? 3 : 4 }).set({ hour }).toJSDate();
}

async function shop() {
  const gateway = fakeGateway();
  const d = await seedShop(db, { sessionKey: randomUUID() });
  await seedPrepayments(db, gateway, d.shop.id);
  const agent = createAgentService(db, templates, undefined, { shopId: d.shop.id });
  await agent.poll(); // from now on
  return { d, gateway, agent };
}

/** Step 1: the owner drags the end of Dana's RS3 booking to Fri 9am, ticking "Dana agreed by phone". */
async function danaDragged(d: Seeded, gateway: ReturnType<typeof fakeGateway>) {
  const dana = d.bookingOf('Dana');
  const result = await ownerEditBooking(db, gateway, d.shop.id, {
    bookingId: dana.id, unitId: dana.unitId!, startsAt: dana.startsAt, endsAt: at(d, 'Fri', 9), basedOnVersion: dana.version, attestedCustomerIds: [dana.customerId],
  });
  if (result.status !== 'draft') throw new Error(result.status);
  return result.draftId;
}

const thread = async (d: Seeded, name: string) =>
  db.select().from(s.messages).where(eq(s.messages.conversationId, (await conversationOf(db, d.shop.id, d.customer(name).id, d.now)).id)).orderBy(s.messages.at);

describe('Scenario 2: the owner drags, the agent asks', () => {
  it('runs from the red draft to commit, and learns the fact on the way', async () => {
    const { d, gateway, agent } = await shop();
    const fact = d.facts[0]!;
    const [dana, eve] = [d.bookingOf('Dana'), d.bookingOf('Eve')];

    // Steps 1–2: the draft overlaps Eve; Resolve with agent finds one plan, which needs the owner.
    const draftId = await danaDragged(d, gateway);
    const resolved = await resolveDraft(db, d.shop.id, { draftId });
    if (resolved.status !== 'resolved') throw new Error(JSON.stringify(resolved));
    expect(resolved.proposal).toMatchObject({ source: 'owner_resolve', state: 'DRAFT', requesterCustomerId: dana.customerId });
    const [plan] = resolved.revisions;
    expect(resolved.revisions).toHaveLength(1);
    expect(plan!.envelopeTrips).toContain('downgrade');
    expect(plan!.ownerTriggers).toContain('unknown_fact');
    expect(plan!.factDependencies).toEqual([fact.id]);
    expect(await db.select().from(s.ownerDrafts).where(eq(s.ownerDrafts.id, draftId))).toEqual([]);

    // Step 3: the owner card, rendered by the backend, with the fact question.
    const [card] = await db.select().from(s.escalations).where(and(eq(s.escalations.proposalId, resolved.proposal.id), eq(s.escalations.kind, 'plan_review')));
    expect(card!.summary).toBe(
      'Eve moved to the Zhiyun Crane 4 gimbal (downgrade), $20 refund. Net +$5. Needs a fact: Eve\'s booking says "for Canon R5 + RF 24-70". CRANE4-1: Balances a Canon R5 + RF 24-70?',
    );
    // Dana agreed by phone; nothing reaches Eve while the plan waits for the shop.
    const [danaApproval] = await db.select().from(s.approvals).where(and(eq(s.approvals.proposalId, resolved.proposal.id), eq(s.approvals.role, 'requester')));
    expect([danaApproval!.status, danaApproval!.source]).toEqual(['approved', 'owner_attested']);

    // The owner can't approve without answering; answering Yes approves and offers "Save as fact".
    expect((await ownerDecision(db, gateway, d.shop.id, { proposalId: resolved.proposal.id, revisionId: plan!.id, decision: 'approve' })).status).toBe('refused');
    const approved = await ownerDecision(db, gateway, d.shop.id, {
      proposalId: resolved.proposal.id, revisionId: plan!.id, decision: 'approve', factAnswers: { [fact.id]: 'yes' },
    });
    expect(approved).toEqual({ status: 'awaiting_approvals', waitingOn: ['requester'], saveableFacts: [{ factId: fact.id, value: 'yes', label: 'Balances a Canon R5 + RF 24-70' }] });

    // Step 4: Save as fact. The fact flips to yes, sourced to the owner at the shop's time.
    const saved = await saveFact(db, d.shop.id, { factId: fact.id, value: 'yes' });
    expect(saved.status).toBe('saved');
    if (saved.status === 'saved') expect([saved.fact.value, saved.fact.source, saved.fact.setAt.getTime() - d.now.getTime() < 60_000]).toEqual(['yes', 'owner', true]);

    // Step 5: Dana gets the card and pays; then Eve is offered the Crane 4 and accepts.
    await agent.poll();
    await agent.drain();
    expect((await thread(d, 'Dana')).some((m) => m.cardRevisionIds.includes(plan!.id))).toBe(true);
    await createRequesterOrder(db, gateway, d.shop.id, { proposalId: resolved.proposal.id, customerId: dana.customerId });
    const paid = await requesterAccept(db, gateway, d.shop.id, { proposalId: resolved.proposal.id, customerId: dana.customerId });
    expect(paid).toMatchObject({ status: 'awaiting_approvals', offers: [{ customerId: eve.customerId, revisionIds: [plan!.id] }] });
    await agent.poll();
    await agent.drain();
    expect((await thread(d, 'Eve')).some((m) => m.cardRevisionIds.includes(plan!.id))).toBe(true);

    const done = await affectedAccept(db, gateway, d.shop.id, { proposalId: resolved.proposal.id, customerId: eve.customerId, revisionId: plan!.id });
    expect(done.status).toBe('committed');

    const [danaAfter] = await db.select().from(s.bookings).where(eq(s.bookings.id, dana.id));
    const [eveAfter] = await db.select().from(s.bookings).where(eq(s.bookings.id, eve.id));
    expect(danaAfter!.endsAt).toEqual(at(d, 'Fri', 9));
    expect([eveAfter!.unitId, eveAfter!.modelId, eveAfter!.startsAt]).toEqual([d.unit('CRANE4-1').id, d.modelsByName.crane4.id, eve.startsAt]);
    expect(gateway.calls.filter((c) => c.method === 'captureAuthorization' || c.method === 'refundCapture').map((c) => [c.method, c.amountCents]))
      .toEqual([['captureAuthorization', 2500], ['refundCapture', 2000]]);

    await agent.poll();
    await agent.drain();
    expect((await thread(d, 'Eve')).at(-1)!.body).toContain('$20.00');
  });

  it('judge D8: answering No declines the plan and offers to save the No', async () => {
    const { d, gateway } = await shop();
    const fact = d.facts[0]!;
    const resolved = await resolveDraft(db, d.shop.id, { draftId: await danaDragged(d, gateway) });
    if (resolved.status !== 'resolved') throw new Error(resolved.status);
    const result = await ownerDecision(db, gateway, d.shop.id, {
      proposalId: resolved.proposal.id, revisionId: resolved.revisions[0]!.id, decision: 'approve', factAnswers: { [fact.id]: 'no' },
    });
    expect(result).toEqual({ status: 'rejected', saveableFacts: [{ factId: fact.id, value: 'no', label: 'Balances a Canon R5 + RF 24-70' }] });
    const [p] = await db.select().from(s.proposals).where(eq(s.proposals.id, resolved.proposal.id));
    expect(p!.state).toBe('REJECTED');
    const [eve] = await db.select().from(s.bookings).where(eq(s.bookings.id, d.bookingOf('Eve').id));
    expect(eve!.version).toBe(1);
  });

  it('a resolve needs the customer’s agreement', async () => {
    const { d, gateway } = await shop();
    const dana = d.bookingOf('Dana');
    const draft = await ownerEditBooking(db, gateway, d.shop.id, {
      bookingId: dana.id, unitId: dana.unitId!, startsAt: dana.startsAt, endsAt: at(d, 'Fri', 9), basedOnVersion: dana.version, attestedCustomerIds: [],
    });
    if (draft.status !== 'draft') throw new Error(draft.status);
    expect(await resolveDraft(db, d.shop.id, { draftId: draft.draftId })).toMatchObject({ status: 'refused', reason: expect.stringContaining('agreed by phone') });
  });

  it('the requester can use the card the agent posts for a phone-agreed request', async () => {
    const { d, gateway } = await shop();
    const resolved = await resolveDraft(db, d.shop.id, { draftId: await danaDragged(d, gateway) });
    if (resolved.status !== 'resolved') throw new Error(resolved.status);
    await ownerDecision(db, gateway, d.shop.id, {
      proposalId: resolved.proposal.id, revisionId: resolved.revisions[0]!.id, decision: 'approve', factAnswers: { [d.facts[0]!.id]: 'yes' },
    });
    const danaId = d.customer('Dana').id;
    const conversation = await conversationOf(db, d.shop.id, danaId, d.now);
    const turn = new TurnState();
    const tools = makeTools({ db, shopId: d.shop.id, customerId: danaId, conversationId: conversation.id, turn, now: () => d.now, onStep: () => {} });
    const call = async (name: string, input: unknown) => JSON.parse(await (tools.find((t) => t.name === name)!.run as (i: unknown) => Promise<string>)(input));
    const [request] = (await call('get_my_proposals', {})).requests;
    expect(request.options[0].terms[1]).toContain('$25.00');
    expect(await call('present_offer', { revision_ids: [request.options[0].revision_id] })).toMatchObject({ ok: true, buttons: ['Accept and authorize $25.00 with PayPal', 'Not now'] });
  });
});

describe('a customer’s fact question', () => {
  it('reaches the customer once the owner saves the answer', async () => {
    const { d, agent } = await shop();
    const eve = d.customer('Eve').id;
    const conversation = await conversationOf(db, d.shop.id, eve, d.now);
    const tools = makeTools({ db, shopId: d.shop.id, customerId: eve, conversationId: conversation.id, turn: new TurnState(), now: () => d.now, onStep: () => {} });
    await (tools.find((t) => t.name === 'ask_owner_fact')!.run as (i: unknown) => Promise<string>)({ subject: 'Sony A7 IV', key: 'weather_sealed', question: 'Is it weather-sealed?' });
    const [fact] = await db.select().from(s.facts).where(and(eq(s.facts.shopId, d.shop.id), eq(s.facts.key, 'weather_sealed')));
    expect([fact!.value, fact!.source, fact!.label]).toEqual(['unknown', 'agent', 'Is it weather-sealed?']);

    await saveFact(db, d.shop.id, { factId: fact!.id, value: 'yes' });
    await agent.poll();
    await agent.drain();
    expect((await thread(d, 'Eve')).at(-1)!.body).toBe('The shop has answered your question: yes.');
    const open = await db.select().from(s.escalations).where(and(eq(s.escalations.shopId, d.shop.id), eq(s.escalations.status, 'open')));
    expect(open).toEqual([]);
  });
});

describe('Scenario 6: everyone hears about the override', () => {
  it('Bob is told his booking stands; Alice is told, and gets a fresh offer against the new schedule', async () => {
    const { d, gateway, agent } = await shop();
    const alice = d.customer('Alice').id;
    const offered = await requestChange(db, d.shop.id, { customerId: alice, request: { kind: 'extend', bookingId: d.bookingOf('Alice').id, newEndsAt: at(d, 'Thu', 10) } });
    if (offered.status !== 'offered') throw new Error(offered.status);
    await createRequesterOrder(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: alice });
    await requesterAccept(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: alice });
    await agent.poll();
    await agent.drain();

    const bob = d.bookingOf('Bob');
    const result = await ownerEditBooking(db, gateway, d.shop.id, {
      bookingId: bob.id, unitId: bob.unitId!, startsAt: at(d, 'Thu', 14), endsAt: bob.endsAt, basedOnVersion: bob.version, attestedCustomerIds: [bob.customerId], override: true,
    });
    if (result.status !== 'applied') throw new Error(result.status);
    const replan = result.cancelled[0]!.replan!;
    expect(replan.status).toBe('offered');
    if (replan.status === 'offered') expect(replan.chargeCents).toBe(4500);

    await agent.poll();
    await agent.drain();
    const aliceMsgs = await thread(d, 'Alice');
    expect(aliceMsgs.map((m) => m.body).join(' ')).toContain('didn’t go through');
    expect(aliceMsgs.some((m) => replan.status === 'offered' && m.cardRevisionIds.includes(replan.revisions[0]!.id))).toBe(true);
    const bobThread = await thread(d, 'Bob');
    expect(bobThread.at(-1)!.body).toBe("The other customer's request was withdrawn, so it won't change your booking.");

  });

  it('an offer that ended before its turn ran is skipped, never shown as a stale card', async () => {
    const { d, gateway, agent } = await shop();
    const alice = d.customer('Alice').id;
    const offered = await requestChange(db, d.shop.id, { customerId: alice, request: { kind: 'extend', bookingId: d.bookingOf('Alice').id, newEndsAt: at(d, 'Thu', 10) } });
    if (offered.status !== 'offered') throw new Error(offered.status);
    await createRequesterOrder(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: alice });
    await requesterAccept(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: alice });
    // The owner overrides before the dispatcher has run Bob's offer turn.
    const bob = d.bookingOf('Bob');
    await ownerEditBooking(db, gateway, d.shop.id, {
      bookingId: bob.id, unitId: bob.unitId!, startsAt: at(d, 'Thu', 14), endsAt: bob.endsAt, basedOnVersion: bob.version, attestedCustomerIds: [bob.customerId], override: true,
    });
    await agent.poll();
    await agent.drain();
    const bobThread = await thread(d, 'Bob');
    expect(bobThread.filter((m) => m.cardRevisionIds.length)).toEqual([]);
    expect(bobThread.map((m) => m.body)).toEqual(["The other customer's request was withdrawn, so it won't change your booking."]);
  });
});

describe('judge mode: auto-reply customers', () => {
  async function aliceAccepts(autoReply: boolean) {
    const gateway = fakeGateway();
    const d = await seedShop(db, { sessionKey: randomUUID() });
    await seedPrepayments(db, gateway, d.shop.id);
    await db.update(s.shops).set({ autoReplyCustomers: autoReply }).where(eq(s.shops.id, d.shop.id));
    const agent = createAgentService(db, templates, undefined, { shopId: d.shop.id }, createAutoReply(db, gateway, { delayMs: 0 }));
    await agent.poll();
    const alice = d.customer('Alice').id;
    const offered = await requestChange(db, d.shop.id, { customerId: alice, request: { kind: 'extend', bookingId: d.bookingOf('Alice').id, newEndsAt: at(d, 'Thu', 10) } });
    if (offered.status !== 'offered') throw new Error(offered.status);
    await createRequesterOrder(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: alice });
    await requesterAccept(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: alice });
    await agent.poll();
    await agent.drain();
    const bobApprovals = await db.select().from(s.approvals).where(and(eq(s.approvals.proposalId, offered.proposal.id), eq(s.approvals.customerId, d.customer('Bob').id)));
    return { d, offered, bobApprovals };
  }

  it('off: Bob waits for a person to choose', async () => {
    const { bobApprovals } = await aliceAccepts(false);
    expect(bobApprovals.every((a) => a.status === 'pending')).toBe(true);
  });

  it('on: Bob takes Plan B by himself after the offer, and the owner card appears', async () => {
    const { d, offered, bobApprovals } = await aliceAccepts(true);
    const planB = offered.revisions.find((r) => r.optionLabel === 'B')!;
    expect(bobApprovals.find((a) => a.revisionId === planB.id)!.status).toBe('approved');
    const bobChat = await thread(d, 'Bob');
    expect(bobChat.map((m) => m.body)).toContain('Option B works for me, thanks.');
    // His message comes after the assistant's offer, as a person would answer it.
    expect(bobChat.findIndex((m) => m.author === 'customer')).toBeGreaterThan(bobChat.findIndex((m) => m.cardRevisionIds.length > 0));
    const cards = await db.select().from(s.escalations).where(and(eq(s.escalations.proposalId, offered.proposal.id), eq(s.escalations.status, 'open')));
    expect(cards.map((c) => c.kind)).toEqual(['approval']);
  });
});

