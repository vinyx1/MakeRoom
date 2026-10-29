// Demo Scenario 6, "The race": while Alice's proposal waits on Bob, the owner edits Bob's booking by hand.
// Also judge scenarios D1–D5. Alice's pending proposal is built directly (the proposal flow comes later),
// exactly as the data model's Scenario 1 walkthrough leaves it after her authorization.

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.ts';
import * as s from '../src/db/schema.ts';
import { seedShop } from '../src/db/seed.ts';
import { ownerEditBooking } from '../src/owner/edit-booking.ts';
import type { GatewayResult } from '../src/payments/gateway.ts';
import { createPayPalClient, payPalGateway } from '../src/payments/paypal.ts';
import { storeRequest } from '../src/proposals/request.ts';
import { fakeGateway } from './fake-gateway.ts';

const { db, pool } = createDb();
afterAll(() => pool.end());

type Seeded = Awaited<ReturnType<typeof seedShop>>;
const H = 3600_000;
const plus = (d: Date, hours: number) => new Date(d.getTime() + hours * H);

function at(d: Seeded, day: 'Wed' | 'Thu' | 'Fri', hour: number) {
  const days = { Wed: 2, Thu: 3, Fri: 4 }[day];
  return DateTime.fromJSDate(d.now, { zone: d.shop.timezone }).startOf('week').plus({ days }).set({ hour }).toJSDate();
}

/** Scenario 1 up to step 5: Alice authorized $45, claims held, both options offered to Bob. */
async function alicePending(state: 'AWAITING_APPROVALS' | 'CAPTURING' = 'AWAITING_APPROVALS') {
  const d = await seedShop(db, { sessionKey: randomUUID() });
  const shopId = d.shop.id;
  const alice = d.bookingOf('Alice'), bob = d.bookingOf('Bob');
  const thu10 = at(d, 'Thu', 10);

  const [proposal] = await db
    .insert(s.proposals)
    .values({
      shopId, source: 'customer_request', requesterCustomerId: alice.customerId, subjectBookingId: alice.id,
      request: storeRequest({ kind: 'extend', bookingId: alice.id, newEndsAt: thu10 }), state, revisionSeq: 1,
      expiresAt: plus(d.now, 0.5), createdAt: d.now,
    })
    .returning();
  const revision = (optionLabel: 'A' | 'B') => ({
    shopId, proposalId: proposal!.id, seq: 1, optionLabel, status: 'offered' as const, origin: 'optimizer' as const, createdBy: 'agent' as const,
    quote: { lines: [], discountCents: 0, chargeCents: 0, compensation: [], netRevenueCents: 4500 }, netRevenueCents: 4500, createdAt: d.now,
  });
  const [revA, revB] = await db.insert(s.revisions).values([revision('A'), { ...revision('B'), ownerTriggers: ['booking_shortened'], needsOwner: true }]).returning();

  await db.insert(s.claims).values([
    ...[revA!, revB!].flatMap((r) => [
      { shopId, proposalId: proposal!.id, revisionId: r.id, bookingId: alice.id },
      { shopId, proposalId: proposal!.id, revisionId: r.id, bookingId: bob.id },
      { shopId, proposalId: proposal!.id, revisionId: r.id, unitId: d.unit('A7IV-1').id, period: { start: alice.bufferEndsAt, end: at(d, 'Thu', 14) } },
    ]),
    { shopId, proposalId: proposal!.id, revisionId: revA!.id, unitId: d.unit('A7RV-1').id, period: { start: bob.startsAt, end: bob.bufferEndsAt } },
  ]);

  const [order] = await db
    .insert(s.paypalOrders)
    .values({
      shopId, proposalId: proposal!.id, revisionId: revA!.id, customerId: alice.customerId,
      paypalOrderId: `TEST-${randomUUID()}`, intent: 'AUTHORIZE', amountCents: 4500,
      authorizationId: `AUTH-${randomUUID()}`, status: 'authorized',
    })
    .returning();

  /** The owner drags Bob's pickup to Thu 2pm, keeping his return. */
  const dragBob = (extra: Partial<Parameters<typeof ownerEditBooking>[3]> = {}) => ({
    bookingId: bob.id, unitId: bob.unitId!, startsAt: at(d, 'Thu', 14), endsAt: bob.endsAt, basedOnVersion: bob.version,
    attestedCustomerIds: [bob.customerId], ...extra,
  });
  return { d, shopId, alice, bob, proposal: proposal!, order: order!, dragBob };
}

