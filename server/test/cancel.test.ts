// The owner cancels a booking: Delete on the schedule, agreed by phone, and everything the customer paid goes back.

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { afterAll, describe, expect, it } from 'vitest';
import { createAgentService } from '../src/agent/service.ts';
import { createDb } from '../src/db/client.ts';
import * as s from '../src/db/schema.ts';
import { seedShop } from '../src/db/seed.ts';
import { ownerCancelBooking } from '../src/owner/edit-booking.ts';
import type { PaymentGateway } from '../src/payments/gateway.ts';
import { payPalGateway } from '../src/payments/paypal.ts';
import { seedPrepayments } from '../src/payments/prepay.ts';
import { affectedAccept, createRequesterOrder, ownerDecision, requestChange, requesterAccept } from '../src/proposals/flow.ts';
import { customerView } from '../src/server/views.ts';
import { fakeGateway } from './fake-gateway.ts';

const { db, pool } = createDb();
afterAll(() => pool.end());

type Seeded = Awaited<ReturnType<typeof seedShop>>;

async function shop(gateway: PaymentGateway = fakeGateway()) {
  const d = await seedShop(db, { sessionKey: randomUUID() });
  await seedPrepayments(db, gateway, d.shop.id);
  return d;
}

function at(d: Seeded, day: 'Thu' | 'Fri', hour: number) {
  return DateTime.fromJSDate(d.now, { zone: d.shop.timezone }).startOf('week').plus({ days: day === 'Thu' ? 3 : 4 }).set({ hour }).toJSDate();
}

const booking = async (id: string) => (await db.select().from(s.bookings).where(eq(s.bookings.id, id)))[0]!;
const fresh = async (d: Seeded, name: string) => booking(d.bookingOf(name).id);
const refunds = (d: Seeded) => db.select().from(s.paymentOps).where(and(eq(s.paymentOps.shopId, d.shop.id), eq(s.paymentOps.kind, 'refund')));
const cancel = async (gateway: PaymentGateway, d: Seeded, name: string, extra: { agreedByPhone?: boolean; override?: boolean } = {}) => {
  const b = await fresh(d, name);
  return ownerCancelBooking(db, gateway, d.shop.id, { bookingId: b.id, basedOnVersion: b.version, agreedByPhone: true, ...extra });
};

/** Vincent has paid her hold and Bob is deciding: her request claims his booking. */
async function vincentWaitingOnBob(gateway: ReturnType<typeof fakeGateway>, d: Seeded) {
  const vincent = d.customer('Vincent').id;
  const r = await requestChange(db, d.shop.id, { customerId: vincent, request: { kind: 'extend', bookingId: d.bookingOf('Vincent').id, newEndsAt: at(d, 'Thu', 10) } });
  if (r.status !== 'offered') throw new Error(JSON.stringify(r));
  await createRequesterOrder(db, gateway, d.shop.id, { proposalId: r.proposal.id, customerId: vincent });
  await requesterAccept(db, gateway, d.shop.id, { proposalId: r.proposal.id, customerId: vincent });
  return r;
}

