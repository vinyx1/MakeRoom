// Overdue returns (docs/conflict-model.md §8; judge D10): Alice hasn't brought A7IV-1 back by Wed 6pm. The owner
// marks it overdue with when she now expects to return it, and the next renter (Bob) is re-planned around it, with
// nobody paying: the owner reviews every plan first. If nobody agrees, the owner is alerted. Marking it returned
// ends anything planned around it.

import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.ts';
import * as s from '../src/db/schema.ts';
import { seedShop } from '../src/db/seed.ts';
import { seedPrepayments } from '../src/payments/prepay.ts';
import { affectedAccept, affectedRefuse, markOverdue, markReturned, ownerDecision } from '../src/proposals/flow.ts';
import { customerView } from '../src/server/views.ts';
import { fakeGateway } from './fake-gateway.ts';

const { db, pool } = createDb();
afterAll(() => pool.end());

type Seeded = Awaited<ReturnType<typeof seedShop>>;

function at(d: Seeded, day: 'Wed' | 'Thu', hour: number) {
  return DateTime.fromJSDate(d.now, { zone: d.shop.timezone }).startOf('week').plus({ days: day === 'Wed' ? 2 : 3 }).set({ hour }).toJSDate();
}

async function shop() {
  const gateway = fakeGateway();
  const d = await seedShop(db, { sessionKey: randomUUID() });
  await seedPrepayments(db, gateway, d.shop.id);
  await advance(d, -4); // Seeding sets Wed 6pm, the moment Alice is due; these tests start before that, at 2pm.
  return { d, gateway };
}

/** The demo clock: these tests start it at Wed 2pm (see `shop`). */
const advance = (d: Seeded, hours: number) =>
  db.update(s.shops).set({ clockOffsetMs: sql`${s.shops.clockOffsetMs} + ${hours * 3600_000}` }).where(eq(s.shops.id, d.shop.id));

const load = {
  booking: async (id: string) => (await db.select().from(s.bookings).where(eq(s.bookings.id, id)))[0]!,
  proposal: async (id: string) => (await db.select().from(s.proposals).where(eq(s.proposals.id, id)))[0]!,
  escalations: async (d: Seeded, kind: string) =>
    db.select().from(s.escalations).where(and(eq(s.escalations.shopId, d.shop.id), eq(s.escalations.kind, kind as 'overdue'), eq(s.escalations.status, 'open'))),
};

/** Wed 7pm, an hour after Alice was due: she now says Thu 10am, which runs into Bob's Thu 9am pickup. */
async function aliceOverdue(d: Seeded, gateway: ReturnType<typeof fakeGateway>) {
  await advance(d, 5);
  const r = await markOverdue(db, gateway, d.shop.id, { bookingId: d.bookingOf('Alice').id, expectedReturnAt: at(d, 'Thu', 10) });
  if (r.status !== 'planned') throw new Error(JSON.stringify(r));
  return r;
}

