// Demo Scenario 3: the customer says no. Bob keeps his booking as is; the backend falls back to the next plan
// (Charlie upgrades so Bob can swap units, notice only); Charlie says no too; Alice gets the closest alternative,
// at no extra charge, with her hold released. Plus withdrawal (judge B5), the requester cancelling, and expiry.

import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.ts';
import * as s from '../src/db/schema.ts';
import { seedShop } from '../src/db/seed.ts';
import { seedPrepayments } from '../src/payments/prepay.ts';
import {
  affectedAccept,
  affectedRefuse,
  createRequesterOrder,
  expireDue,
  requestChange,
  requesterAccept,
  requesterCancel,
} from '../src/proposals/flow.ts';
import { fakeGateway } from './fake-gateway.ts';

const { db, pool } = createDb();
afterAll(() => pool.end());

type Seeded = Awaited<ReturnType<typeof seedShop>>;

function at(d: Seeded, day: 'Wed' | 'Thu' | 'Fri', hour: number) {
  const days = { Wed: 2, Thu: 3, Fri: 4 }[day];
  return DateTime.fromJSDate(d.now, { zone: d.shop.timezone }).startOf('week').plus({ days }).set({ hour }).toJSDate();
}

async function setup() {
  const gateway = fakeGateway();
  const d = await seedShop(db, { sessionKey: randomUUID() });
  await seedPrepayments(db, gateway, d.shop.id);
  const alice = d.customer('Alice').id;
  const offered = await requestChange(db, d.shop.id, { customerId: alice, request: { kind: 'extend', bookingId: d.bookingOf('Alice').id, newEndsAt: at(d, 'Thu', 10) } });
  if (offered.status !== 'offered') throw new Error(JSON.stringify(offered));
  await createRequesterOrder(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: alice });
  expect((await requesterAccept(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: alice })).status).toBe('awaiting_approvals');
  const [optionA, optionB] = offered.revisions;
  return { gateway, d, proposalId: offered.proposal.id, optionA: optionA!, optionB: optionB! };
}

const load = {
  booking: async (id: string) => (await db.select().from(s.bookings).where(eq(s.bookings.id, id)))[0]!,
  proposal: async (id: string) => (await db.select().from(s.proposals).where(eq(s.proposals.id, id)))[0]!,
  revisions: async (proposalId: string) => db.select().from(s.revisions).where(eq(s.revisions.proposalId, proposalId)).orderBy(s.revisions.seq, s.revisions.optionLabel),
  changes: async (revisionId: string) => db.select().from(s.revisionChanges).where(eq(s.revisionChanges.revisionId, revisionId)),
  approvals: async (revisionId: string) => db.select().from(s.approvals).where(eq(s.approvals.revisionId, revisionId)),
  activeClaims: async (proposalId: string) => db.select().from(s.claims).where(and(eq(s.claims.proposalId, proposalId), isNull(s.claims.releasedAt))),
  order: async (proposalId: string) => (await db.select().from(s.paypalOrders).where(eq(s.paypalOrders.proposalId, proposalId)))[0]!,
  events: async (proposalId: string, kind: string) => db.select().from(s.activityLog).where(and(eq(s.activityLog.proposalId, proposalId), eq(s.activityLog.kind, kind))).orderBy(s.activityLog.seq),
};

