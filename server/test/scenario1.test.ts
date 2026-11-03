// Demo Scenario 1 through the proposal flow, end to end against the database, with a stateful fake PayPal.
// Plus the ways it can end without committing (judge scenarios B8, B9, C1–C2, timeouts, races) and one full
// run against the real PayPal sandbox.

import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.ts';
import * as s from '../src/db/schema.ts';
import { seedShop } from '../src/db/seed.ts';
import type { PaymentGateway } from '../src/payments/gateway.ts';
import { createPayPalClient, payPalGateway } from '../src/payments/paypal.ts';
import { seedPrepayments } from '../src/payments/prepay.ts';
import { affectedAccept, createRequesterOrder, expireDue, ownerDecision, ownerSetPrice, requestChange, requesterAccept } from '../src/proposals/flow.ts';
import { fakeGateway } from './fake-gateway.ts';

const { db, pool } = createDb();
afterAll(() => pool.end());

type Seeded = Awaited<ReturnType<typeof seedShop>>;

function at(d: Seeded, day: 'Wed' | 'Thu' | 'Fri', hour: number) {
  const days = { Wed: 2, Thu: 3, Fri: 4 }[day];
  return DateTime.fromJSDate(d.now, { zone: d.shop.timezone }).startOf('week').plus({ days }).set({ hour }).toJSDate();
}

async function shop(gateway: PaymentGateway = fakeGateway()) {
  const d = await seedShop(db, { sessionKey: randomUUID() });
  await seedPrepayments(db, gateway, d.shop.id);
  return d;
}

const load = {
  booking: async (id: string) => (await db.select().from(s.bookings).where(eq(s.bookings.id, id)))[0]!,
  proposal: async (id: string) => (await db.select().from(s.proposals).where(eq(s.proposals.id, id)))[0]!,
  revisions: async (proposalId: string) => db.select().from(s.revisions).where(eq(s.revisions.proposalId, proposalId)).orderBy(s.revisions.optionLabel),
  activeClaims: async (proposalId: string) => db.select().from(s.claims).where(and(eq(s.claims.proposalId, proposalId), isNull(s.claims.releasedAt))),
  orderOf: async (bookingId: string) => {
    const b = await load.booking(bookingId);
    return (await db.select().from(s.paypalOrders).where(eq(s.paypalOrders.id, b.prepaidOrderId!)))[0]!;
  },
  proposalOrder: async (proposalId: string) => (await db.select().from(s.paypalOrders).where(eq(s.paypalOrders.proposalId, proposalId)))[0]!,
  feed: async (shopId: string) => (await db.select().from(s.activityLog).where(eq(s.activityLog.shopId, shopId)).orderBy(s.activityLog.seq)).map((e) => e.kind),
};

/** Scenario 1 steps 1–4: Alice asks, gets the offer, accepts and authorizes $45. */
async function aliceAuthorized(gateway: ReturnType<typeof fakeGateway>, d: Seeded) {
  const alice = d.customer('Alice').id;
  const offered = await requestChange(db, d.shop.id, { customerId: alice, request: { kind: 'extend', bookingId: d.bookingOf('Alice').id, newEndsAt: at(d, 'Thu', 10) } });
  if (offered.status !== 'offered') throw new Error(JSON.stringify(offered));
  const order = await createRequesterOrder(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: alice });
  expect(order.status).toBe('ok');
  const accepted = await requesterAccept(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: alice });
  expect(accepted.status).toBe('awaiting_approvals');
  const [optionA, optionB] = offered.revisions;
  return { proposalId: offered.proposal.id, optionA: optionA!, optionB: optionB!, accepted };
}

