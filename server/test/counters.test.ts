// Changing terms mid-request: the requester correcting an unpaid offer, and an affected customer's counter-offer
// (docs/conflict-model.md §4, §7; judge B1–B4). A counter is a draft until its author clicks Send (invariant 3).

import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { afterAll, describe, expect, it } from 'vitest';
import { TurnState, makeTools } from '../src/agent/tools.ts';
import { type AgentConfig, conversationOf, runTurn } from '../src/agent/turn.ts';
import { createAutoReply, scriptedAnswer } from '../src/demo/auto-reply.ts';
import { createDb } from '../src/db/client.ts';
import * as s from '../src/db/schema.ts';
import { seedShop } from '../src/db/seed.ts';
import { seedPrepayments } from '../src/payments/prepay.ts';
import {
  affectedAccept, affectedCounter, affectedRefuse, counterDiscard, counterSend, createRequesterOrder, expireDue, ownerDecision, requestChange, requesterAccept,
} from '../src/proposals/flow.ts';
import { customerView } from '../src/server/views.ts';
import { fakeGateway } from './fake-gateway.ts';

const { db, pool } = createDb();
afterAll(() => pool.end());

type Seeded = Awaited<ReturnType<typeof seedShop>>;

function at(d: Seeded, day: 'Wed' | 'Thu' | 'Fri', hour: number) {
  const days = { Wed: 2, Thu: 3, Fri: 4 }[day];
  return DateTime.fromJSDate(d.now, { zone: d.shop.timezone }).startOf('day').minus({ days: 2 }).plus({ days }).set({ hour }).toJSDate();
}

async function shop() {
  const gateway = fakeGateway();
  const d = await seedShop(db, { sessionKey: randomUUID() });
  await seedPrepayments(db, gateway, d.shop.id);
  return { gateway, d, vincent: d.customer('Vincent').id, bob: d.customer('Bob').id };
}

/** Vincent has paid the hold, so Bob holds the card: option A is the upgrade, B is 2pm with $15 back. */
async function bobAsked() {
  const base = await shop();
  const { gateway, d, vincent } = base;
  const offered = await requestChange(db, d.shop.id, { customerId: vincent, request: { kind: 'extend', bookingId: d.bookingOf('Vincent').id, newEndsAt: at(d, 'Thu', 10) } });
  if (offered.status !== 'offered') throw new Error(JSON.stringify(offered));
  await createRequesterOrder(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: vincent });
  expect((await requesterAccept(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: vincent })).status).toBe('awaiting_approvals');
  return { ...base, proposalId: offered.proposal.id, optionA: offered.revisions[0]!, optionB: offered.revisions[1]! };
}

const load = {
  booking: async (id: string) => (await db.select().from(s.bookings).where(eq(s.bookings.id, id)))[0]!,
  proposal: async (id: string) => (await db.select().from(s.proposals).where(eq(s.proposals.id, id)))[0]!,
  revision: async (id: string) => (await db.select().from(s.revisions).where(eq(s.revisions.id, id)))[0]!,
  approvals: (revisionId: string) => db.select().from(s.approvals).where(eq(s.approvals.revisionId, revisionId)),
  orders: (proposalId: string) => db.select().from(s.paypalOrders).where(eq(s.paypalOrders.proposalId, proposalId)),
  claims: (revisionId: string) => db.select().from(s.claims).where(and(eq(s.claims.revisionId, revisionId), isNull(s.claims.releasedAt))),
};
const cardsOf = (d: Seeded, customerId: string) => db.transaction(async (tx) => (await customerView(tx, d.shop.id, customerId))!.cards);