describe('overdue returns', () => {
  it("can't be marked before the rental is due back", async () => {
    const { d, gateway } = await shop();
    const r = await markOverdue(db, gateway, d.shop.id, { bookingId: d.bookingOf('Alice').id, expectedReturnAt: at(d, 'Thu', 10) });
    expect(r).toMatchObject({ status: 'refused', reason: expect.stringContaining("isn't due back until") });
  });

  it('re-plans Bob around the late return, with no charge to Alice: owner reviews, Bob accepts, it commits', async () => {
    const { d, gateway } = await shop();
    const [alice, bob] = [d.bookingOf('Alice'), d.bookingOf('Bob')];
    const r = await aliceOverdue(d, gateway);

    // The same two plans as Scenario 1, but nobody pays for them, so both run at a loss and go to the owner first.
    expect(r.proposal).toMatchObject({ source: 'overdue', requesterCustomerId: null, state: 'AWAITING_APPROVALS' });
    expect(r.revisions.map((x) => [x.optionLabel, x.quote.chargeCents, x.needsOwner])).toEqual([['A', 0, true], ['B', 0, true]]);
    expect((await load.booking(alice.id)).overdueMarkedAt).not.toBeNull();
    const reviews = await load.escalations(d, 'plan_review');
    expect(reviews).toHaveLength(2);
    expect(reviews[0]!.summary).toMatch(/^Alice is overdue, expected back Thu 10:00am \(no charge to them\)/);
    // Nothing reaches Bob until the owner approves a plan.
    expect((await db.transaction((tx) => customerView(tx, d.shop.id, bob.customerId)))!.cards).toEqual([]);

    // Both plans need the owner, so they're in rank order: A moves Bob to 2pm, B upgrades him. Take the upgrade.
    const upgrades = await db.select().from(s.revisionChanges).where(and(eq(s.revisionChanges.partyCustomerId, bob.customerId), eq(s.revisionChanges.kind, 'model_change')));
    const planA = r.revisions.find((x) => upgrades.some((c) => c.revisionId === x.id))!;
    await ownerDecision(db, gateway, d.shop.id, { proposalId: r.proposal.id, revisionId: planA.id, decision: 'approve' });
    expect((await db.transaction((tx) => customerView(tx, d.shop.id, bob.customerId)))!.cards.map((c) => c.options.map((o) => o.revisionId))).toEqual([[planA.id]]);

    const before = gateway.calls.length;
    expect((await affectedAccept(db, gateway, d.shop.id, { proposalId: r.proposal.id, customerId: bob.customerId, revisionId: planA.id })).status).toBe('committed');
    const [aliceAfter, bobAfter] = [await load.booking(alice.id), await load.booking(bob.id)];
    expect([aliceAfter.endsAt, aliceAfter.priceCents, aliceAfter.status]).toEqual([at(d, 'Thu', 10), alice.priceCents, 'picked_up']);
    expect(bobAfter.unitId).toBe(d.unit('A7RV-1').id);
    expect(gateway.calls.slice(before)).toEqual([]); // no one charged, and an upgrade refunds nothing
  });

  it('when Bob and then Charlie keep their bookings, the request ends and the owner is alerted', async () => {
    const { d, gateway } = await shop();
    const r = await aliceOverdue(d, gateway);
    expect(await affectedRefuse(db, gateway, d.shop.id, { proposalId: r.proposal.id, customerId: d.customer('Bob').id })).toEqual({ status: 'kept', next: 'fallback' });
    // The fallback (Charlie upgrades so Bob can swap units) runs at a loss too; Charlie can still decline it.
    expect(await affectedRefuse(db, gateway, d.shop.id, { proposalId: r.proposal.id, customerId: d.customer('Charlie').id })).toEqual({ status: 'kept', next: 'ended' });
    expect((await load.proposal(r.proposal.id)).state).toBe('REJECTED');

    // There is no "closest alternative" for a late return: the owner has to step in.
    const [alert] = await load.escalations(d, 'overdue');
    expect(alert!.summary).toBe(
      "Alice is still out with A7IV-1, and no rearrangement was agreed (asked: Bob, then Charlie). Bob's booking may not have equipment: contact them to cancel with a full refund, or find other gear.",
    );
    expect((await load.booking(d.bookingOf('Bob').id)).version).toBe(1);
  });

  it('a late return that collides with no one just runs later', async () => {
    const { d, gateway } = await shop();
    const dana = d.bookingOf('Dana');
    // Thu 9:30am, half an hour after Dana was due. Thu 10am + 4h turnaround ends exactly at Eve's 2pm pickup.
    await advance(d, 19.5);
    expect(await markOverdue(db, gateway, d.shop.id, { bookingId: dana.id, expectedReturnAt: at(d, 'Thu', 10) })).toEqual({ status: 'extended' });
    const after = await load.booking(dana.id);
    expect([after.endsAt, after.priceCents]).toEqual([at(d, 'Thu', 10), dana.priceCents]);
  });

  it('a new expected time replaces the earlier plan', async () => {
    const { d, gateway } = await shop();
    const r = await aliceOverdue(d, gateway);
    // She's coming back tonight after all: 8pm + 4h is clear of Bob's Thu 9am pickup.
    expect(await markOverdue(db, gateway, d.shop.id, { bookingId: d.bookingOf('Alice').id, expectedReturnAt: at(d, 'Wed', 20) })).toEqual({ status: 'extended' });
    expect((await load.proposal(r.proposal.id)).state).toBe('CANCELLED');
    expect(await db.select().from(s.claims).where(and(eq(s.claims.proposalId, r.proposal.id), isNull(s.claims.releasedAt)))).toEqual([]);
  });

  it('marking it returned ends the plan around it, and the unit is free', async () => {
    const { d, gateway } = await shop();
    const r = await aliceOverdue(d, gateway);
    expect(await markReturned(db, gateway, d.shop.id, { bookingId: d.bookingOf('Alice').id })).toEqual({ status: 'returned', ended: 1 });
    expect((await load.proposal(r.proposal.id)).state).toBe('CANCELLED');
    expect((await load.booking(d.bookingOf('Alice').id)).status).toBe('returned');
    expect(await load.escalations(d, 'plan_review')).toEqual([]);
    expect((await load.booking(d.bookingOf('Bob').id)).version).toBe(1);
  });
});