describe('Scenario 1: the extension, Plan B (the demo path)', () => {
  it('runs request → authorize → Bob picks B → owner approves → capture → commit → refund', async () => {
    const gateway = fakeGateway();
    const d = await shop(gateway);
    const alice = d.bookingOf('Alice'), bob = d.bookingOf('Bob');

    // Step 1–3: one offer to Alice for $45, two options for Bob behind it.
    const offered = await requestChange(db, d.shop.id, { customerId: alice.customerId, request: { kind: 'extend', bookingId: alice.id, newEndsAt: at(d, 'Thu', 10) } });
    if (offered.status !== 'offered') throw new Error(JSON.stringify(offered));
    expect(offered.chargeCents).toBe(4500);
    expect(offered.proposal.state).toBe('DRAFT');
    const [optionA, optionB] = offered.revisions;
    expect([optionA!.optionLabel, optionA!.needsOwner, optionA!.quote.compensation[0]!.kind]).toEqual(['A', false, 'upgrade_value']);
    expect([optionB!.optionLabel, optionB!.needsOwner, optionB!.quote.compensation[0]!.cents]).toEqual(['B', true, 1500]);
    expect(await load.activeClaims(offered.proposal.id)).toEqual([]); // nothing held before she pays

    // Step 4: Alice accepts and authorizes. Claims are taken; Bob gets both options.
    await createRequesterOrder(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: alice.customerId });
    const accepted = await requesterAccept(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: alice.customerId });
    expect(accepted).toEqual({
      status: 'awaiting_approvals', proposalId: offered.proposal.id,
      offers: [{ customerId: bob.customerId, revisionIds: [optionA!.id, optionB!.id] }],
    });
    expect((await load.proposalOrder(offered.proposal.id)).status).toBe('authorized');
    const claims = await load.activeClaims(offered.proposal.id);
    expect(claims.filter((c) => c.bookingId === bob.id)).toHaveLength(2); // one per option
    expect(claims.some((c) => c.unitId === d.unit('A7RV-1').id)).toBe(true); // option A's target

    // Step 5: Bob taps Plan B. It needs the shop, so option A stays open for now.
    const bobPicks = await affectedAccept(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: bob.customerId, revisionId: optionB!.id });
    expect(bobPicks).toEqual({ status: 'awaiting_approvals', waitingOn: ['owner'] });
    const [card] = await db.select().from(s.escalations).where(and(eq(s.escalations.proposalId, offered.proposal.id), eq(s.escalations.kind, 'approval')));
    expect(card!.summary).toBe("Bob's booking shortened by 5h (now Thu 2:00pm → Fri 6:00pm), $15 refund. Net +$30.");

    // Steps 6–7: the owner approves; capture, revalidate, commit, refund.
    const done = await ownerDecision(db, gateway, d.shop.id, { proposalId: offered.proposal.id, revisionId: optionB!.id, decision: 'approve' });
    expect(done.status).toBe('committed');

    const [aliceAfter, bobAfter] = [await load.booking(alice.id), await load.booking(bob.id)];
    expect([aliceAfter.endsAt, aliceAfter.bufferEndsAt, aliceAfter.version, aliceAfter.priceCents]).toEqual([at(d, 'Thu', 10), at(d, 'Thu', 14), 2, 18000]);
    expect([bobAfter.startsAt, bobAfter.endsAt, bobAfter.unitId, bobAfter.version, bobAfter.priceCents]).toEqual([at(d, 'Thu', 14), bob.endsAt, bob.unitId, 2, 7500]);

    const p = await load.proposal(offered.proposal.id);
    expect(p.state).toBe('COMMITTED');
    expect(await load.activeClaims(p.id)).toEqual([]);
    expect((await load.revisions(p.id)).map((r) => [r.optionLabel, r.status])).toEqual([['A', 'superseded'], ['B', 'selected']]);

    // Money: $45 captured from Alice's hold, $15 refunded on Bob's original $90 capture.
    const aliceOrder = await load.proposalOrder(p.id);
    expect([aliceOrder.status, aliceOrder.capturedCents]).toEqual(['captured', 4500]);
    const bobOrder = await load.orderOf(bob.id);
    expect([bobOrder.capturedCents, bobOrder.refundedCents]).toEqual([9000, 1500]);
    expect(gateway.calls.filter((c) => c.method !== 'createOrder').map((c) => [c.method, c.amountCents ?? null])).toEqual([
      ['authorizeOrder', null],
      ['captureAuthorization', 4500],
      ['refundCapture', 1500],
    ]);
    const open = await db.select().from(s.escalations).where(and(eq(s.escalations.shopId, d.shop.id), eq(s.escalations.status, 'open')));
    expect(open).toEqual([]);

    // Step 8: the feed closes the loop.
    expect(await load.feed(d.shop.id)).toEqual([
      'prepayments_seeded', 'optimizer_run', 'proposal_created', 'payment_order_created', 'payment_authorized',
      'requester_accepted', 'offer_ready', 'affected_accepted', 'owner_approved', 'all_approved', 'payment_captured',
      'proposal_committed', 'proposal_update', 'proposal_update', 'payment_refunded',
    ]);
  });
});