describe('the requester corrects an offer before paying', () => {
  async function asked() {
    const base = await shop();
    const { d, vincent } = base;
    const booking = d.bookingOf('Vincent').id;
    const ask = (newEndsAt: Date) => requestChange(db, d.shop.id, { customerId: vincent, request: { kind: 'extend', bookingId: booking, newEndsAt } });
    const first = await ask(at(d, 'Fri', 18));
    if (first.status !== 'offered') throw new Error(JSON.stringify(first));
    return { ...base, ask, first };
  }

  it('replaces the offer on the same request, with no cancelling', async () => {
    const { d, gateway, vincent, ask, first } = await asked();
    await createRequesterOrder(db, gateway, d.shop.id, { proposalId: first.proposal.id, customerId: vincent }); // He opened PayPal, then changed his mind.
    const second = await ask(at(d, 'Thu', 10));
    if (second.status !== 'offered') throw new Error(JSON.stringify(second));

    expect(second.proposal.id).toBe(first.proposal.id);
    expect(second.chargeCents).toBe(4500);
    expect((await load.revision(first.revisions[0]!.id)).status).toBe('superseded');
    expect((await load.orders(first.proposal.id)).map((o) => o.status)).toEqual(['voided']);
    expect(await cardsOf(d, vincent)).toMatchObject([{ proposalId: first.proposal.id, role: 'requester', chargeCents: 4500 }]);
    expect((await load.proposal(first.proposal.id)).request).toMatchObject({ newEndsAt: at(d, 'Thu', 10).toISOString() });

    // Paying now pays the new amount, and the request carries on as usual.
    await createRequesterOrder(db, gateway, d.shop.id, { proposalId: first.proposal.id, customerId: vincent });
    expect((await load.orders(first.proposal.id)).map((o) => [o.status, o.amountCents]).sort()).toEqual([['created', 4500], ['voided', 9000]]);
    expect((await requesterAccept(db, gateway, d.shop.id, { proposalId: first.proposal.id, customerId: vincent })).status).toBe('awaiting_approvals');
  });

  it('a correction that can\'t work leaves the current offer standing', async () => {
    const { d, vincent, ask, first } = await asked();
    const bad = await ask(new Date(at(d, 'Thu', 10).getTime() - 7 * 3600_000)); // 3am
    expect(bad.status).toBe('invalid');
    expect((await load.revision(first.revisions[0]!.id)).status).toBe('offered');
    expect(await cardsOf(d, vincent)).toHaveLength(1);
  });

  it('stops at the revision limit', async () => {
    const { d, ask } = await asked();
    expect((await ask(at(d, 'Thu', 10))).status).toBe('offered');
    expect((await ask(at(d, 'Thu', 11))).status).toBe('offered');
    expect(await ask(at(d, 'Thu', 12))).toEqual({ status: 'revision_limit' });
  });

  it('once they have paid the hold, the terms are fixed', async () => {
    const { d, vincent, proposalId } = await bobAsked();
    const again = await requestChange(db, d.shop.id, { customerId: vincent, request: { kind: 'extend', bookingId: d.bookingOf('Vincent').id, newEndsAt: at(d, 'Thu', 11) } });
    expect(again).toMatchObject({ status: 'refused' });
    expect((await load.proposal(proposalId)).state).toBe('AWAITING_APPROVALS');
  });
});