const reload = {
  booking: async (id: string) => (await db.select().from(s.bookings).where(eq(s.bookings.id, id)))[0]!,
  proposal: async (id: string) => (await db.select().from(s.proposals).where(eq(s.proposals.id, id)))[0]!,
  order: async (id: string) => (await db.select().from(s.paypalOrders).where(eq(s.paypalOrders.id, id)))[0]!,
  activeClaims: async (proposalId: string) =>
    (await db.select().from(s.claims).where(eq(s.claims.proposalId, proposalId))).filter((c) => !c.releasedAt),
};

describe('Scenario 6: the owner drags Bob while Alice waits', () => {
  it('step 2: warns that Bob is part of Alice’s pending request, and changes nothing', async () => {
    const { shopId, bob, proposal, dragBob } = await alicePending();
    const gateway = fakeGateway();
    const result = await ownerEditBooking(db, gateway, shopId, dragBob());

    expect(result).toEqual({
      status: 'claimed',
      proposals: [{ id: proposal.id, state: 'AWAITING_APPROVALS', requesterCustomerId: proposal.requesterCustomerId, requesterName: 'Alice' }],
    });
    expect((await reload.booking(bob.id)).version).toBe(bob.version);
    expect((await reload.proposal(proposal.id)).state).toBe('AWAITING_APPROVALS');
    expect(gateway.calls).toEqual([]);
  });

  it('step 3: overriding cancels the proposal, voids the authorization, applies the edit and re-plans Alice', async () => {
    const { d, shopId, bob, proposal, order, dragBob } = await alicePending();
    const gateway = fakeGateway();
    const result = await ownerEditBooking(db, gateway, shopId, dragBob({ override: true }));
    if (result.status !== 'applied') throw new Error(JSON.stringify(result));

    // Bob's booking moved, version bumped.
    expect(result.booking.startsAt).toEqual(at(d, 'Thu', 14));
    expect(result.booking.version).toBe(bob.version + 1);

    // Alice's proposal is cancelled and holds nothing.
    const p = await reload.proposal(proposal.id);
    expect(p.state).toBe('CANCELLED');
    expect(await reload.activeClaims(proposal.id)).toEqual([]);

    // Her $45 authorization was voided once, with the deterministic request id.
    expect(gateway.calls).toEqual([{ method: 'voidAuthorization', id: order.authorizationId, requestId: `${proposal.id}:${order.revisionId}:void:${order.customerId}` }]);
    expect(result.paymentOps[0]!.status).toBe('succeeded');
    expect((await reload.order(order.id)).status).toBe('voided');

    // Re-planned against the new schedule: with Bob at 2pm, her extension to Thu 10am now fits as is.
    expect(result.cancelled).toHaveLength(1);
    expect(result.cancelled[0]!.replan?.status).toBe('fits');

    // The feed has every step.
    const feed = await db.select().from(s.activityLog).where(eq(s.activityLog.shopId, shopId)).orderBy(s.activityLog.seq);
    expect(feed.map((e) => e.kind)).toEqual(['proposal_ended', 'booking_edited', 'payment_voided']);
  });

  // Waits between retries for real (0.5s, then 1s).
  it('a failed void is retried with the same id, then alerts the owner; the schedule change stands', async () => {
    const { shopId, bob, proposal, order, dragBob } = await alicePending();
    const failing: GatewayResult = { ok: false, error: '500 INTERNAL_SERVER_ERROR', retryable: true };
    const gateway = fakeGateway();
    gateway.failNext('voidAuthorization', failing, failing, failing);
    const result = await ownerEditBooking(db, gateway, shopId, dragBob({ override: true }));
    if (result.status !== 'applied') throw new Error(JSON.stringify(result));

    expect(gateway.calls).toHaveLength(3);
    expect(new Set(gateway.calls.map((c) => c.requestId)).size).toBe(1);
    expect(result.paymentOps[0]!.status).toBe('failed');
    expect((await reload.order(order.id)).status).toBe('authorized');
    const alerts = await db.select().from(s.escalations).where(and(eq(s.escalations.shopId, shopId), eq(s.escalations.kind, 'payment_failure')));
    expect(alerts).toHaveLength(1);
    expect((await reload.booking(bob.id)).version).toBe(bob.version + 1);
    expect((await reload.proposal(proposal.id)).state).toBe('CANCELLED');
  });
});