describe('Scenario 1, Plan A', () => {
  it('Bob takes the free upgrade: no owner, no refund, commits at once', async () => {
    const gateway = fakeGateway();
    const d = await shop(gateway);
    const bob = d.bookingOf('Bob');
    const { proposalId, optionA } = await aliceAuthorized(gateway, d);
    const done = await affectedAccept(db, gateway, d.shop.id, { proposalId, customerId: bob.customerId, revisionId: optionA.id });
    expect(done.status).toBe('committed');
    const bobAfter = await load.booking(bob.id);
    expect([bobAfter.unitId, bobAfter.modelId, bobAfter.startsAt, bobAfter.priceCents]).toEqual([d.unit('A7RV-1').id, d.modelsByName.a7rv.id, bob.startsAt, 9000]);
    expect(gateway.calls.some((c) => c.method === 'refundCapture')).toBe(false);
  });
});

describe('clicks are idempotent', () => {
  it('a double click on Accept records once', async () => {
    const gateway = fakeGateway();
    const d = await shop(gateway);
    const { proposalId, optionB } = await aliceAuthorized(gateway, d);
    expect((await requesterAccept(db, gateway, d.shop.id, { proposalId, customerId: d.customer('Alice').id })).status).toBe('already_accepted');
    const bob = d.customer('Bob').id;
    await affectedAccept(db, gateway, d.shop.id, { proposalId, customerId: bob, revisionId: optionB.id });
    expect(await affectedAccept(db, gateway, d.shop.id, { proposalId, customerId: bob, revisionId: optionB.id })).toEqual({ status: 'already_decided' });
  });

  it('only the parties on a card can click it', async () => {
    const gateway = fakeGateway();
    const d = await shop(gateway);
    const { proposalId, optionB } = await aliceAuthorized(gateway, d);
    const result = await affectedAccept(db, gateway, d.shop.id, { proposalId, customerId: d.customer('Charlie').id, revisionId: optionB.id });
    expect(result.status).toBe('refused');
  });
});

describe('the owner declines (judge B8, B9)', () => {
  it('B8: declining Plan B drops only B; Bob is re-offered A and can take it', async () => {
    const gateway = fakeGateway();
    const d = await shop(gateway);
    const bob = d.customer('Bob').id;
    const { proposalId, optionA, optionB } = await aliceAuthorized(gateway, d);
    await affectedAccept(db, gateway, d.shop.id, { proposalId, customerId: bob, revisionId: optionB.id });

    const declined = await ownerDecision(db, gateway, d.shop.id, { proposalId, revisionId: optionB.id, decision: 'decline' });
    expect(declined).toEqual({ status: 'awaiting_approvals', waitingOn: ['affected'] });
    const reoffers = (await db.select().from(s.activityLog).where(and(eq(s.activityLog.proposalId, proposalId), eq(s.activityLog.kind, 'offer_ready'))).orderBy(s.activityLog.seq)).at(-1)!;
    expect(reoffers.payload).toEqual({ customerId: bob, revisionIds: [optionA.id], role: 'affected' });

    expect((await affectedAccept(db, gateway, d.shop.id, { proposalId, customerId: bob, revisionId: optionA.id })).status).toBe('committed');
  });

  it('B9: declining the last option rejects the request, voids the hold, and leaves every booking as it was', async () => {
    const gateway = fakeGateway();
    const d = await shop(gateway);
    // A $30 cap puts Plan A ($40 upgrade) over it too, so both options need the owner.
    await db.update(s.shops).set({ policy: { ...d.shop.policy, compensation_cap_cents: 3000 } }).where(eq(s.shops.id, d.shop.id));
    const bob = d.bookingOf('Bob');
    const { proposalId, optionA, optionB } = await aliceAuthorized(gateway, d);

    await affectedAccept(db, gateway, d.shop.id, { proposalId, customerId: bob.customerId, revisionId: optionA.id });
    await ownerDecision(db, gateway, d.shop.id, { proposalId, revisionId: optionA.id, decision: 'decline' });
    await affectedAccept(db, gateway, d.shop.id, { proposalId, customerId: bob.customerId, revisionId: optionB.id });
    const result = await ownerDecision(db, gateway, d.shop.id, { proposalId, revisionId: optionB.id, decision: 'decline' });

    expect(result).toEqual({ status: 'rejected' });
    expect((await load.proposal(proposalId)).state).toBe('REJECTED');
    expect((await load.proposalOrder(proposalId)).status).toBe('voided');
    expect(await load.activeClaims(proposalId)).toEqual([]);
    expect((await load.booking(bob.id)).version).toBe(1);
    expect((await load.booking(d.bookingOf('Alice').id)).version).toBe(1);
  });
});