describe('an affected customer counters', () => {
  it('B1: an impossible time makes no counter, and gets the nearest that works', async () => {
    const { d, bob, proposalId } = await bobAsked();
    const r = await affectedCounter(db, d.shop.id, { proposalId, customerId: bob, newStartsAt: at(d, 'Thu', 12) });
    // Vincent's 10am return plus the 4h turnaround.
    expect(r).toMatchObject({ status: 'infeasible', nearestStart: at(d, 'Thu', 14) });
    expect((await load.proposal(proposalId)).revisionSeq).toBe(1);
    expect((await cardsOf(d, bob)).map((c) => c.role)).toEqual(['affected']);
  });

  it('a time outside shop hours is refused as such', async () => {
    const { d, bob, proposalId } = await bobAsked();
    const r = await affectedCounter(db, d.shop.id, { proposalId, customerId: bob, newStartsAt: new Date(at(d, 'Thu', 9).getTime() + 13 * 3600_000) }); // 10pm
    expect(r.status).toBe('invalid');
  });

  it('B2: 3pm and $25: a draft until Send, then the owner re-approves and it commits', async () => {
    const { gateway, d, vincent, bob, proposalId, optionB } = await bobAsked();
    const r = await affectedCounter(db, d.shop.id, { proposalId, customerId: bob, newStartsAt: at(d, 'Thu', 15), refundCents: 2500 });
    if (r.status !== 'drafted') throw new Error(JSON.stringify(r));
    expect(r.revision).toMatchObject({ status: 'draft', origin: 'counter', createdBy: 'customer', createdByCustomerId: bob, parentRevisionId: optionB.id, needsOwner: true });

    // Nothing is recorded, nothing held, and nobody else can see it; the original offer is still open.
    expect(await load.approvals(r.revision.id)).toEqual([]);
    expect(await load.claims(r.revision.id)).toEqual([]);
    const cards = await cardsOf(d, bob);
    expect(cards.map((c) => c.role).sort()).toEqual(['affected', 'counter']);
    const card = cards.find((c) => c.role === 'counter')!;
    expect(card.options[0]!.lines.join(' ')).toMatch(/Pickup moves from Thu 9:00am to Thu 3:00pm.*\$25\.00 refunded/);
    expect(card.options[0]!.needsShop).toBe(true);
    expect(await cardsOf(d, vincent)).toEqual([]);
    const reviews = () => db.select().from(s.escalations).where(and(eq(s.escalations.proposalId, proposalId), eq(s.escalations.status, 'open')));
    expect(await reviews()).toEqual([]);

    // Send is Bob's approval; Vincent's terms didn't change, so his carries over; the shop is asked.
    expect(await counterSend(db, gateway, d.shop.id, { proposalId, customerId: bob, revisionId: r.revision.id })).toEqual({ status: 'awaiting_approvals', waitingOn: ['owner'] });
    const approvals = await load.approvals(r.revision.id);
    expect(approvals.map((a) => [a.role, a.status, a.source]).sort()).toEqual([
      ['affected', 'approved', 'counter_author'], ['owner', 'pending', null], ['requester', 'approved', 'carried_over'],
    ].sort());
    expect((await load.orders(proposalId)).map((o) => o.status)).toEqual(['authorized']);
    expect((await reviews()).length).toBeGreaterThan(0);

    const before = gateway.calls.length;
    expect((await ownerDecision(db, gateway, d.shop.id, { proposalId, revisionId: r.revision.id, decision: 'approve' })).status).toBe('committed');
    const booking = await load.booking(d.bookingOf('Bob').id);
    expect(booking.startsAt).toEqual(at(d, 'Thu', 15));
    expect((await load.booking(d.bookingOf('Vincent').id)).endsAt).toEqual(at(d, 'Thu', 10));
    const paid = gateway.calls.slice(before);
    expect(paid.map((c) => c.method)).toEqual(['captureAuthorization', 'refundCapture']);
    expect(JSON.stringify(paid[1])).toContain('2500');
  });

  it('within the limits: upgrade plus $5 needs no owner, and Send commits it', async () => {
    const { gateway, d, bob, proposalId, optionA } = await bobAsked();
    const r = await affectedCounter(db, d.shop.id, { proposalId, customerId: bob, baseRevisionId: optionA.id, refundCents: 500 });
    if (r.status !== 'drafted') throw new Error(JSON.stringify(r));
    expect(r.revision.needsOwner).toBe(false);
    expect((await counterSend(db, gateway, d.shop.id, { proposalId, customerId: bob, revisionId: r.revision.id })).status).toBe('committed');
    expect((await load.booking(d.bookingOf('Bob').id)).unitId).toBe(d.unit('A7RV-1').id);
    expect((await load.revision(optionA.id)).status).toBe('superseded');
  });

  it('A3: $100 goes to the owner, and declining it leaves the original offer open', async () => {
    const { gateway, d, bob, proposalId, optionA, optionB } = await bobAsked();
    const r = await affectedCounter(db, d.shop.id, { proposalId, customerId: bob, baseRevisionId: optionB.id, refundCents: 10_000 });
    if (r.status !== 'drafted') throw new Error(JSON.stringify(r));
    expect(r.revision.needsOwner).toBe(true);
    expect(r.revision.ownerTriggers).toContain('over_cap');
    await counterSend(db, gateway, d.shop.id, { proposalId, customerId: bob, revisionId: r.revision.id });
    expect((await load.proposal(proposalId)).state).toBe('AWAITING_APPROVALS');

    expect(await ownerDecision(db, gateway, d.shop.id, { proposalId, revisionId: r.revision.id, decision: 'decline' })).toEqual({ status: 'awaiting_approvals', waitingOn: ['affected'] });
    expect((await load.revision(r.revision.id)).status).toBe('dropped');
    expect((await load.booking(d.bookingOf('Bob').id)).version).toBe(1);
    expect((await cardsOf(d, bob))[0]!.options.map((o) => o.revisionId).sort()).toEqual([optionA.id, optionB.id].sort());
    expect((await affectedAccept(db, gateway, d.shop.id, { proposalId, customerId: bob, revisionId: optionA.id })).status).toBe('committed');
  });

  it('a counter replaces an earlier pick, so the pick can\'t go ahead behind it', async () => {
    const { gateway, d, bob, proposalId, optionB } = await bobAsked();
    await affectedAccept(db, gateway, d.shop.id, { proposalId, customerId: bob, revisionId: optionB.id });
    const r = await affectedCounter(db, d.shop.id, { proposalId, customerId: bob, newStartsAt: at(d, 'Thu', 15) });
    if (r.status !== 'drafted') throw new Error(JSON.stringify(r));
    await counterSend(db, gateway, d.shop.id, { proposalId, customerId: bob, revisionId: r.revision.id });
    expect((await ownerDecision(db, gateway, d.shop.id, { proposalId, revisionId: optionB.id, decision: 'approve' })).status).toBe('awaiting_approvals');
    expect((await load.proposal(proposalId)).state).toBe('AWAITING_APPROVALS');
  });

  it('B4: stops at the revision limit; a newer draft replaces the older; Discard leaves the offer open', async () => {
    const { gateway, d, bob, proposalId } = await bobAsked();
    const counter = (hour: number) => affectedCounter(db, d.shop.id, { proposalId, customerId: bob, newStartsAt: at(d, 'Thu', hour) });
    const first = await counter(15);
    const second = await counter(16);
    if (first.status !== 'drafted' || second.status !== 'drafted') throw new Error('expected drafts');
    expect((await load.revision(first.revision.id)).status).toBe('dropped');
    expect(await counter(17)).toEqual({ status: 'revision_limit' });

    expect(await counterSend(db, gateway, d.shop.id, { proposalId, customerId: bob, revisionId: first.revision.id })).toEqual({ status: 'already_decided' });
    expect(await counterDiscard(db, d.shop.id, { proposalId, customerId: bob, revisionId: second.revision.id })).toEqual({ status: 'discarded' });
    expect((await cardsOf(d, bob)).map((c) => c.role)).toEqual(['affected']);
    expect((await load.proposal(proposalId)).state).toBe('AWAITING_APPROVALS');
  });

  it('only its author can send or discard a counter, and the requester can\'t counter', async () => {
    const { gateway, d, vincent, bob, proposalId } = await bobAsked();
    expect(await affectedCounter(db, d.shop.id, { proposalId, customerId: vincent, refundCents: 100 })).toMatchObject({ status: 'refused' });
    expect(await affectedCounter(db, d.shop.id, { proposalId, customerId: d.customer('Charlie').id, refundCents: 100 })).toMatchObject({ status: 'refused' });
    const r = await affectedCounter(db, d.shop.id, { proposalId, customerId: bob, newStartsAt: at(d, 'Thu', 15) });
    if (r.status !== 'drafted') throw new Error(JSON.stringify(r));
    expect(await counterSend(db, gateway, d.shop.id, { proposalId, customerId: vincent, revisionId: r.revision.id })).toMatchObject({ status: 'refused' });
    expect(await counterDiscard(db, d.shop.id, { proposalId, customerId: vincent, revisionId: r.revision.id })).toMatchObject({ status: 'refused' });
  });

  it('keeping the booking drops an unsent counter', async () => {
    const { gateway, d, bob, proposalId } = await bobAsked();
    const r = await affectedCounter(db, d.shop.id, { proposalId, customerId: bob, newStartsAt: at(d, 'Thu', 15) });
    if (r.status !== 'drafted') throw new Error(JSON.stringify(r));
    await affectedRefuse(db, gateway, d.shop.id, { proposalId, customerId: bob });
    expect((await load.revision(r.revision.id)).status).toBe('dropped');
    expect(await counterSend(db, gateway, d.shop.id, { proposalId, customerId: bob, revisionId: r.revision.id })).toEqual({ status: 'already_decided' });
  });
});