describe('Scenario 3: the customer says no', () => {
  it('Bob keeps his booking → fallback to Charlie → Charlie says no → Alice gets 9pm tonight at no extra charge', async () => {
    const { gateway, d, proposalId, optionA, optionB } = await setup();
    const [alice, bob, charlie] = [d.bookingOf('Alice'), d.bookingOf('Bob'), d.bookingOf('Charlie')];

    // Step 1–2: Bob taps "Keep my booking as is". His booking is untouched; both options go, with their claims.
    expect(await affectedRefuse(db, gateway, d.shop.id, { proposalId, customerId: bob.customerId })).toEqual({ status: 'kept', next: 'fallback' });
    expect((await load.booking(bob.id)).version).toBe(1);
    const bobApprovals = [...(await load.approvals(optionA.id)), ...(await load.approvals(optionB.id))].filter((a) => a.customerId === bob.customerId);
    expect(bobApprovals.map((a) => [a.status, a.refusal])).toEqual([['rejected', true], ['rejected', true]]);
    expect(await db.select().from(s.proposalExclusions).where(eq(s.proposalExclusions.proposalId, proposalId))).toHaveLength(1);

    // Step 3: revision 2 — Charlie upgrades to the A7R V so Bob can swap to A7IV-2 (same model: notice only).
    const revs = await load.revisions(proposalId);
    expect(revs.map((r) => [r.seq, r.optionLabel, r.status, r.origin])).toEqual([
      [1, 'A', 'dropped', 'optimizer'], [1, 'B', 'dropped', 'optimizer'], [2, null, 'offered', 'fallback'],
    ]);
    const rev2 = revs[2]!;
    const byParty = Object.fromEntries((await load.changes(rev2.id)).map((c) => [c.partyCustomerId, [c.kind, c.requiresApproval]]));
    expect(byParty).toEqual({
      [alice.customerId]: ['extension', false],
      [bob.customerId]: ['same_model_swap', false],
      [charlie.customerId]: ['model_change', true],
    });
    expect(rev2.quote.chargeCents).toBe(4500); // Alice's terms are unchanged…
    const rev2Approvals = await load.approvals(rev2.id);
    expect(rev2Approvals.map((a) => [a.role, a.customerId, a.status, a.source]).sort()).toEqual([
      ['affected', charlie.customerId, 'pending', null],
      ['requester', alice.customerId, 'approved', 'carried_over'], // …so her approval and hold carry over
    ].sort());
    const p2 = await load.proposal(proposalId);
    expect([p2.state, p2.revisionSeq, p2.fallbackPlansUsed]).toEqual(['AWAITING_APPROVALS', 2, 1]);
    expect((await load.activeClaims(proposalId)).every((c) => c.revisionId === rev2.id)).toBe(true);
    expect((await load.events(proposalId, 'offer_ready')).at(-1)!.payload).toEqual({ customerId: charlie.customerId, revisionIds: [rev2.id], role: 'affected' });
    expect((await load.order(proposalId)).status).toBe('authorized');

    // Bob can't change his mind into the new plan: he isn't asked about it, and refusing twice is a no-op.
    expect(await affectedRefuse(db, gateway, d.shop.id, { proposalId, customerId: bob.customerId })).toEqual({ status: 'already_decided' });

    // Step 3–4: Charlie declines too. No plans left → the closest alternative to Alice: until 9pm tonight, $0.
    expect(await affectedRefuse(db, gateway, d.shop.id, { proposalId, customerId: charlie.customerId })).toEqual({ status: 'kept', next: 'alternative' });
    expect((await load.booking(charlie.id)).version).toBe(1);
    const rev3 = (await load.revisions(proposalId)).at(-1)!;
    expect([rev3.seq, rev3.origin, rev3.isAlternative, rev3.quote.chargeCents]).toEqual([3, 'alternative', true, 0]);
    const [aliceChange] = await load.changes(rev3.id);
    expect(aliceChange!.newEndsAt).toEqual(at(d, 'Wed', 21));
    expect((await load.proposal(proposalId)).state).toBe('DRAFT');
    // Nothing to pay any more, so her $45 hold is released right away.
    expect((await load.order(proposalId)).status).toBe('voided');
    expect((await load.events(proposalId, 'offer_ready')).at(-1)!.payload).toEqual({
      customerId: alice.customerId, revisionIds: [rev3.id], role: 'requester', fallback: true, holdReleased: true,
    });

    // Alice accepts the alternative: commits with no charge.
    expect((await requesterAccept(db, gateway, d.shop.id, { proposalId, customerId: alice.customerId })).status).toBe('committed');
    const aliceAfter = await load.booking(alice.id);
    expect([aliceAfter.endsAt, aliceAfter.priceCents, aliceAfter.version]).toEqual([at(d, 'Wed', 21), alice.priceCents, 2]);
    expect([(await load.booking(bob.id)).version, (await load.booking(charlie.id)).version]).toEqual([1, 1]);
    expect(gateway.calls.filter((c) => c.method !== 'createOrder').map((c) => c.method)).toEqual(['authorizeOrder', 'voidAuthorization']);
  });

  it('step 5: Alice ignores the alternative; it expires and her original booking stands', async () => {
    const { gateway, d, proposalId } = await setup();
    await affectedRefuse(db, gateway, d.shop.id, { proposalId, customerId: d.customer('Bob').id });
    await affectedRefuse(db, gateway, d.shop.id, { proposalId, customerId: d.customer('Charlie').id });
    await db.update(s.shops).set({ clockOffsetMs: d.shop.clockOffsetMs + 31 * 60_000 }).where(eq(s.shops.id, d.shop.id));
    expect(await expireDue(db, gateway, d.shop.id)).toEqual([proposalId]);
    expect((await load.proposal(proposalId)).state).toBe('EXPIRED');
    expect(await load.activeClaims(proposalId)).toEqual([]);
    expect((await load.booking(d.bookingOf('Alice').id)).version).toBe(1);
  });

  it('Charlie accepts the fallback: Bob swaps units (notice only), Charlie upgrades, Alice pays $45', async () => {
    const { gateway, d, proposalId } = await setup();
    const [bob, charlie] = [d.bookingOf('Bob'), d.bookingOf('Charlie')];
    await affectedRefuse(db, gateway, d.shop.id, { proposalId, customerId: bob.customerId });
    const rev2 = (await load.revisions(proposalId)).at(-1)!;
    expect((await affectedAccept(db, gateway, d.shop.id, { proposalId, customerId: charlie.customerId, revisionId: rev2.id })).status).toBe('committed');
    const [bobAfter, charlieAfter] = [await load.booking(bob.id), await load.booking(charlie.id)];
    expect([bobAfter.unitId, bobAfter.startsAt, bobAfter.endsAt]).toEqual([d.unit('A7IV-2').id, bob.startsAt, bob.endsAt]);
    expect([charlieAfter.unitId, charlieAfter.modelId]).toEqual([d.unit('A7RV-1').id, d.modelsByName.a7rv.id]);
    expect([(await load.order(proposalId)).status, (await load.order(proposalId)).capturedCents]).toEqual(['captured', 4500]);
  });
});