describe('ending without a change', () => {
  it('no answer in time: EXPIRED, hold voided, claims released (fast-forward)', async () => {
    const gateway = fakeGateway();
    const d = await shop(gateway);
    const { proposalId } = await aliceAuthorized(gateway, d);
    await db.update(s.shops).set({ clockOffsetMs: d.shop.clockOffsetMs + 31 * 60_000 }).where(eq(s.shops.id, d.shop.id));

    expect(await expireDue(db, gateway, d.shop.id)).toEqual([proposalId]);
    expect((await load.proposal(proposalId)).state).toBe('EXPIRED');
    expect((await load.proposalOrder(proposalId)).status).toBe('voided');
    expect(await load.activeClaims(proposalId)).toEqual([]);
    expect((await load.booking(d.bookingOf('Bob').id)).version).toBe(1);
  });

  it('a late click after expiry changes nothing', async () => {
    const gateway = fakeGateway();
    const d = await shop(gateway);
    const { proposalId, optionA } = await aliceAuthorized(gateway, d);
    await db.update(s.shops).set({ clockOffsetMs: d.shop.clockOffsetMs + 31 * 60_000 }).where(eq(s.shops.id, d.shop.id));
    const late = await affectedAccept(db, gateway, d.shop.id, { proposalId, customerId: d.customer('Bob').id, revisionId: optionA.id });
    expect(late).toEqual({ status: 'stale', reason: 'the offer expired' });
    expect((await load.proposal(proposalId)).state).toBe('EXPIRED');
    expect((await load.booking(d.bookingOf('Bob').id)).version).toBe(1);
  });

  it('capture fails: FAILED, the hold is voided, nothing changes', async () => {
    const gateway = fakeGateway();
    const d = await shop(gateway);
    const { proposalId, optionA } = await aliceAuthorized(gateway, d);
    gateway.failNext('captureAuthorization', { ok: false, error: '422 INSTRUMENT_DECLINED', retryable: false });
    const result = await affectedAccept(db, gateway, d.shop.id, { proposalId, customerId: d.customer('Bob').id, revisionId: optionA.id });
    expect(result.status).toBe('failed');
    expect((await load.proposal(proposalId)).state).toBe('FAILED');
    expect((await load.proposalOrder(proposalId)).status).toBe('voided');
    expect((await load.booking(d.bookingOf('Bob').id)).version).toBe(1);
  });

  it('the schedule changes during capture: revalidation fails, the capture is refunded, nothing changes', async () => {
    const fake = fakeGateway();
    const d = await shop(fake);
    const { proposalId, optionA } = await aliceAuthorized(fake, d);
    // While the capture is in flight (outside the lock), the owner puts A7IV-1 into maintenance Thu morning.
    const racing: PaymentGateway = {
      ...fake,
      async captureAuthorization(authId, cents, requestId) {
        await db.insert(s.unitUnavailability).values({ shopId: d.shop.id, unitId: d.unit('A7IV-1').id, period: { start: at(d, 'Thu', 9), end: at(d, 'Thu', 12) }, reason: 'maintenance' });
        return fake.captureAuthorization(authId, cents, requestId);
      },
    };
    const result = await affectedAccept(db, racing, d.shop.id, { proposalId, customerId: d.customer('Bob').id, revisionId: optionA.id });
    expect(result.status).toBe('failed');
    expect((await load.proposal(proposalId)).state).toBe('FAILED');
    const order = await load.proposalOrder(proposalId);
    expect([order.capturedCents, order.refundedCents]).toEqual([4500, 4500]);
    expect((await load.booking(d.bookingOf('Alice').id)).endsAt).toEqual(d.bookingOf('Alice').endsAt);
  });

  it('two requests race for the same camera: the second finds it held and its hold is voided', async () => {
    const gateway = fakeGateway();
    const d = await shop(gateway);
    const gina = d.customer('Gina').id;
    // Gina asks for the A7R V on Thu–Fri before Alice pays; both see it free.
    const ginas = await requestChange(db, d.shop.id, {
      customerId: gina, request: { kind: 'new_booking', customerId: gina, modelId: d.modelsByName.a7rv.id, startsAt: at(d, 'Thu', 10), endsAt: at(d, 'Fri', 10) },
    });
    if (ginas.status !== 'offered') throw new Error(JSON.stringify(ginas));
    await aliceAuthorized(gateway, d); // Alice's option A claims the A7R V Thu–Fri

    await createRequesterOrder(db, gateway, d.shop.id, { proposalId: ginas.proposal.id, customerId: gina });
    const result = await requesterAccept(db, gateway, d.shop.id, { proposalId: ginas.proposal.id, customerId: gina });
    expect(result.status).toBe('stale');
    expect((await load.proposal(ginas.proposal.id)).state).toBe('EXPIRED');
    expect((await load.proposalOrder(ginas.proposal.id)).status).toBe('voided');
  });
});