describe('a new booking that can\'t go ahead gets the longest free stretch', () => {
  /** Hank already has the only A7R V from Saturday; Vincent wants it Thursday to next Tuesday. */
  async function vincentWantsTheRV() {
    const base = await shop();
    const { gateway, d, vincent } = base;
    const rv = d.modelsByName.a7rv.id;
    const hank = d.bookingOf('Hank');
    const sat9 = new Date(at(d, 'Fri', 9).getTime() + 24 * 3600_000);
    const sun18 = new Date(at(d, 'Fri', 18).getTime() + 48 * 3600_000);
    await db.insert(s.bookings).values({ ...hank, id: randomUUID(), modelId: rv, unitId: d.unit('A7RV-1').id, startsAt: sat9, endsAt: sun18, bufferEndsAt: new Date(sun18.getTime() + 4 * 3600_000) });
    const tue15 = new Date(at(d, 'Fri', 15).getTime() + 4 * 24 * 3600_000);
    const r = await requestChange(db, d.shop.id, { customerId: vincent, request: { kind: 'new_booking', customerId: vincent, modelId: rv, startsAt: at(d, 'Thu', 9), endsAt: tue15 } });
    if (r.status !== 'offered') throw new Error(JSON.stringify(r));
    expect(r.isAlternative).toBe(false);
    await createRequesterOrder(db, gateway, d.shop.id, { proposalId: r.proposal.id, customerId: vincent });
    expect((await requesterAccept(db, gateway, d.shop.id, { proposalId: r.proposal.id, customerId: vincent })).status).toBe('awaiting_approvals');
    return { ...base, proposalId: r.proposal.id, heldCents: r.chargeCents };
  }
  const offeredIn = async (proposalId: string) =>
    (await db.select().from(s.revisions).where(and(eq(s.revisions.proposalId, proposalId), eq(s.revisions.status, 'offered')))).filter((r) => r.isAlternative);

  it('everyone refuses: until Fri 9pm, covered by the hold, and only that much is captured', async () => {
    const { gateway, d, vincent, proposalId, heldCents } = await vincentWantsTheRV();
    // Refuse until nobody is left to ask.
    for (let i = 0; i < 5 && !(await offeredIn(proposalId)).length; i++) {
      const asked = await db.select().from(s.approvals).where(and(eq(s.approvals.proposalId, proposalId), eq(s.approvals.role, 'affected'), eq(s.approvals.status, 'pending')));
      await affectedRefuse(db, gateway, d.shop.id, { proposalId, customerId: asked[0]!.customerId! });
    }
    const [alternative] = await offeredIn(proposalId);
    expect(alternative!.quote.chargeCents).toBe(13_000); // Thu 9am → Fri 9pm is 2 started days at $65
    expect(alternative!.quote.chargeCents).toBeLessThan(heldCents);
    const [change] = await db.select().from(s.revisionChanges).where(eq(s.revisionChanges.revisionId, alternative!.id));
    expect([change!.newStartsAt, change!.newEndsAt]).toEqual([at(d, 'Thu', 9), at(d, 'Fri', 21)]);
    expect((await cardsOf(d, vincent))[0]).toMatchObject({ role: 'requester', chargeCents: 13_000, heldCents });

    const before = gateway.calls.length;
    expect((await requesterAccept(db, gateway, d.shop.id, { proposalId, customerId: vincent })).status).toBe('committed');
    expect(JSON.stringify(gateway.calls.slice(before))).toContain('13000');
    const mine = await db.select().from(s.bookings).where(and(eq(s.bookings.customerId, vincent), eq(s.bookings.unitId, d.unit('A7RV-1').id)));
    expect(mine.map((b) => b.endsAt)).toEqual([at(d, 'Fri', 21)]);
  });

  it('nobody answers: the same stretch on a new card, which he pays for afresh', async () => {
    const { gateway, d, vincent, proposalId } = await vincentWantsTheRV();
    await db.update(s.shops).set({ clockOffsetMs: d.shop.clockOffsetMs + 31 * 60_000 }).where(eq(s.shops.id, d.shop.id));
    expect(await expireDue(db, gateway, d.shop.id)).toEqual([proposalId]);
    expect((await load.orders(proposalId)).map((o) => o.status)).toEqual(['voided']);

    const [card] = await cardsOf(d, vincent);
    expect(card).toMatchObject({ role: 'requester', chargeCents: 13_000, heldCents: 0 });
    expect(card!.proposalId).not.toBe(proposalId);
    expect(card!.options[0]!.isAlternative).toBe(true);
    await createRequesterOrder(db, gateway, d.shop.id, { proposalId: card!.proposalId, customerId: vincent });
    expect((await requesterAccept(db, gateway, d.shop.id, { proposalId: card!.proposalId, customerId: vincent })).status).toBe('committed');
  });
});

