// The optimizer against the demo script's scenarios, from the real seed data. Pure: no database.

import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { type DemoShop, demoShopData } from '../src/db/seed.ts';
import { type OptimizeResult, type Plan, optimize } from '../src/optimizer/optimizer.ts';
import type { Snapshot } from '../src/optimizer/snapshot.ts';
import { earliestOpenAtOrAfter, isWithinShopHours, latestOpenAtOrBefore } from '../src/optimizer/time.ts';
import { validate } from '../src/optimizer/validator.ts';

// A fixed real date keeps the tests independent of today. Wed 28 Oct 2026; DST ends Sun 1 Nov in Los Angeles.
const REAL_NOW = new Date('2026-10-28T20:00:00Z');
const H = 3600_000;
const plus = (d: Date, hours: number) => new Date(d.getTime() + hours * H);

function demo() {
  const d = demoShopData({ sessionKey: randomUUID(), realNow: REAL_NOW });
  return { d, snap: snapshotOf(d) };
}

function snapshotOf(d: DemoShop, extra: Partial<Snapshot> = {}): Snapshot {
  return {
    now: d.now,
    shop: { timezone: d.shop.timezone, opensAt: d.shop.opensAt, closesAt: d.shop.closesAt, policy: d.shop.policy },
    models: d.models,
    substitutes: d.substitutes,
    units: d.units,
    unavailability: d.unavailability,
    conditionNotes: d.conditionNotes,
    facts: d.facts,
    customers: d.customers,
    bookings: d.bookings,
    otherClaims: [],
    excludedCustomerIds: [],
    constraints: [],
    ...extra,
  };
}

/** Shop-local time in the demo week, e.g. at('Thu', 10). */
function at(d: DemoShop, day: 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun', hour: number) {
  const days = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[day];
  return DateTime.fromJSDate(d.now, { zone: d.shop.timezone }).startOf('week').plus({ days }).set({ hour }).toJSDate();
}

const plansOf = (r: OptimizeResult) => {
  if (r.status !== 'fits' && r.status !== 'needs_other_changes') throw new Error(`expected plans, got ${r.status}`);
  return r;
};

/** A plan's changes to other customers, as "Name: unit start → end". */
function describe_(d: DemoShop, plan: Plan) {
  return plan.changes
    .filter((c) => !c.isRequester)
    .map((c) => `${d.customers.find((x) => x.id === c.customerId)!.name}: ${d.units.find((u) => u.id === c.after.unitId)!.label} ${c.kind}`);
}

describe('Scenario 1: Vincent extends to Thu 10am', () => {
  const { d, snap } = demo();
  const result = plansOf(optimize(snap, { kind: 'extend', bookingId: d.bookingOf('Vincent').id, newEndsAt: at(d, 'Thu', 10) }));

  it('finds exactly Plan A (Bob to the A7R V) and Plan B (Bob at 2pm)', () => {
    expect(result.status).toBe('needs_other_changes');
    expect(result.plans.map((p) => describe_(d, p))).toEqual([
      ['Bob: A7IV-1 time_shift'], // Plan B: 5h of disruption
      ['Bob: A7RV-1 model_change'], // Plan A: model change, 6h penalty
    ]);
  });

  it('Plan B moves Bob to Thu 2pm, keeps his return, and needs the owner because it shortens him', () => {
    const planB = result.plans[0]!;
    const bob = planB.changes[1]!;
    expect(bob.after.startsAt).toEqual(at(d, 'Thu', 14));
    expect(bob.after.endsAt).toEqual(d.bookingOf('Bob').endsAt);
    expect(bob.hoursShifted).toBe(5);
    expect(bob.requiresApproval).toBe(true);
    expect(planB.ownerTriggers).toEqual(['booking_shortened']);
    expect(planB.needsOwner).toBe(true);
  });

  it('Plan A upgrades Bob: worth $40, no owner needed', () => {
    const planA = result.plans[1]!;
    const bob = planA.changes[1]!;
    expect(bob.priceDeltaCents).toBe(4000);
    expect(planA.needsOwner).toBe(false);
  });

  it('quotes Vincent +$45 for the extra day, with his buffer moving to Thu 2pm', () => {
    const vincent = result.plans[0]!.changes[0]!;
    expect(vincent.isRequester).toBe(true);
    expect(vincent.kind).toBe('extension');
    expect(vincent.priceDeltaCents).toBe(4500);
    expect(vincent.after.bufferEndsAt).toEqual(at(d, 'Thu', 14));
  });

  it('lists the alternatives from the demo script as pruned, with reasons', () => {
    const messages = result.pruned.map((p) => p.message);
    expect(messages).toContain('Move Vincent to A7IV-2, return to Thu 10:00am → picked-up rentals never change unit');
    expect(messages).toContain("Move Bob to A7IV-2 → overlaps Charlie's booking on A7IV-2");
    expect(messages).toContain('Move Bob to A7IV-3 → A7IV-3 is unavailable (maintenance)');
  });

  it('every plan passes the validator on its own', () => {
    for (const plan of result.plans) {
      const v = validate(snap, { changes: plan.changes, requesterCustomerId: d.customer('Vincent').id });
      expect(v.violations).toEqual([]);
    }
  });
});