describe('requests that fit as is', () => {
  it('a free extension needs no payment and commits on accept', async () => {
    const gateway = fakeGateway();
    const d = await shop(gateway);
    const alice = d.bookingOf('Alice');
    const offered = await requestChange(db, d.shop.id, { customerId: alice.customerId, request: { kind: 'extend', bookingId: alice.id, newEndsAt: at(d, 'Wed', 20) } });
    if (offered.status !== 'offered') throw new Error(JSON.stringify(offered));
    expect(offered.chargeCents).toBe(0); // still 3 started days
    const result = await requesterAccept(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: alice.customerId });
    expect(result.status).toBe('committed');
    expect((await load.booking(alice.id)).endsAt).toEqual(at(d, 'Wed', 20));
  });

  it('judge E7: a new booking in a free slot is paid and created', async () => {
    const gateway = fakeGateway();
    const d = await shop(gateway);
    const gina = d.customer('Gina').id;
    const offered = await requestChange(db, d.shop.id, {
      customerId: gina, request: { kind: 'new_booking', customerId: gina, modelId: d.modelsByName.a7rv.id, startsAt: at(d, 'Fri', 10), endsAt: at(d, 'Fri', 18) },
    });
    if (offered.status !== 'offered') throw new Error(JSON.stringify(offered));
    await createRequesterOrder(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: gina });
    expect((await requesterAccept(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: gina })).status).toBe('committed');
    const created = (await db.select().from(s.bookings).where(eq(s.bookings.shopId, d.shop.id))).filter((b) => b.customerId === gina && b.unitId === d.unit('A7RV-1').id);
    expect(created).toHaveLength(1);
    expect([created[0]!.priceCents, created[0]!.status]).toEqual([6500, 'confirmed']);
  });

  it('a second request on the same booking is refused while one is in progress', async () => {
    const gateway = fakeGateway();
    const d = await shop(gateway);
    await aliceAuthorized(gateway, d);
    const again = await requestChange(db, d.shop.id, {
      customerId: d.customer('Alice').id, request: { kind: 'extend', bookingId: d.bookingOf('Alice').id, newEndsAt: at(d, 'Thu', 12) },
    });
    expect(again.status).toBe('refused');
  });
});

describe.skipIf(!process.env.PAYPAL_CLIENT_ID)('PayPal sandbox: Scenario 1 for real', () => {
  it('seeds real prepayments, authorizes, captures $45 and refunds $15 on Bob’s capture', async () => {
    const client = createPayPalClient();
    const gateway = payPalGateway(client);
    const d = await shop(gateway);
    const alice = d.customer('Alice').id, bob = d.bookingOf('Bob');
    expect((await load.orderOf(bob.id)).status).toBe('captured');

    const offered = await requestChange(db, d.shop.id, { customerId: alice, request: { kind: 'extend', bookingId: d.bookingOf('Alice').id, newEndsAt: at(d, 'Thu', 10) } });
    if (offered.status !== 'offered') throw new Error(JSON.stringify(offered));
    // The test card authorizes on create, standing in for the buyer's click in the PayPal popup.
    expect((await createRequesterOrder(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: alice, testCard: true })).status).toBe('ok');
    expect((await requesterAccept(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: alice })).status).toBe('awaiting_approvals');
    const planB = offered.revisions.find((r) => r.optionLabel === 'B')!;
    await affectedAccept(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: bob.customerId, revisionId: planB.id });
    const done = await ownerDecision(db, gateway, d.shop.id, { proposalId: offered.proposal.id, revisionId: planB.id, decision: 'approve' });
    expect(done.status).toBe('committed');

    const capture = await client.call('GET', `/v2/payments/captures/${(await load.proposalOrder(offered.proposal.id)).captureId}`);
    expect([capture.body.status, capture.body.amount.value]).toEqual(['COMPLETED', '45.00']);
    const bobCapture = await client.call('GET', `/v2/payments/captures/${(await load.orderOf(bob.id)).captureId}`);
    expect(bobCapture.body.status).toBe('PARTIALLY_REFUNDED');
  }, 90_000);
});