describe('a customer who answers before the agent has finished writing to them', () => {
  it("doesn't re-offer the options: the agent is told their choice is already recorded", async () => {
    const { d, gateway, bob, proposalId, optionA, optionB } = await bobAsked();
    // The card is on screen while the agent's turn runs, so Bob can pick before it reaches present_offer.
    await affectedAccept(db, gateway, d.shop.id, { proposalId, customerId: bob, revisionId: optionB.id });

    const conversation = await conversationOf(db, d.shop.id, bob, d.now);
    const turn = new TurnState();
    const tools = makeTools({ db, shopId: d.shop.id, customerId: bob, conversationId: conversation.id, turn, now: () => d.now, onStep: () => {} });
    const present = tools.find((t) => t.name === 'present_offer')!.run as (i: unknown) => Promise<string>;
    const result = JSON.parse(await present({ revision_ids: [turn.ids.of('rv', optionA.id), turn.ids.of('rv', optionB.id)] }));

    expect(result).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(result.hint).toContain('already');
    expect(turn.cardsPosted).toBe(0);
  });

  it('an offer turn that loses the race ends silently, so it can\'t tell them the request expired', async () => {
    const { d, gateway, bob, proposalId, optionA, optionB } = await bobAsked();
    const conversation = await conversationOf(db, d.shop.id, bob, d.now);
    const turn = new TurnState();
    turn.offerEvent = true;
    const tools = makeTools({ db, shopId: d.shop.id, customerId: bob, conversationId: conversation.id, turn, now: () => d.now, onStep: () => {} });
    const call = async (name: string, input: unknown) => JSON.parse(await (tools.find((t) => t.name === name)!.run as (i: unknown) => Promise<string>)(input));
    await affectedAccept(db, gateway, d.shop.id, { proposalId, customerId: bob, revisionId: optionB.id });

    expect(await call('present_offer', { revision_ids: [turn.ids.of('rv', optionA.id)] })).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(turn.offerClosed).toBe(true);
    expect(await call('send_message', { text: 'That request has expired.' })).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(turn.messagesSent).toBe(0);
  });

  it('skips the offer turn when they answered before it started', async () => {
    const { d, gateway, bob, proposalId, optionA, optionB } = await bobAsked();
    await affectedAccept(db, gateway, d.shop.id, { proposalId, customerId: bob, revisionId: optionB.id });
    const templates: AgentConfig = { client: null, model: 'none', turnCap: 60 } as unknown as AgentConfig;
    const report = await runTurn(db, templates, { shopId: d.shop.id, customerId: bob, event: { kind: 'offer_ready', proposalId, revisionIds: [optionA.id, optionB.id], role: 'affected' } });
    expect(report.fallback).toBe('skipped: offer no longer open');
    const conversation = await conversationOf(db, d.shop.id, bob, d.now);
    expect(await db.select().from(s.messages).where(eq(s.messages.conversationId, conversation.id))).toEqual([]);
  });

  it("the scripted reply doesn't override a choice the customer already made", async () => {
    const { d, gateway, bob, proposalId, optionA, optionB } = await bobAsked();
    await db.update(s.shops).set({ autoReplyCustomers: true }).where(eq(s.shops.id, d.shop.id));
    await affectedAccept(db, gateway, d.shop.id, { proposalId, customerId: bob, revisionId: optionB.id });
    const reply = await createAutoReply(db, gateway, { delayMs: 0 })({ shopId: d.shop.id, customerId: bob, proposalId, revisionIds: [optionA.id, optionB.id] });
    expect(reply).toBeNull();
    expect((await load.approvals(optionA.id)).find((a) => a.customerId === bob)?.status).toBe('pending');
  });
});