describe('Scenario 2: Dana extends the RS3 to Fri 9am', () => {
  const { d, snap } = demo();
  const result = plansOf(optimize(snap, { kind: 'extend', bookingId: d.bookingOf('Dana').id, newEndsAt: at(d, 'Fri', 9) }));

  it('finds one plan: Eve to the Crane 4, needing the owner for the unknown fact and the downgrade', () => {
    expect(result.plans.map((p) => describe_(d, p))).toEqual([['Eve: CRANE4-1 model_change']]);
    const plan = result.plans[0]!;
    expect(plan.factDependencies).toEqual([{ factId: d.facts[0]!.id, unitId: d.unit('CRANE4-1').id, key: 'balances_r5_rf2470' }]);
    expect(plan.ownerTriggers).toContain('unknown_fact');
    expect(plan.envelopeTrips).toContain('downgrade');
    expect(plan.changes[1]!.priceDeltaCents).toBe(-1500); // the $15 price difference
  });

  it("prunes moving Eve's pickup a whole day", () => {
    expect(result.pruned.map((p) => p.message)).toContain("Move Eve's pickup to Fri 1:00pm → shifts 23h, over the 6h limit");
  });

  it('rules the Crane 4 out once the owner says it can’t balance the rig', () => {
    const facts = [{ ...d.facts[0]!, value: 'no' as const }];
    const r = optimize(snapshotOf(d, { facts }), { kind: 'extend', bookingId: d.bookingOf('Dana').id, newEndsAt: at(d, 'Fri', 9) });
    expect(r.status).toBe('infeasible');
  });

  it('needs no owner for the fact once it is yes', () => {
    const facts = [{ ...d.facts[0]!, value: 'yes' as const }];
    const r = plansOf(optimize(snapshotOf(d, { facts }), { kind: 'extend', bookingId: d.bookingOf('Dana').id, newEndsAt: at(d, 'Fri', 9) }));
    expect(r.plans[0]!.factDependencies).toEqual([]);
    expect(r.plans[0]!.ownerTriggers).not.toContain('unknown_fact');
  });
});

describe('Scenario 3: Bob refuses, then Charlie declines', () => {
  const { d } = demo();
  const request = { kind: 'extend' as const, bookingId: d.bookingOf('Vincent').id, newEndsAt: at(d, 'Thu', 10) };
  const proposalId = randomUUID();
  const bobConstraints = [
    { kind: 'not_after' as const, value: { at: at(d, 'Thu', 9).toISOString(), field: 'start' } },
    { kind: 'require_model' as const, value: { modelId: d.modelsByName.a7iv.id } },
  ].map((c) => ({ ...c, id: randomUUID(), shopId: d.shop.id, proposalId, customerId: d.customer('Bob').id, sourceMessageId: null, createdAt: d.now }));

  it('with Bob excluded, the next plan upgrades Charlie so Bob can swap to A7IV-2 (notice only)', () => {
    const snap = snapshotOf(d, { excludedCustomerIds: [d.customer('Bob').id], constraints: bobConstraints });
    const result = plansOf(optimize(snap, request));
    expect(result.plans.map((p) => describe_(d, p))).toEqual([['Bob: A7IV-2 same_model_swap', 'Charlie: A7RV-1 model_change']]);
    const plan = result.plans[0]!;
    expect(plan.changes.find((c) => c.customerId === d.customer('Bob').id)!.requiresApproval).toBe(false);
    expect(plan.rank.approvalsNeeded).toBe(1);
  });

  it("Bob's constraints alone rule out Plans A and B", () => {
    const snap = snapshotOf(d, { constraints: bobConstraints });
    const result = plansOf(optimize(snap, request));
    expect(result.plans.map((p) => describe_(d, p))).toEqual([['Bob: A7IV-2 same_model_swap', 'Charlie: A7RV-1 model_change']]);
  });

  it('with Charlie excluded too, offers Vincent the closest option: until 9pm tonight, same price', () => {
    const snap = snapshotOf(d, {
      excludedCustomerIds: [d.customer('Bob').id, d.customer('Charlie').id],
      constraints: bobConstraints,
    });
    const result = optimize(snap, request);
    expect(result.status).toBe('infeasible');
    if (result.status !== 'infeasible') return;
    const nearest = result.nearest!;
    expect(nearest.isAlternative).toBe(true);
    expect(nearest.changes).toHaveLength(1);
    expect(nearest.changes[0]!.after.endsAt).toEqual(at(d, 'Wed', 21));
    expect(nearest.changes[0]!.priceDeltaCents).toBe(0);
  });
});

