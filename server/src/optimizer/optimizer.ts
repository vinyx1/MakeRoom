// The optimizer: (snapshot, request) → ranked plans plus every pruned alternative with its reason. Pure and
// deterministic (invariant 2). See docs/conflict-model.md §2.
//
// Search: place the requester's change, then move each booking it now overlaps, one move per booking, and
// recurse on whatever those moves overlap. Iterative deepening on the number of other bookings moved, so the
// first depth with any plan wins: that is ranking rule 1 (fewest bookings changed), and it keeps the pruned
// list to the alternatives that matter at that depth ("Move Bob to A7IV-2 → overlaps Charlie").
//
// Not yet: placing unassigned bookings (Scenario 4), compensation-based ranking (rules 4–5 need the quote module),
// and a nearest alternative for requests other than extensions.

import { rentalPriceCents } from '../pricing.ts';
import { type EnvelopeTrip, type OwnerTrigger, assess } from './envelope.ts';
import { type Booking, type Index, type Placement, type Snapshot, cmp, indexSnapshot, occupancy, overlaps, placementOf } from './snapshot.ts';
import { HOUR_MS, earliestOpenAtOrAfter, formatShopTime, latestOpenAtOrBefore } from './time.ts';
import {
  type ChangeKind,
  type FactDependency,
  type ProposedChange,
  type Rule,
  type Violation,
  deriveKind,
  needsApproval,
  validate,
} from './validator.ts';

export type Request =
  | { kind: 'extend'; bookingId: string; newEndsAt: Date }
  | { kind: 'shift'; bookingId: string; newStartsAt?: Date; newEndsAt?: Date }
  | { kind: 'new_booking'; customerId: string; modelId: string; startsAt: Date; endsAt: Date };

export type PlanChange = {
  bookingId: string | null;
  customerId: string;
  isRequester: boolean;
  kind: ChangeKind;
  before: Placement | null;
  after: Placement;
  /** Affected-party approval; false for same-model swaps (notice only) and for the requester's own change. */
  requiresApproval: boolean;
  /** max(|Δpickup|, |Δreturn|) in hours. */
  hoursShifted: number;
  /** Rate-card price of the new placement minus what the booking cost. For a model change this is the upgrade's
   * value (shop gives it up) or the downgrade's refund; the quote module turns it into charges and compensation. */
  priceDeltaCents: number;
};

export type Plan = {
  /** Stable identity: the same plan always gets the same key. */
  key: string;
  /** The requester's change first, then the others in the order they were moved. */
  changes: PlanChange[];
  rank: { bookingsChanged: number; disruptionHours: number; approvalsNeeded: number };
  ownerTriggers: OwnerTrigger[];
  envelopeTrips: EnvelopeTrip[];
  needsOwner: boolean;
  factDependencies: FactDependency[];
  /** Gives the requester something other than they asked for (labelled on the card). */
  isAlternative: boolean;
};

export type Pruned = {
  bookingId: string | null;
  customerId: string;
  after: Placement;
  rules: Rule[];
  /** Owner-facing, for the activity feed: "Move Bob to A7IV-3 → A7IV-3 is unavailable (maintenance)". */
  message: string;
};

export type OptimizeResult =
  | { status: 'invalid_request'; violations: Violation[] }
  | { status: 'fits' | 'needs_other_changes'; plans: Plan[]; pruned: Pruned[] }
  | { status: 'infeasible'; nearest: Plan | null; pruned: Pruned[] };

/** Rules about the request itself; if the requester's own change breaks one, no rearrangement can help. */
const REQUEST_RULES: ReadonlySet<Rule> = new Set(['bad_duration', 'outside_shop_hours', 'in_past', 'picked_up_moved', 'picked_up_shortened', 'unknown_booking', 'booking_not_active']);

/** Other bookings a plan may move. The envelope still flags plans over `policy.max_bookings_touched`. */
const MAX_MOVED = 3;

type Requester = { bookingId: string | null; customerId: string; placements: Placement[] };