describe('a customer who answers after the card is posted but before the agent has explained it', () => {
  async function toolsOf(d: Seeded, customerId: string) {
    const conversation = await conversationOf(db, d.shop.id, customerId, d.now);
    const turn = new TurnState();
    const tools = makeTools({ db, shopId: d.shop.id, customerId, conversationId: conversation.id, turn, now: () => d.now, onStep: () => {} });
    const call = async (name: string, input: unknown) => JSON.parse(await (tools.find((t) => t.name === name)!.run as (i: unknown) => Promise<string>)(input));
    return { turn, call, conversation };
  }

  it('drops the stale explanation for an affected customer', async () => {
    const { d, gateway, bob, proposalId, optionA, optionB } = await bobAsked();
    const { turn, call, conversation } = await toolsOf(d, bob);
    expect((await call('present_offer', { revision_ids: [turn.ids.of('rv', optionA.id), turn.ids.of('rv', optionB.id)] })).ok).toBe(true);

    await affectedAccept(db, gateway, d.shop.id, { proposalId, customerId: bob, revisionId: optionB.id });

    expect(await call('send_message', { text: 'Please choose on the card.' })).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(turn.offerClosed).toBe(true);
    const said = await db.select().from(s.messages).where(eq(s.messages.conversationId, conversation.id));
    expect(said.map((m) => m.body)).not.toContain('Please choose on the card.');
  });

  it('drops the stale explanation for a requester who has already paid', async () => {
    const { gateway, d, vincent } = await shop();
    const offered = await requestChange(db, d.shop.id, { customerId: vincent, request: { kind: 'extend', bookingId: d.bookingOf('Vincent').id, newEndsAt: at(d, 'Thu', 10) } });
    if (offered.status !== 'offered') throw new Error(offered.status);
    const { turn, call } = await toolsOf(d, vincent);
    expect((await call('present_offer', { revision_ids: [turn.ids.of('rv', offered.revisions[0]!.id)] })).ok).toBe(true);

    await createRequesterOrder(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: vincent });
    await requesterAccept(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: vincent });

    expect(await call('send_message', { text: 'Please use the card.' })).toMatchObject({ ok: false, code: 'INVALID_STATE' });
  });

  it('still delivers the explanation while the offer is open', async () => {
    const { d, bob, optionA, optionB } = await bobAsked();
    const { turn, call } = await toolsOf(d, bob);
    await call('present_offer', { revision_ids: [turn.ids.of('rv', optionA.id), turn.ids.of('rv', optionB.id)] });
    expect((await call('send_message', { text: 'Please choose on the card.' })).ok).toBe(true);
  });
});