describe('owner edits (judge scenarios D1–D5)', () => {
  it('D5: refuses while the claiming proposal is capturing', async () => {
    const { shopId, bob, proposal, dragBob } = await alicePending('CAPTURING');
    const result = await ownerEditBooking(db, fakeGateway(), shopId, dragBob({ override: true }));
    expect(result.status).toBe('refused');
    expect((await reload.booking(bob.id)).version).toBe(bob.version);
    expect((await reload.proposal(proposal.id)).state).toBe('CAPTURING');
  });

  it('refuses without the customer’s agreement', async () => {
    const { shopId, dragBob } = await alicePending();
    const result = await ownerEditBooking(db, fakeGateway(), shopId, dragBob({ attestedCustomerIds: [], override: true }));
    expect(result).toMatchObject({ status: 'refused', reason: expect.stringContaining('Bob hasn\'t agreed') });
  });

  it('refuses a stale view', async () => {
    const { shopId, bob, dragBob } = await alicePending();
    const result = await ownerEditBooking(db, fakeGateway(), shopId, dragBob({ basedOnVersion: bob.version - 1 }));
    expect(result).toEqual({ status: 'stale', currentVersion: bob.version });
  });

  it('D3: refuses a pickup outside shop hours, before any warning or cancellation', async () => {
    const { d, shopId, proposal, dragBob } = await alicePending();
    const result = await ownerEditBooking(db, fakeGateway(), shopId, dragBob({ startsAt: plus(at(d, 'Thu', 14), 9), override: true }));
    expect(result).toMatchObject({ status: 'refused', reason: expect.stringContaining('outside shop hours') });
    expect((await reload.proposal(proposal.id)).state).toBe('AWAITING_APPROVALS');
  });

  it('D1: a drag into another booking becomes a red draft that blocks nothing', async () => {
    const { d, shopId, bob, proposal, dragBob } = await alicePending();
    const result = await ownerEditBooking(db, fakeGateway(), shopId, dragBob({ unitId: d.unit('A7IV-2').id, startsAt: bob.startsAt, override: true }));
    expect(result).toMatchObject({ status: 'draft', violations: [{ rule: 'overlap', message: "overlaps Charlie's booking on A7IV-2" }] });
    expect((await reload.booking(bob.id)).version).toBe(bob.version);
    expect((await reload.proposal(proposal.id)).state).toBe('AWAITING_APPROVALS');
    const drafts = await db.select().from(s.ownerDrafts).where(eq(s.ownerDrafts.bookingId, bob.id));
    expect(drafts).toHaveLength(1);
  });

  it('a clean edit with no pending request applies at once and clears an earlier draft', async () => {
    const d = await seedShop(db, { sessionKey: randomUUID() });
    const gina = d.bookingOf('Gina');
    const first = await ownerEditBooking(db, fakeGateway(), d.shop.id, {
      bookingId: gina.id, unitId: d.unit('A7IV-2').id, startsAt: d.bookingOf('Charlie').startsAt, endsAt: gina.endsAt,
      basedOnVersion: gina.version, attestedCustomerIds: [gina.customerId],
    });
    expect(first.status).toBe('draft');
    const result = await ownerEditBooking(db, fakeGateway(), d.shop.id, {
      bookingId: gina.id, unitId: d.unit('A7IV-1').id, startsAt: gina.startsAt, endsAt: gina.endsAt,
      basedOnVersion: gina.version, attestedCustomerIds: [gina.customerId],
    });
    expect(result).toMatchObject({ status: 'applied', cancelled: [], paymentOps: [] });
    expect(await db.select().from(s.ownerDrafts).where(eq(s.ownerDrafts.bookingId, gina.id))).toEqual([]);
  });
});

describe.skipIf(!process.env.PAYPAL_CLIENT_ID)('PayPal sandbox: voiding a real authorization', () => {
  it('voids, and a repeat with the same or a new request id is still a success', async () => {
    const client = createPayPalClient();
    const order = await client.call('POST', '/v2/checkout/orders', {
      intent: 'AUTHORIZE',
      purchase_units: [{ reference_id: 'rentflow-test', amount: { currency_code: 'USD', value: '45.00' } }],
      payment_source: { card: { number: '4111111111111111', expiry: '2030-12', security_code: '123', name: 'RentFlow Test' } },
    }, { requestId: randomUUID() });
    expect(order.status).toBe(201);
    const authorizationId: string = order.body.purchase_units[0].payments.authorizations[0].id;

    const gateway = payPalGateway(client);
    const requestId = `test:${randomUUID()}:void`;
    expect(await gateway.voidAuthorization(authorizationId, requestId)).toMatchObject({ ok: true });
    expect(await gateway.voidAuthorization(authorizationId, requestId)).toMatchObject({ ok: true });
    expect(await gateway.voidAuthorization(authorizationId, `${requestId}:again`)).toMatchObject({ ok: true });

    const auth = await client.call('GET', `/v2/payments/authorizations/${authorizationId}`);
    expect(auth.body.status).toBe('VOIDED');
  }, 30_000);
});