export function optimize(snapshot: Snapshot, request: Request): OptimizeResult {
  const idx = indexSnapshot(snapshot);
  const requester = requesterPlacements(idx, request);
  if (!requester.placements.length)
    return { status: 'invalid_request', violations: [{ rule: 'unit_inactive', bookingId: requester.bookingId, message: 'no unit of that model is in service' }] };

  const primary: ProposedChange = { bookingId: requester.bookingId, customerId: requester.customerId, after: requester.placements[0]! };
  const own = validate(idx, { changes: [primary], requesterCustomerId: requester.customerId }).violations.filter((v) =>
    REQUEST_RULES.has(v.rule) || (v.rule === 'customer_constraint' && v.bookingId === requester.bookingId),
  );
  if (own.length) return { status: 'invalid_request', violations: own };

  let search = runSearch(idx, requester, 0);
  for (let budget = 1; !search.plans.length && budget <= MAX_MOVED; budget++) search = runSearch(idx, requester, budget);

  if (search.plans.length) {
    const fits = search.plans[0]!.changes.length === 1;
    return { status: fits ? 'fits' : 'needs_other_changes', plans: search.plans, pruned: search.pruned };
  }
  return { status: 'infeasible', nearest: nearestExtension(idx, request), pruned: search.pruned };
}

function requesterPlacements(idx: Index, request: Request): Requester {
  if (request.kind === 'new_booking') {
    const bufferMs = idx.policy.default_buffer_minutes * 60_000;
    return {
      bookingId: null,
      customerId: request.customerId,
      placements: idx.unitsOfModel(request.modelId).map((u) => ({
        unitId: u.id,
        modelId: request.modelId,
        startsAt: request.startsAt,
        endsAt: request.endsAt,
        bufferEndsAt: new Date(request.endsAt.getTime() + bufferMs),
      })),
    };
  }
  const b = idx.bookings.get(request.bookingId);
  if (!b) return { bookingId: request.bookingId, customerId: '', placements: [] };
  const startsAt = request.kind === 'shift' ? (request.newStartsAt ?? b.startsAt) : b.startsAt;
  const endsAt = request.kind === 'shift' ? (request.newEndsAt ?? b.endsAt) : request.newEndsAt;
  const times = { startsAt, endsAt, bufferEndsAt: new Date(endsAt.getTime() + bufferOf(b)) };
  // Its own unit first, then the other units of the same model. A picked-up rental's other units are tried
  // anyway and pruned, so the feed shows "Move Alice to another unit → picked-up rentals never change unit".
  const units = [
    ...(b.unitId ? [b.unitId] : []),
    ...idx.unitsOfModel(b.modelId).map((u) => u.id).filter((id) => id !== b.unitId),
  ];
  return { bookingId: b.id, customerId: b.customerId, placements: units.map((unitId) => ({ unitId, modelId: b.modelId, ...times })) };
}

const bufferOf = (b: Booking) => b.bufferEndsAt.getTime() - b.endsAt.getTime();

function runSearch(idx: Index, requester: Requester, budget: number) {
  const plans = new Map<string, Plan>();
  const pruned = new Map<string, Pruned>();

  const prune = (change: ProposedChange, violations: Pick<Violation, 'rule' | 'message'>[]) => {
    const key = changeKey(change);
    if (pruned.has(key)) return;
    const messages = [...new Set(violations.map((v) => v.message))];
    pruned.set(key, {
      bookingId: change.bookingId,
      customerId: change.customerId,
      after: change.after,
      rules: [...new Set(violations.map((v) => v.rule))],
      message: `${describeMove(idx, change)} → ${messages.join('; ')}`,
    });
  };

  const explore = (changes: ProposedChange[]) => {
    const last = changes.at(-1)!;
    const v = validate(idx, { changes, requesterCustomerId: requester.customerId });
    const hard = v.violations.filter((x) => x.rule !== 'overlap' || x.otherChanged || !x.otherBookingId);
    if (hard.length) return prune(last, hard);

    const conflictIds = [...new Set(v.violations.map((x) => x.otherBookingId!))]
      .map((id) => idx.bookings.get(id)!)
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || cmp(a.id, b.id));
    if (!conflictIds.length) return addPlan(idx, plans, changes, requester.customerId, v);

    const moved = changes.length - 1;
    if (moved + conflictIds.length > budget) return prune(last, v.violations);

    const next = conflictIds[0]!;
    for (const move of movesFor(idx, next, changes, prune)) explore([...changes, move]);
  };

  for (const after of requester.placements) explore([{ bookingId: requester.bookingId, customerId: requester.customerId, after }]);

  const ranked = [...plans.values()].sort(comparePlans);
  const prunedList = [...pruned.values()].sort((a, b) => cmp(a.message, b.message));
  return { plans: ranked, pruned: prunedList };
}