describe('requests that need no one else to move', () => {
  const { d, snap } = demo();

  it('a free slot fits as is', () => {
    const r = plansOf(
      optimize(snap, { kind: 'new_booking', customerId: d.customer('Gina').id, modelId: d.modelsByName.a7rv.id, startsAt: at(d, 'Fri', 10), endsAt: at(d, 'Fri', 18) }),
    );
    expect(r.status).toBe('fits');
    expect(r.plans[0]!.changes).toHaveLength(1);
    expect(r.plans[0]!.changes[0]!.priceDeltaCents).toBe(6500);
  });

  it('an extension within the free time fits', () => {
    const r = plansOf(optimize(snap, { kind: 'extend', bookingId: d.bookingOf('Vincent').id, newEndsAt: at(d, 'Wed', 20) }));
    expect(r.status).toBe('fits');
  });
});

describe('invalid requests', () => {
  const { d, snap } = demo();
  const vincent = d.bookingOf('Vincent').id;

  it('refuses a return outside shop hours', () => {
    const r = optimize(snap, { kind: 'extend', bookingId: vincent, newEndsAt: at(d, 'Thu', 3) });
    expect(r.status).toBe('invalid_request');
    if (r.status === 'invalid_request') expect(r.violations.map((v) => v.rule)).toEqual(['outside_shop_hours']);
  });

  it('refuses a return in the past', () => {
    const r = optimize(snap, { kind: 'shift', bookingId: d.bookingOf('Bob').id, newStartsAt: at(d, 'Wed', 10) });
    expect(r.status).toBe('invalid_request');
  });

  it('refuses to shorten a picked-up rental', () => {
    const r = optimize(snap, { kind: 'shift', bookingId: vincent, newEndsAt: at(d, 'Wed', 15) });
    expect(r.status).toBe('invalid_request');
    if (r.status === 'invalid_request') expect(r.violations.map((v) => v.rule)).toContain('picked_up_shortened');
  });
});

describe('claims from other proposals', () => {
  it("won't move a booking another request holds", () => {
    const { d } = demo();
    const claim = {
      id: randomUUID(), shopId: d.shop.id, proposalId: randomUUID(), revisionId: randomUUID(),
      bookingId: d.bookingOf('Bob').id, unitId: null, period: null, releasedAt: null,
    };
    const r = optimize(snapshotOf(d, { otherClaims: [claim] }), { kind: 'extend', bookingId: d.bookingOf('Vincent').id, newEndsAt: at(d, 'Thu', 10) });
    expect(r.status).toBe('infeasible');
  });

  it('plans around capacity another request holds', () => {
    const { d } = demo();
    const claim = {
      id: randomUUID(), shopId: d.shop.id, proposalId: randomUUID(), revisionId: randomUUID(),
      bookingId: null, unitId: d.unit('A7RV-1').id, period: { start: at(d, 'Thu', 9), end: at(d, 'Sat', 9) }, releasedAt: null,
    };
    const r = plansOf(optimize(snapshotOf(d, { otherClaims: [claim] }), { kind: 'extend', bookingId: d.bookingOf('Vincent').id, newEndsAt: at(d, 'Thu', 10) }));
    expect(r.plans.map((p) => describe_(d, p))).toEqual([['Bob: A7IV-1 time_shift']]);
  });
});

