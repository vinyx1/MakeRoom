// Quotes for the demo script's plans: every amount on screen comes from here. Pure: no database.

import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { type DemoShop, demoShopData } from '../src/db/seed.ts';
import { type OptimizeResult, type Plan, optimize } from '../src/optimizer/optimizer.ts';
import { type Snapshot, indexSnapshot } from '../src/optimizer/snapshot.ts';
import { quotePlan } from '../src/quote/quote.ts';

const REAL_NOW = new Date('2026-10-28T20:00:00Z');

function demo(policy: Partial<Snapshot['shop']['policy']> = {}) {
  const d = demoShopData({ sessionKey: randomUUID(), realNow: REAL_NOW });
  const snap: Snapshot = {
    now: d.now,
    shop: { timezone: d.shop.timezone, opensAt: d.shop.opensAt, closesAt: d.shop.closesAt, policy: { ...d.shop.policy, ...policy } },
    models: d.models, substitutes: d.substitutes, units: d.units, unavailability: d.unavailability,
    conditionNotes: d.conditionNotes, facts: d.facts, customers: d.customers, bookings: d.bookings,
    otherClaims: [], excludedCustomerIds: [], constraints: [],
  };
  return { d, snap };
}

function at(d: DemoShop, day: 'Thu' | 'Fri', hour: number) {
  const days = { Thu: 3, Fri: 4 }[day];
  return DateTime.fromJSDate(d.now, { zone: d.shop.timezone }).startOf('day').minus({ days: 2 }).plus({ days }).set({ hour }).toJSDate();
}

const plans = (r: OptimizeResult): Plan[] => (r.status === 'fits' || r.status === 'needs_other_changes' ? r.plans : []);

function scenario1(policy = {}) {
  const { d, snap } = demo(policy);
  const result = plans(optimize(snap, { kind: 'extend', bookingId: d.bookingOf('Vincent').id, newEndsAt: at(d, 'Thu', 10) }));
  const planB = result.find((p) => p.changes[1]?.kind === 'time_shift')!;
  const planA = result.find((p) => p.changes[1]?.kind === 'model_change')!;
  return { d, snap, planA, planB };
}

describe('Scenario 1 quotes', () => {
  it('Vincent pays $45 for the extra day', () => {
    const { d, planA, planB } = scenario1();
    for (const plan of [planA, planB]) {
      expect(plan.quote.lines).toEqual([{ customerId: d.customer('Vincent').id, label: 'Extension to Thu 10:00am', amountCents: 4500 }]);
      expect(plan.quote.chargeCents).toBe(4500);
    }
  });

  it('Plan B: Bob gets $15 back for moving 5h; net +$30; the owner is needed only because Bob is shortened', () => {
    const { d, planB } = scenario1();
    expect(planB.quote.compensation).toEqual([
      { customerId: d.customer('Bob').id, bookingId: d.bookingOf('Bob').id, cents: 1500, kind: 'refund', reason: 'goodwill for moving 5h' },
    ]);
    expect(planB.quote.netRevenueCents).toBe(3000);
    expect(planB.ownerTriggers).toEqual(['booking_shortened']);
    expect(planB.envelopeTrips).toEqual([]);
  });

  it('Plan A: a free upgrade worth $40, no cash; net +$5; no owner needed', () => {
    const { d, planA } = scenario1();
    expect(planA.quote.compensation).toEqual([
      { customerId: d.customer('Bob').id, bookingId: d.bookingOf('Bob').id, cents: 4000, kind: 'upgrade_value', reason: 'free upgrade to the Sony A7R V' },
    ]);
    expect(planA.quote.netRevenueCents).toBe(500);
    expect(planA.needsOwner).toBe(false);
  });

  it('ranking is unchanged by the quotes: Plan B (5h) before Plan A (6h model-change penalty)', () => {
    const { d, snap } = scenario1();
    const result = plans(optimize(snap, { kind: 'extend', bookingId: d.bookingOf('Vincent').id, newEndsAt: at(d, 'Thu', 10) }));
    expect(result.map((p) => p.changes[1]!.kind)).toEqual(['time_shift', 'model_change']);
  });
});

describe('Scenario 2 quote', () => {
  it('Eve gets $20 (the $15 price difference plus $5 goodwill); Dana pays $25; net +$5', () => {
    const { d, snap } = demo();
    const [plan] = plans(optimize(snap, { kind: 'extend', bookingId: d.bookingOf('Dana').id, newEndsAt: at(d, 'Fri', 9) }));
    expect(plan!.quote.chargeCents).toBe(2500);
    expect(plan!.quote.compensation.map((c) => [c.cents, c.reason])).toEqual([
      [1500, 'price difference'],
      [500, 'goodwill for the downgrade'],
    ]);
    expect(plan!.quote.netRevenueCents).toBe(500);
  });
});

describe('money checks', () => {
  it('judge A1 "make it free": 10% is within the band ($40.50); more needs the owner', () => {
    const { snap, planA } = scenario1();
    const idx = indexSnapshot(snap);
    const tenPct = quotePlan(idx, planA.changes, { requesterDiscountPct: 10 });
    expect(tenPct.quote.discountCents).toBe(450);
    expect(tenPct.quote.chargeCents).toBe(4050);
    expect(tenPct.ownerTriggers).not.toContain('discount_over_band');

    const free = quotePlan(idx, planA.changes, { requesterDiscountPct: 100 });
    expect(free.quote.chargeCents).toBe(0);
    expect(free.ownerTriggers).toEqual(expect.arrayContaining(['discount_over_band', 'negative_net']));
    expect(free.envelopeTrips).toContain('compensation_over_revenue');
  });

  it('compensation over the per-customer cap needs the owner', () => {
    const { planA } = scenario1({ compensation_cap_cents: 3000 });
    expect(planA.ownerTriggers).toContain('over_cap');
    expect(planA.needsOwner).toBe(true);
  });

  it('a cash refund above what the customer paid needs the owner', () => {
    const { planB } = scenario1({ shift_compensation_cents_per_hour: 2000 }); // 5h × $20 = $100 > Bob's $90
    expect(planB.ownerTriggers).toContain('refund_over_paid');
  });

  it('a plan with no paying requester and compensation is net negative (Scenario 4 shape)', () => {
    const { snap, planA } = scenario1();
    const bobOnly = planA.changes.filter((c) => !c.isRequester);
    const result = quotePlan(indexSnapshot(snap), bobOnly);
    expect(result.quote.netRevenueCents).toBe(-4000);
    expect(result.ownerTriggers).toContain('negative_net');
    expect(result.envelopeTrips).toContain('compensation_over_revenue');
  });

  it('a same-model swap costs nothing', () => {
    const { d, snap } = demo();
    const r = plans(
      optimize(
        { ...snap, excludedCustomerIds: [d.customer('Bob').id] },
        { kind: 'extend', bookingId: d.bookingOf('Vincent').id, newEndsAt: at(d, 'Thu', 10) },
      ),
    );
    const plan = r[0]!; // Bob swaps to A7IV-2 (notice), Charlie upgrades
    const bob = plan.quote.compensation.filter((c) => c.customerId === d.customer('Bob').id);
    expect(bob).toEqual([]);
    expect(plan.quote.compensation.map((c) => [c.cents, c.kind])).toEqual([[4000, 'upgrade_value']]);
  });
});