/** Candidate moves for a booking the plan overlaps, in a fixed order: same-model units, substitute models, time shifts. */
function movesFor(
  idx: Index,
  b: Booking,
  changes: ProposedChange[],
  prune: (c: ProposedChange, v: Pick<Violation, 'rule' | 'message'>[]) => void,
): ProposedChange[] {
  const base = placementOf(b);
  const move = (after: Placement): ProposedChange => ({ bookingId: b.id, customerId: b.customerId, after });
  if (b.status === 'picked_up') {
    prune(move(base), [{ rule: 'picked_up_moved', message: 'a picked-up rental can’t be moved' }]);
    return [];
  }

  const candidates: Placement[] = [];
  for (const u of idx.unitsOfModel(b.modelId)) if (u.id !== b.unitId) candidates.push({ ...base, unitId: u.id });
  for (const m of idx.substitutesOf(b.modelId))
    for (const u of idx.unitsOfModel(m.id)) candidates.push({ ...base, unitId: u.id, modelId: m.id });

  // Time shifts on its own unit, clear of the changed bookings it overlaps there.
  const blockers = changes.filter((c) => c.after.unitId === b.unitId && overlaps(occupancy(c.after), occupancy(base)));
  if (blockers.length) {
    const buffer = bufferOf(b);
    const freeFrom = new Date(Math.max(...blockers.map((c) => c.after.bufferEndsAt.getTime())));
    const freeUntil = new Date(Math.min(...blockers.map((c) => c.after.startsAt.getTime())));
    const later = earliestOpenAtOrAfter(freeFrom, idx.snap.shop);
    const earlier = latestOpenAtOrBefore(new Date(freeUntil.getTime() - buffer), idx.snap.shop);
    const shiftBy = (ms: number) => ({
      startsAt: new Date(b.startsAt.getTime() + ms),
      endsAt: new Date(b.endsAt.getTime() + ms),
      bufferEndsAt: new Date(b.bufferEndsAt.getTime() + ms),
    });
    const timeMoves: Placement[] = [
      { ...base, startsAt: later }, // later pickup, same return (shortened)
      { ...base, ...shiftBy(later.getTime() - b.startsAt.getTime()) }, // whole booking later
      { ...base, endsAt: earlier, bufferEndsAt: new Date(earlier.getTime() + buffer) }, // earlier return (shortened)
      { ...base, ...shiftBy(earlier.getTime() - b.endsAt.getTime()) }, // whole booking earlier
    ];
    for (const p of timeMoves) {
      if (p.endsAt <= p.startsAt) continue;
      const hours = hoursShifted(base, p);
      if (hours === 0) continue;
      if (hours > idx.policy.max_shift_hours) {
        prune(move(p), [{ rule: 'shift_over_limit', message: `shifts ${fmtHours(hours)}, over the ${idx.policy.max_shift_hours}h limit` }]);
        continue;
      }
      candidates.push(p);
    }
  }

  const seen = new Set<string>();
  return candidates
    .map(move)
    .filter((c) => {
      const k = changeKey(c);
      return !seen.has(k) && (seen.add(k), true);
    });
}

function addPlan(
  idx: Index,
  plans: Map<string, Plan>,
  changes: ProposedChange[],
  requesterCustomerId: string,
  v: { factDependencies: FactDependency[]; conditionNoteUnitIds: string[] },
  isAlternative = false,
) {
  const planChanges: PlanChange[] = changes.map((c, i) => {
    const booking = c.bookingId ? idx.bookings.get(c.bookingId)! : null;
    const before = booking ? placementOf(booking) : null;
    const kind = deriveKind(before, c.after);
    const isRequester = i === 0 && c.customerId === requesterCustomerId;
    const rate = idx.models.get(c.after.modelId)!.dailyRateCents;
    return {
      bookingId: c.bookingId,
      customerId: c.customerId,
      isRequester,
      kind,
      before,
      after: c.after,
      requiresApproval: !isRequester && needsApproval(kind),
      hoursShifted: before ? hoursShifted(before, c.after) : 0,
      priceDeltaCents: rentalPriceCents(rate, c.after.startsAt, c.after.endsAt) - (booking?.priceCents ?? 0),
    };
  });
  const key = planKey(changes);
  if (plans.has(key)) return;

  const others = planChanges.filter((c) => !c.isRequester);
  const { ownerTriggers, envelopeTrips } = assess(idx, planChanges, v.factDependencies, v.conditionNoteUnitIds);
  plans.set(key, {
    key,
    changes: planChanges,
    rank: {
      bookingsChanged: others.length,
      disruptionHours:
        others.reduce((sum, c) => sum + c.hoursShifted, 0) +
        others.filter((c) => c.kind === 'model_change').length * idx.policy.model_change_penalty_hours,
      approvalsNeeded: new Set(others.filter((c) => c.requiresApproval).map((c) => c.customerId)).size,
    },
    ownerTriggers,
    envelopeTrips,
    needsOwner: ownerTriggers.length > 0 || envelopeTrips.length > 0,
    factDependencies: v.factDependencies,
    isAlternative,
  });
}