describe('determinism', () => {
  it('gives the same result for shuffled input', () => {
    const { d, snap } = demo();
    const request = { kind: 'extend' as const, bookingId: d.bookingOf('Vincent').id, newEndsAt: at(d, 'Thu', 10) };
    const shuffled: Snapshot = {
      ...snap,
      units: [...snap.units].reverse(),
      bookings: [...snap.bookings].reverse(),
      models: [...snap.models].reverse(),
      substitutes: [...snap.substitutes].reverse(),
    };
    expect(optimize(shuffled, request)).toEqual(optimize(snap, request));
  });
});

describe('shop hours', () => {
  const { d } = demo();
  const hours = d.shop;

  it('includes opening and closing time', () => {
    expect(isWithinShopHours(at(d, 'Wed', 9), hours)).toBe(true);
    expect(isWithinShopHours(at(d, 'Wed', 21), hours)).toBe(true);
    expect(isWithinShopHours(plus(at(d, 'Wed', 21), 0.25), hours)).toBe(false);
  });

  it('rolls to the next opening or previous closing', () => {
    expect(earliestOpenAtOrAfter(at(d, 'Wed', 22), hours)).toEqual(at(d, 'Thu', 9));
    expect(earliestOpenAtOrAfter(at(d, 'Thu', 3), hours)).toEqual(at(d, 'Thu', 9));
    expect(latestOpenAtOrBefore(at(d, 'Thu', 5), hours)).toEqual(at(d, 'Wed', 21));
    expect(earliestOpenAtOrAfter(plus(at(d, 'Thu', 10), 0.1), hours)).toEqual(plus(at(d, 'Thu', 10), 0.25));
  });

  it('keeps 9am across the DST change (Sun 1 Nov)', () => {
    const sat22 = at(d, 'Sat', 22);
    const next = earliestOpenAtOrAfter(sat22, hours);
    expect(DateTime.fromJSDate(next, { zone: hours.timezone }).toFormat('ccc HH:mm')).toBe('Sun 09:00');
  });
});

describe('random requests (property test)', () => {
  // Small seeded PRNG (mulberry32) so a failure reproduces.
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it('never throws, every plan passes the validator, and results are deterministic', () => {
    const { d, snap } = demo();
    const rand = rng(42);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
    // Quarter-hours from Wed 9am to Sun 9pm, inside and outside shop hours.
    const randomTime = () => plus(at(d, 'Wed', 9), Math.floor(rand() * 4 * 24 * 4) / 4);
    let withPlans = 0;

    for (let i = 0; i < 400; i++) {
      const b = pick(d.bookings);
      const kind = pick(['extend', 'shift', 'new_booking'] as const);
      const request =
        kind === 'extend' ? { kind, bookingId: b.id, newEndsAt: randomTime() }
        : kind === 'shift' ? { kind, bookingId: b.id, newStartsAt: randomTime(), newEndsAt: randomTime() }
        : (() => {
            const startsAt = randomTime();
            return { kind, customerId: pick(d.customers).id, modelId: pick(d.models).id, startsAt, endsAt: plus(startsAt, 1 + Math.floor(rand() * 48)) };
          })();

      const result = optimize(snap, request);
      expect(optimize(snap, request)).toEqual(result);
      const plans = result.status === 'fits' || result.status === 'needs_other_changes' ? result.plans
        : result.status === 'infeasible' && result.nearest ? [result.nearest] : [];
      if (plans.length) withPlans++;
      for (const plan of plans) {
        const requesterCustomerId = plan.changes[0]!.customerId;
        expect(validate(snap, { changes: plan.changes, requesterCustomerId }).violations).toEqual([]);
        for (const c of plan.changes) {
          if (c.isRequester) continue;
          expect(c.hoursShifted).toBeLessThanOrEqual(d.shop.policy.max_shift_hours);
          // Picked-up rentals are never moved for someone else.
          expect(d.bookings.find((x) => x.id === c.bookingId)!.status).toBe('confirmed');
        }
      }
    }
    expect(withPlans).toBeGreaterThan(20); // the generator does reach feasible requests
  });
});