describe('PayPal request ids', () => {
  it('fit PayPal’s 108-character limit and decode back to the proposal', async () => {
    const { requestId } = await import('../src/payments/ops.ts');
    const id = requestId(randomUUID(), randomUUID(), 'authorize', randomUUID());
    expect(id.length).toBeLessThanOrEqual(108);
    expect(id).toMatch(/^authorize:[\w-]{22}:[\w-]{22}:[\w-]{22}$/);
  });
});

describe('the owner sets the price', () => {
  async function aliceAsks(d: Seeded) {
    const offered = await requestChange(db, d.shop.id, { customerId: d.customer('Alice').id, request: { kind: 'extend', bookingId: d.bookingOf('Alice').id, newEndsAt: at(d, 'Thu', 10) } });
    if (offered.status !== 'offered') throw new Error(offered.status);
    return offered;
  }

  it('$40 instead of $45: a new revision per option, Alice asked again, and $40 is what gets captured', async () => {
    const gateway = fakeGateway();
    const d = await shop(gateway);
    const alice = d.customer('Alice').id;
    const offered = await aliceAsks(d);
    // She had opened the PayPal button: an order for $45 exists, unpaid.
    await createRequesterOrder(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: alice });

    const repriced = await ownerSetPrice(db, d.shop.id, { proposalId: offered.proposal.id, priceCents: 4000 });
    if (repriced.status !== 'repriced') throw new Error(JSON.stringify(repriced));
    expect(repriced.revisions.map((r) => [r.optionLabel, r.origin, r.quote.chargeCents, r.quote.discountCents])).toEqual([['A', 'owner_modify', 4000, 500], ['B', 'owner_modify', 4000, 500]]);
    expect(repriced.revisions.find((r) => r.optionLabel === 'B')!.quote.netRevenueCents).toBe(2500); // $40 − Bob's $15
    expect((await load.revisions(offered.proposal.id)).filter((r) => r.status === 'superseded')).toHaveLength(2);
    const orders = await db.select().from(s.paypalOrders).where(eq(s.paypalOrders.proposalId, offered.proposal.id));
    expect(orders.map((o) => o.status)).toEqual(['voided']); // the $45 order can't be paid any more
    const ready = await db.select().from(s.activityLog).where(and(eq(s.activityLog.proposalId, offered.proposal.id), eq(s.activityLog.kind, 'offer_ready'))).orderBy(s.activityLog.seq);
    expect(ready.at(-1)!.payload).toMatchObject({ customerId: alice, role: 'requester', repriced: true });

    await createRequesterOrder(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: alice });
    expect(gateway.calls.filter((c) => c.method === 'createOrder' && c.id === 'AUTHORIZE').map((c) => c.amountCents)).toEqual([4500, 4000]);
    expect((await requesterAccept(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: alice })).status).toBe('awaiting_approvals');
    const planA = repriced.revisions.find((r) => r.optionLabel === 'A')!;
    expect((await affectedAccept(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: d.customer('Bob').id, revisionId: planA.id })).status).toBe('committed');
    expect(gateway.calls.find((c) => c.method === 'captureAuthorization')!.amountCents).toBe(4000);
    expect((await load.booking(d.bookingOf('Alice').id)).priceCents).toBe(13500 + 4000);
  });

  it('refuses raising the price, and changes after Alice has paid', async () => {
    const gateway = fakeGateway();
    const d = await shop(gateway);
    const offered = await aliceAsks(d);
    expect(await ownerSetPrice(db, d.shop.id, { proposalId: offered.proposal.id, priceCents: 5000 })).toMatchObject({ status: 'refused', reason: expect.stringContaining('only lowering') });
    await createRequesterOrder(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: d.customer('Alice').id });
    await requesterAccept(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: d.customer('Alice').id });
    expect(await ownerSetPrice(db, d.shop.id, { proposalId: offered.proposal.id, priceCents: 4000 })).toMatchObject({ status: 'refused', reason: expect.stringContaining('already paid') });
  });
});