describe('withdrawing and cancelling', () => {
  it('B5: Bob picks Plan B, then keeps his booking before the owner approves: counted as a refusal', async () => {
    const { gateway, d, proposalId, optionB } = await setup();
    const bob = d.customer('Bob').id;
    await affectedAccept(db, gateway, d.shop.id, { proposalId, customerId: bob, revisionId: optionB.id });
    const result = await affectedRefuse(db, gateway, d.shop.id, { proposalId, customerId: bob });
    expect(result).toEqual({ status: 'kept', next: 'fallback' });
    const [refused] = await load.events(proposalId, 'affected_refused');
    expect(refused!.payload).toMatchObject({ customerId: bob, withdrew: true });
    // The owner's card for Plan B is gone with it.
    const open = await db.select().from(s.escalations).where(and(eq(s.escalations.revisionId, optionB.id), eq(s.escalations.status, 'open')));
    expect(open).toEqual([]);
  });

  it('only a party who was asked can refuse', async () => {
    const { gateway, d, proposalId } = await setup();
    expect((await affectedRefuse(db, gateway, d.shop.id, { proposalId, customerId: d.customer('Dana').id })).status).toBe('refused');
    expect((await affectedRefuse(db, gateway, d.shop.id, { proposalId, customerId: d.customer('Alice').id })).status).toBe('refused');
  });

  it('the requester cancels while Bob is deciding: REJECTED, hold voided, claims released', async () => {
    const { gateway, d, proposalId } = await setup();
    expect(await requesterCancel(db, gateway, d.shop.id, { proposalId, customerId: d.customer('Alice').id })).toEqual({ status: 'rejected' });
    expect((await load.proposal(proposalId)).state).toBe('REJECTED');
    expect((await load.order(proposalId)).status).toBe('voided');
    expect(await load.activeClaims(proposalId)).toEqual([]);
    expect((await requesterCancel(db, gateway, d.shop.id, { proposalId, customerId: d.customer('Bob').id })).status).toBe('refused');
  });
});
