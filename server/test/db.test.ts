// The database-level guarantees from docs/data-model.md. Each test seeds its own shop, as each visitor does.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.ts';
import { allowOwnerShorten, withShopLock } from '../src/db/lock.ts';
import * as s from '../src/db/schema.ts';
import { seedShop } from '../src/db/seed.ts';

const { db, pool } = createDb();
afterAll(() => pool.end());

const H = 3600_000;
const plus = (d: Date, hours: number) => new Date(d.getTime() + hours * H);
const seed = () => seedShop(db, { sessionKey: randomUUID() });
type Seeded = Awaited<ReturnType<typeof seed>>;

const EXCLUSION_VIOLATION = '23P01';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

/** Postgres error code, whether or not Drizzle wrapped the driver error. */
async function pgCode(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    return err.code ?? err.cause?.code;
  }
  return 'no error';
}

async function proposalFor(seeded: Seeded, requester = 'Alice', subject = requester) {
  const [proposal] = await db
    .insert(s.proposals)
    .values({
      shopId: seeded.shop.id,
      source: 'customer_request',
      requesterCustomerId: seeded.customer(requester).id,
      subjectBookingId: seeded.bookingOf(subject).id,
      request: { kind: 'extend' },
      createdAt: seeded.now,
    })
    .returning();
  return proposal!;
}

async function revisionOf(seeded: Seeded, proposalId: string, seq: number, optionLabel: 'A' | 'B' | null = null) {
  const [revision] = await db
    .insert(s.revisions)
    .values({
      shopId: seeded.shop.id,
      proposalId,
      seq,
      optionLabel,
      origin: 'optimizer',
      createdBy: 'agent',
      quote: { lines: [], discountCents: 0, chargeCents: 0, compensation: [], netRevenueCents: 0 },
      netRevenueCents: 0,
      createdAt: seeded.now,
    })
    .returning();
  return revision!;
}

describe('seed', () => {
  it('builds the demo shop with the clock at Wednesday 2pm shop time', async () => {
    const seeded = await seed();
    const shopNow = DateTime.fromMillis(Date.now() + seeded.shop.clockOffsetMs, { zone: seeded.shop.timezone });
    expect(shopNow.weekday).toBe(3);
    expect(shopNow.hour).toBe(14);

    const bookings = await db.select().from(s.bookings).where(eq(s.bookings.shopId, seeded.shop.id));
    expect(bookings).toHaveLength(7);
    expect(seeded.bookingOf('Alice').priceCents).toBe(13500); // Mon 9am → Wed 6pm: 3 started days at $45
    expect(seeded.bookingOf('Alice').bufferEndsAt).toEqual(plus(seeded.bookingOf('Alice').endsAt, 4));
  });

  it('gives every visitor an independent shop', async () => {
    const [a, b] = await Promise.all([seed(), seed()]);
    expect(a.unit('A7IV-1').id).not.toBe(b.unit('A7IV-1').id);
  });
});

describe('bookings: no double-booking (invariant 7)', () => {
  it('rejects a booking overlapping another on the same unit, buffer included', async () => {
    const seeded = await seed();
    const bob = seeded.bookingOf('Bob');
    const code = await pgCode(
      // Ends 1h before Bob starts, but its 4h buffer runs into his booking.
      db.insert(s.bookings).values({
        ...bob,
        id: undefined,
        startsAt: plus(bob.startsAt, -3),
        endsAt: plus(bob.startsAt, -1),
        bufferEndsAt: plus(bob.startsAt, 3),
      }),
    );
    expect(code).toBe(EXCLUSION_VIOLATION);
  });

  it('allows a booking to start exactly when the previous buffer ends', async () => {
    const seeded = await seed();
    const alice = seeded.bookingOf('Alice');
    await db.insert(s.bookings).values({
      ...alice,
      id: undefined,
      status: 'confirmed',
      startsAt: alice.bufferEndsAt,
      endsAt: plus(alice.bufferEndsAt, 1),
      bufferEndsAt: plus(alice.bufferEndsAt, 5),
    });
  });

  it('ignores cancelled bookings', async () => {
    const seeded = await seed();
    const bob = seeded.bookingOf('Bob');
    await db.insert(s.bookings).values({ ...bob, id: undefined, status: 'cancelled' });
  });

  it('checks at commit, so a plan can overlap midway (Scenario 1 commit)', async () => {
    const seeded = await seed();
    const alice = seeded.bookingOf('Alice'), bob = seeded.bookingOf('Bob');
    const thu10 = plus(bob.startsAt, 1), thu14 = plus(bob.startsAt, 5);
    await db.transaction(async (tx) => {
      // Alice's extension lands first and overlaps Bob until his start moves.
      await tx.update(s.bookings).set({ endsAt: thu10, bufferEndsAt: thu14 }).where(eq(s.bookings.id, alice.id));
      await tx.update(s.bookings).set({ startsAt: thu14 }).where(eq(s.bookings.id, bob.id));
    });
  });

  it('rejects the plan at commit if it still overlaps', async () => {
    const seeded = await seed();
    const alice = seeded.bookingOf('Alice'), bob = seeded.bookingOf('Bob');
    const code = await pgCode(
      db.transaction(async (tx) => {
        await tx
          .update(s.bookings)
          .set({ endsAt: plus(bob.startsAt, 1), bufferEndsAt: plus(bob.startsAt, 5) })
          .where(eq(s.bookings.id, alice.id));
      }),
    );
    expect(code).toBe(EXCLUSION_VIOLATION);
    const [after] = await db.select().from(s.bookings).where(eq(s.bookings.id, alice.id));
    expect(after!.endsAt).toEqual(alice.endsAt);
  });
});