describe('the owner cancels a booking', () => {
  it('refunds everything they paid, frees the slot and tells them', async () => {
    const gateway = fakeGateway();
    const d = await shop(gateway);
    const agent = createAgentService(db, { client: null, model: 'none', effort: 'low', turnCap: 60 }, () => {}, { shopId: d.shop.id });
    await agent.poll();
    const gina = await fresh(d, 'Gina');

    expect(await cancel(gateway, d, 'Gina')).toEqual({ status: 'cancelled', refundCents: gina.priceCents, refundsOk: true, replanned: [] });
    const after = await booking(gina.id);
    expect([after.status, after.version]).toEqual(['cancelled', gina.version + 1]);
    const [op] = await refunds(d);
    expect([op!.status, op!.amountCents]).toEqual(['succeeded', gina.priceCents]);
    expect(op!.requestId.length).toBeLessThanOrEqual(108);
    const [order] = await db.select().from(s.paypalOrders).where(eq(s.paypalOrders.id, gina.prepaidOrderId!));
    expect(order!.refundedCents).toBe(gina.priceCents);

    // Gone from the owner's schedule and the customer's list, and the slot can be booked again.
    const view = await db.transaction((tx) => customerView(tx, d.shop.id, gina.customerId));
    expect(view!.bookings).toEqual([]);
    const hank = d.customer('Hank').id;
    const rebook = await requestChange(db, d.shop.id, { customerId: hank, request: { kind: 'new_booking', customerId: hank, modelId: gina.modelId, startsAt: gina.startsAt, endsAt: gina.endsAt } });
    expect(rebook).toMatchObject({ status: 'offered' });

    await agent.poll();
    await agent.drain();
    const told = await db.transaction((tx) => customerView(tx, d.shop.id, gina.customerId));
    expect(told!.messages.at(-1)!.body).toMatch(/cancelled your booking.*\$\d+\.\d\d.*original payment/);
  });

  it('needs the customer\'s agreement', async () => {
    const gateway = fakeGateway();
    const d = await shop(gateway);
    expect(await cancel(gateway, d, 'Gina', { agreedByPhone: false })).toMatchObject({ status: 'refused', reason: expect.stringContaining('agreed by phone') });
    expect((await fresh(d, 'Gina')).status).toBe('confirmed');
    expect(await refunds(d)).toEqual([]);
  });

  it('refuses a rental out with the customer, a stale view, and a second cancel', async () => {
    const gateway = fakeGateway();
    const d = await shop(gateway);
    expect(await cancel(gateway, d, 'Vincent')).toMatchObject({ status: 'refused', reason: expect.stringContaining('mark it returned') });

    const gina = await fresh(d, 'Gina');
    expect(await ownerCancelBooking(db, gateway, d.shop.id, { bookingId: gina.id, basedOnVersion: gina.version + 5, agreedByPhone: true })).toEqual({ status: 'stale', currentVersion: gina.version });

    await cancel(gateway, d, 'Gina');
    expect(await ownerCancelBooking(db, gateway, d.shop.id, { bookingId: gina.id, basedOnVersion: gina.version + 1, agreedByPhone: true })).toMatchObject({ status: 'refused', reason: expect.stringContaining('already cancelled') });
    expect(await refunds(d)).toHaveLength(1);
  });

  it('never touches another shop\'s booking', async () => {
    const gateway = fakeGateway();
    const [mine, theirs] = [await shop(gateway), await shop(gateway)];
    const gina = theirs.bookingOf('Gina');
    expect(await ownerCancelBooking(db, gateway, mine.shop.id, { bookingId: gina.id, basedOnVersion: gina.version, agreedByPhone: true })).toMatchObject({ status: 'refused', reason: 'booking not found' });
  });

  it('a customer\'s two cancelled bookings get two refunds: PayPal would replay a reused id', async () => {
    const gateway = fakeGateway();
    const d = await shop(gateway);
    const hank = d.customer('Hank').id;
    const start = at(d, 'Thu', 9);
    const second = await requestChange(db, d.shop.id, { customerId: hank, request: { kind: 'new_booking', customerId: hank, modelId: d.modelsByName.crane4.id, startsAt: start, endsAt: at(d, 'Fri', 9) } });
    if (second.status !== 'offered') throw new Error(JSON.stringify(second));
    await createRequesterOrder(db, gateway, d.shop.id, { proposalId: second.proposal.id, customerId: hank });
    expect((await requesterAccept(db, gateway, d.shop.id, { proposalId: second.proposal.id, customerId: hank })).status).toBe('committed');
    const [created] = await db.select().from(s.bookings).where(and(eq(s.bookings.customerId, hank), eq(s.bookings.unitId, d.unit('CRANE4-1').id)));

    await cancel(gateway, d, 'Hank');
    expect(await ownerCancelBooking(db, gateway, d.shop.id, { bookingId: created!.id, basedOnVersion: created!.version, agreedByPhone: true })).toMatchObject({ status: 'cancelled', refundCents: created!.priceCents, refundsOk: true });
    const ops = await refunds(d);
    expect(new Set(ops.map((o) => o.requestId)).size).toBe(2);
    expect(ops.map((o) => o.amountCents).sort((a, b) => a - b)).toEqual([created!.priceCents, d.bookingOf('Hank').priceCents].sort((a, b) => a - b));
  });

  it('refunds an extension they paid for too, across both orders', async () => {
    const gateway = fakeGateway();
    const d = await shop(gateway);
    const hank = d.bookingOf('Hank');
    const newEndsAt = new Date(hank.endsAt.getTime() + 24 * 3600_000);
    const r = await requestChange(db, d.shop.id, { customerId: hank.customerId, request: { kind: 'extend', bookingId: hank.id, newEndsAt } });
    if (r.status !== 'offered') throw new Error(JSON.stringify(r));
    await createRequesterOrder(db, gateway, d.shop.id, { proposalId: r.proposal.id, customerId: hank.customerId });
    expect((await requesterAccept(db, gateway, d.shop.id, { proposalId: r.proposal.id, customerId: hank.customerId })).status).toBe('committed');

    const paid = hank.priceCents + r.chargeCents;
    expect(r.chargeCents).toBeGreaterThan(0);
    expect(await cancel(gateway, d, 'Hank')).toMatchObject({ status: 'cancelled', refundCents: paid, refundsOk: true });
    expect((await refunds(d)).map((o) => o.amountCents).sort((a, b) => a - b)).toEqual([hank.priceCents, r.chargeCents].sort((a, b) => a - b));
  });

  it('a refund they already got isn\'t paid twice: Bob got $15 back, so he gets the other $75', async () => {
    const gateway = fakeGateway();
    const d = await shop(gateway);
    const r = await vincentWaitingOnBob(gateway, d);
    const bob = d.customer('Bob').id;
    const planB = r.revisions.find((x) => x.needsOwner)!;
    await affectedAccept(db, gateway, d.shop.id, { proposalId: r.proposal.id, customerId: bob, revisionId: planB.id });
    expect((await ownerDecision(db, gateway, d.shop.id, { proposalId: r.proposal.id, revisionId: planB.id, decision: 'approve' })).status).toBe('committed');
    expect((await fresh(d, 'Bob')).priceCents).toBe(7500);

    expect(await cancel(gateway, d, 'Bob')).toMatchObject({ status: 'cancelled', refundCents: 7500, refundsOk: true });
    expect((await refunds(d)).map((o) => o.amountCents).sort((a, b) => a - b)).toEqual([1500, 7500]);
    const [order] = await db.select().from(s.paypalOrders).where(eq(s.paypalOrders.id, d.bookingOf('Bob').prepaidOrderId ?? (await fresh(d, 'Bob')).prepaidOrderId!));
    expect(order!.refundedCents).toBe(order!.capturedCents);
  });

  it('warns about a request that needs the booking; overriding ends it, voids the hold and re-plans', async () => {
    const gateway = fakeGateway();
    const d = await shop(gateway);
    const r = await vincentWaitingOnBob(gateway, d);

    expect(await cancel(gateway, d, 'Bob')).toMatchObject({ status: 'claimed', proposals: [{ id: r.proposal.id, requesterName: 'Vincent' }] });
    expect((await fresh(d, 'Bob')).status).toBe('confirmed');
    expect(await refunds(d)).toEqual([]);

    const done = await cancel(gateway, d, 'Bob', { override: true });
    if (done.status !== 'cancelled') throw new Error(JSON.stringify(done));
    expect(done.refundCents).toBe(9000);
    expect((await fresh(d, 'Bob')).status).toBe('cancelled');
    const [ended] = await db.select().from(s.proposals).where(eq(s.proposals.id, r.proposal.id));
    expect(ended!.state).toBe('CANCELLED');
    expect((await db.select().from(s.paypalOrders).where(eq(s.paypalOrders.proposalId, r.proposal.id))).map((o) => o.status)).toEqual(['voided']);
    // With Bob gone, Vincent's extension simply fits.
    expect(done.replanned).toHaveLength(1);
    expect(done.replanned[0]!.replan).toMatchObject({ status: 'offered', chargeCents: 4500 });
  });

  it('ends the customer\'s own unpaid request about the booking, with no warning', async () => {
    const gateway = fakeGateway();
    const d = await shop(gateway);
    const hank = d.bookingOf('Hank');
    const r = await requestChange(db, d.shop.id, { customerId: hank.customerId, request: { kind: 'extend', bookingId: hank.id, newEndsAt: new Date(hank.endsAt.getTime() + 24 * 3600_000) } });
    if (r.status !== 'offered') throw new Error(JSON.stringify(r));
    expect(await cancel(gateway, d, 'Hank')).toMatchObject({ status: 'cancelled', replanned: [] });
    const [p] = await db.select().from(s.proposals).where(eq(s.proposals.id, r.proposal.id));
    expect(p!.state).toBe('CANCELLED');
  });

  it('is refused for those few seconds while a payment is being captured', async () => {
    const gateway = fakeGateway();
    const d = await shop(gateway);
    const r = await vincentWaitingOnBob(gateway, d);
    await db.update(s.proposals).set({ state: 'CAPTURING' }).where(eq(s.proposals.id, r.proposal.id));
    expect(await cancel(gateway, d, 'Bob', { override: true })).toMatchObject({ status: 'refused', reason: expect.stringContaining('being captured') });
    expect((await fresh(d, 'Bob')).status).toBe('confirmed');
  });

  it('a refund that fails leaves the booking cancelled and alerts the owner', async () => {
    const gateway = fakeGateway();
    const d = await shop(gateway);
    gateway.failNext('refundCapture', { ok: false, error: 'REFUND_FAILED_INSUFFICIENT_FUNDS', retryable: false });
    expect(await cancel(gateway, d, 'Gina')).toMatchObject({ status: 'cancelled', refundsOk: false });
    expect((await fresh(d, 'Gina')).status).toBe('cancelled');
    const alerts = await db.select().from(s.escalations).where(and(eq(s.escalations.shopId, d.shop.id), eq(s.escalations.kind, 'payment_failure'), eq(s.escalations.status, 'open')));
    expect(alerts).toHaveLength(1);
  });

  it('removes a red draft on the booking', async () => {
    const gateway = fakeGateway();
    const d = await shop(gateway);
    const gina = d.bookingOf('Gina');
    await db.insert(s.ownerDrafts).values({ shopId: d.shop.id, bookingId: gina.id, proposed: {}, basedOnVersion: gina.version });
    await cancel(gateway, d, 'Gina');
    expect(await db.select().from(s.ownerDrafts).where(eq(s.ownerDrafts.bookingId, gina.id))).toEqual([]);
  });
});

describe.skipIf(!process.env.PAYPAL_CLIENT_ID)('PayPal sandbox: cancelling refunds a real capture', () => {
  it('refunds the full amount for real', async () => {
    const gateway = payPalGateway();
    const d = await shop(gateway);
    const gina = await fresh(d, 'Gina');
    expect(await cancel(gateway, d, 'Gina')).toMatchObject({ status: 'cancelled', refundCents: gina.priceCents, refundsOk: true });
    const [op] = await refunds(d);
    expect(op!.status).toBe('succeeded');
    expect(op!.paypalRef).toBeTruthy();
  }, 60_000);
});