/** Ranking rules 1–3 of docs/conflict-model.md §2, then the plan key so ties break the same way every time. */
const comparePlans = (a: Plan, b: Plan) =>
  a.rank.bookingsChanged - b.rank.bookingsChanged ||
  a.rank.disruptionHours - b.rank.disruptionHours ||
  a.rank.approvalsNeeded - b.rank.approvalsNeeded ||
  cmp(a.key, b.key);

/**
 * When an extension can't be done, the latest return before it that needs no one else to move ("I can't do
 * Thursday, but you can keep it until 9pm tonight"). Same unit, same pickup.
 */
function nearestExtension(idx: Index, request: Request): Plan | null {
  if (request.kind !== 'extend') return null;
  const b = idx.bookings.get(request.bookingId);
  if (!b?.unitId) return null;
  const blockStarts = [
    ...idx.activeBookings.filter((o) => o.id !== b.id && o.unitId === b.unitId && o.startsAt >= b.endsAt).map((o) => o.startsAt),
    ...idx.unavailabilityOn(b.unitId).filter((u) => u.period.end > b.endsAt).map((u) => u.period.start),
    ...idx.capacityClaimsOn(b.unitId).filter((c) => c.period!.end > b.endsAt).map((c) => c.period!.start),
  ].map((t) => t.getTime());
  let endsAt = request.newEndsAt;
  if (blockStarts.length) {
    const latest = latestOpenAtOrBefore(new Date(Math.min(...blockStarts) - bufferOf(b)), idx.snap.shop);
    if (latest < endsAt) endsAt = latest;
  }
  if (endsAt <= b.endsAt) return null;

  const change: ProposedChange = {
    bookingId: b.id,
    customerId: b.customerId,
    after: { ...placementOf(b), endsAt, bufferEndsAt: new Date(endsAt.getTime() + bufferOf(b)) },
  };
  const v = validate(idx, { changes: [change], requesterCustomerId: b.customerId });
  if (v.violations.length) return null;
  const plans = new Map<string, Plan>();
  addPlan(idx, plans, [change], b.customerId, v, true);
  return [...plans.values()][0]!;
}

const hoursShifted = (before: Placement, after: Placement) =>
  Math.max(
    Math.abs(after.startsAt.getTime() - before.startsAt.getTime()),
    Math.abs(after.endsAt.getTime() - before.endsAt.getTime()),
  ) / HOUR_MS;

const fmtHours = (h: number) => `${Number.isInteger(h) ? h : h.toFixed(1)}h`;

const changeKey = (c: ProposedChange) =>
  [c.bookingId ?? 'new', c.after.unitId, c.after.modelId, c.after.startsAt.toISOString(), c.after.endsAt.toISOString()].join('|');

const planKey = (changes: ProposedChange[]) => changes.map(changeKey).sort(cmp).join(';');

/** "Move Bob to A7IV-2", "Move Bob's pickup to Thu 2:00pm", "Extend Alice to Thu 10:00am". */
function describeMove(idx: Index, c: ProposedChange): string {
  const name = idx.customerName(c.customerId);
  const before = c.bookingId ? idx.bookings.get(c.bookingId) : undefined;
  const t = (d: Date) => formatShopTime(d, idx.snap.shop);
  const unit = idx.unitLabel(c.after.unitId);
  if (!before) return `New booking for ${name} on ${unit}`;
  const parts: string[] = [];
  if (c.after.unitId !== before.unitId) parts.push(`to ${unit}`);
  const startMoved = c.after.startsAt.getTime() !== before.startsAt.getTime();
  const endMoved = c.after.endsAt.getTime() !== before.endsAt.getTime();
  if (startMoved && endMoved) parts.push(`to ${t(c.after.startsAt)} → ${t(c.after.endsAt)}`);
  else if (startMoved) parts.push(`pickup to ${t(c.after.startsAt)}`);
  else if (endMoved) parts.push(`return to ${t(c.after.endsAt)}`);
  if (!parts.length) return `Keep ${name} as is`;
  return parts[0]!.startsWith('to ') ? `Move ${name} ${parts.join(', ')}` : `Move ${name}'s ${parts.join(', ')}`;
}