describe('bookings: picked-up guard (invariant 3)', () => {
  it('refuses to change the unit of a picked-up rental', async () => {
    const seeded = await seed();
    const code = await pgCode(
      db.update(s.bookings).set({ unitId: seeded.unit('A7IV-3').id }).where(eq(s.bookings.id, seeded.bookingOf('Alice').id)),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('lets only the owner shorten a picked-up rental', async () => {
    const seeded = await seed();
    const alice = seeded.bookingOf('Alice');
    const shorter = { endsAt: plus(alice.endsAt, -2), bufferEndsAt: plus(alice.endsAt, 2) };
    const byAnyone = await pgCode(db.update(s.bookings).set(shorter).where(eq(s.bookings.id, alice.id)));
    expect(byAnyone).toBe(CHECK_VIOLATION);

    await db.transaction(async (tx) => {
      await allowOwnerShorten(tx);
      await tx.update(s.bookings).set(shorter).where(eq(s.bookings.id, alice.id));
    });
  });

  it('allows extending a picked-up rental', async () => {
    const seeded = await seed();
    const alice = seeded.bookingOf('Alice');
    await db
      .update(s.bookings)
      .set({ endsAt: plus(alice.endsAt, 3), bufferEndsAt: plus(alice.endsAt, 7) })
      .where(eq(s.bookings.id, alice.id));
  });
});

describe('claims: one active proposal per booking and slot (invariant 8)', () => {
  it('stops a second proposal claiming a claimed booking, until the claim is released', async () => {
    const seeded = await seed();
    const bob = seeded.bookingOf('Bob');
    const p1 = await proposalFor(seeded, 'Alice');
    const p2 = await proposalFor(seeded, 'Charlie');
    const r1 = await revisionOf(seeded, p1.id, 1);
    const r2 = await revisionOf(seeded, p2.id, 1);
    const [claim] = await db
      .insert(s.claims)
      .values({ shopId: seeded.shop.id, proposalId: p1.id, revisionId: r1.id, bookingId: bob.id })
      .returning();

    const code = await pgCode(
      db.insert(s.claims).values({ shopId: seeded.shop.id, proposalId: p2.id, revisionId: r2.id, bookingId: bob.id }),
    );
    expect(code).toBe(EXCLUSION_VIOLATION);

    await db.update(s.claims).set({ releasedAt: new Date() }).where(eq(s.claims.id, claim!.id));
    await db.insert(s.claims).values({ shopId: seeded.shop.id, proposalId: p2.id, revisionId: r2.id, bookingId: bob.id });
  });

  it("lets one proposal's options claim overlapping capacity, but not another proposal", async () => {
    const seeded = await seed();
    const a7rv = seeded.unit('A7RV-1').id;
    const bob = seeded.bookingOf('Bob');
    const period = { start: bob.startsAt, end: bob.bufferEndsAt };
    const p1 = await proposalFor(seeded, 'Alice');
    const optionA = await revisionOf(seeded, p1.id, 1, 'A');
    const optionB = await revisionOf(seeded, p1.id, 1, 'B');
    await db.insert(s.claims).values([
      { shopId: seeded.shop.id, proposalId: p1.id, revisionId: optionA.id, unitId: a7rv, period },
      { shopId: seeded.shop.id, proposalId: p1.id, revisionId: optionB.id, unitId: a7rv, period },
    ]);

    const p2 = await proposalFor(seeded, 'Charlie');
    const r2 = await revisionOf(seeded, p2.id, 1);
    const code = await pgCode(
      db.insert(s.claims).values({
        shopId: seeded.shop.id,
        proposalId: p2.id,
        revisionId: r2.id,
        unitId: a7rv,
        period: { start: plus(period.end, -1), end: plus(period.end, 10) },
      }),
    );
    expect(code).toBe(EXCLUSION_VIOLATION);
  });

  it('round-trips a claim period', async () => {
    const seeded = await seed();
    const p = await proposalFor(seeded);
    const r = await revisionOf(seeded, p.id, 1);
    const period = { start: seeded.now, end: plus(seeded.now, 20) };
    const [claim] = await db
      .insert(s.claims)
      .values({ shopId: seeded.shop.id, proposalId: p.id, revisionId: r.id, unitId: seeded.unit('A7IV-1').id, period })
      .returning();
    const [read] = await db.select().from(s.claims).where(eq(s.claims.id, claim!.id));
    expect(read!.period).toEqual(period);
  });
});

describe('uniqueness rules', () => {
  it('allows one active proposal per requester and booking', async () => {
    const seeded = await seed();
    const p1 = await proposalFor(seeded);
    expect(await pgCode(proposalFor(seeded))).toBe(UNIQUE_VIOLATION);
    await db.update(s.proposals).set({ state: 'REJECTED' }).where(eq(s.proposals.id, p1.id));
    await proposalFor(seeded);
  });

  it('keeps one owner approval per revision', async () => {
    const seeded = await seed();
    const p = await proposalFor(seeded);
    const r = await revisionOf(seeded, p.id, 1);
    const owner = { shopId: seeded.shop.id, revisionId: r.id, proposalId: p.id, role: 'owner' as const, requestedAt: seeded.now };
    await db.insert(s.approvals).values(owner);
    expect(await pgCode(db.insert(s.approvals).values(owner))).toBe(UNIQUE_VIOLATION);
  });

  it('keeps one fact per unit and key, and a fact on exactly one of unit or model', async () => {
    const seeded = await seed();
    const fact = {
      shopId: seeded.shop.id,
      unitId: seeded.unit('CRANE4-1').id,
      key: 'balances_r5_rf2470',
      value: 'yes' as const,
      source: 'owner' as const,
      setAt: seeded.now,
    };
    expect(await pgCode(db.insert(s.facts).values(fact))).toBe(UNIQUE_VIOLATION);
    expect(await pgCode(db.insert(s.facts).values({ ...fact, key: 'k', modelId: seeded.modelsByName.crane4.id }))).toBe(
      CHECK_VIOLATION,
    );
  });

  it('refuses to reuse a PayPal-Request-Id', async () => {
    const seeded = await seed();
    const [order] = await db
      .insert(s.paypalOrders)
      .values({
        shopId: seeded.shop.id,
        customerId: seeded.customer('Alice').id,
        paypalOrderId: randomUUID(),
        intent: 'AUTHORIZE',
        amountCents: 4500,
      })
      .returning();
    const op = {
      shopId: seeded.shop.id,
      kind: 'capture' as const,
      paypalOrderRef: order!.id,
      amountCents: 4500,
      requestId: `p:r:capture:${randomUUID()}`,
      createdAt: seeded.now,
    };
    await db.insert(s.paymentOps).values(op);
    expect(await pgCode(db.insert(s.paymentOps).values({ ...op, amountCents: 1500 }))).toBe(UNIQUE_VIOLATION);
  });
});

describe('revisions are immutable', () => {
  it('allows status changes but refuses changes to terms', async () => {
    const seeded = await seed();
    const p = await proposalFor(seeded);
    const r = await revisionOf(seeded, p.id, 1);
    await db.update(s.revisions).set({ status: 'offered', validatedAt: seeded.now }).where(eq(s.revisions.id, r.id));
    const code = await pgCode(db.update(s.revisions).set({ netRevenueCents: 999 }).where(eq(s.revisions.id, r.id)));
    expect(code).toBe(CHECK_VIOLATION);
  });

  it("refuses any change to a revision's plan", async () => {
    const seeded = await seed();
    const p = await proposalFor(seeded);
    const r = await revisionOf(seeded, p.id, 1);
    const [change] = await db
      .insert(s.revisionChanges)
      .values({
        shopId: seeded.shop.id,
        revisionId: r.id,
        action: 'create',
        newUnitId: seeded.unit('A7RV-1').id,
        newStartsAt: seeded.now,
        kind: 'new_booking',
        requiresApproval: false,
        partyCustomerId: seeded.customer('Alice').id,
      })
      .returning();
    const code = await pgCode(
      db.update(s.revisionChanges).set({ priceDeltaCents: 1 }).where(eq(s.revisionChanges.id, change!.id)),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });
});

describe('reset demo', () => {
  it("deletes every row of a shop, and only that shop's", async () => {
    const [seeded, other] = await Promise.all([seed(), seed()]);
    const p = await proposalFor(seeded);
    const r = await revisionOf(seeded, p.id, 1);
    await db.insert(s.claims).values({ shopId: seeded.shop.id, proposalId: p.id, revisionId: r.id, bookingId: seeded.bookingOf('Bob').id });
    await db.delete(s.shops).where(eq(s.shops.id, seeded.shop.id));

    expect(await db.select().from(s.bookings).where(eq(s.bookings.shopId, seeded.shop.id))).toHaveLength(0);
    expect(await db.select().from(s.bookings).where(eq(s.bookings.shopId, other.shop.id))).toHaveLength(7);
  });
});

describe('per-shop lock (invariant 5)', () => {
  it('serializes writes to the same shop', async () => {
    const seeded = await seed();
    const order: string[] = [];
    let firstHasLock!: () => void;
    const locked = new Promise<void>((resolve) => (firstHasLock = resolve));

    const first = withShopLock(db, seeded.shop.id, async () => {
      order.push('first start');
      firstHasLock();
      await new Promise((r) => setTimeout(r, 200));
      order.push('first end');
    });
    await locked;
    const second = withShopLock(db, seeded.shop.id, async () => {
      order.push('second');
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['first start', 'first end', 'second']);
  });
});