describe('a new shop', () => {
  it('leaves other customers to wait: a person, or the scripted answer button, decides for them', async () => {
    const d = await seedShop(db, { sessionKey: randomUUID() });
    expect(d.shop.autoReplyCustomers).toBe(false);
  });
});

describe('after an affected customer picks an option that needs the shop', () => {
  const statusOf = async (d: Seeded, customerId: string) => db.transaction(async (tx) => (await customerView(tx, d.shop.id, customerId))!.requests[0]!);

  it('no longer shows the other option as a choice, and lets them withdraw', async () => {
    const { d, gateway, bob, proposalId, optionB } = await bobAsked();
    await affectedAccept(db, gateway, d.shop.id, { proposalId, customerId: bob, revisionId: optionB.id });
    expect(await cardsOf(d, bob)).toEqual([]);
    expect(await statusOf(d, bob)).toMatchObject({ headline: 'You chose option B: waiting on the shop', canWithdraw: true });
  });

  it('tells the requester only the shop is left', async () => {
    const { d, gateway, vincent, bob, proposalId, optionB } = await bobAsked();
    await affectedAccept(db, gateway, d.shop.id, { proposalId, customerId: bob, revisionId: optionB.id });
    expect((await statusOf(d, vincent)).headline).toBe('Accepted: waiting on the shop');
  });

  it('offers the other option again if the owner declines the pick (judge B8)', async () => {
    const { d, gateway, bob, proposalId, optionA, optionB } = await bobAsked();
    await affectedAccept(db, gateway, d.shop.id, { proposalId, customerId: bob, revisionId: optionB.id });
    await ownerDecision(db, gateway, d.shop.id, { proposalId, revisionId: optionB.id, decision: 'decline' });
    expect((await cardsOf(d, bob))[0]!.options.map((o) => o.revisionId)).toEqual([optionA.id]);
  });
});

describe('the scripted answer button', () => {
  it('has the customer say which option they take, then take it', async () => {
    const { d, gateway, bob, proposalId, optionB } = await bobAsked();
    const result = await scriptedAnswer(db, gateway, { shopId: d.shop.id, customerId: bob, proposalId });
    expect(result?.status).toBe('awaiting_approvals');
    expect((await load.approvals(optionB.id)).find((a) => a.customerId === bob)?.status).toBe('approved');
    const conversation = await conversationOf(db, d.shop.id, bob, d.now);
    const said = await db.select().from(s.messages).where(eq(s.messages.conversationId, conversation.id));
    expect(said.map((m) => m.body)).toContain('Option B works for me, thanks.');
  });

  it('does nothing when they have no decision to make', async () => {
    const { d, gateway, vincent, bob, proposalId, optionB } = await bobAsked();
    expect(await scriptedAnswer(db, gateway, { shopId: d.shop.id, customerId: vincent, proposalId })).toBeNull();
    await affectedAccept(db, gateway, d.shop.id, { proposalId, customerId: bob, revisionId: optionB.id });
    expect(await scriptedAnswer(db, gateway, { shopId: d.shop.id, customerId: bob, proposalId })).toBeNull();
  });
});
