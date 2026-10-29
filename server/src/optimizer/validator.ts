// The validator: (plan, current state, now) → violations. Pure.
// The optimizer checks every candidate with it, and the backend re-runs it at every proposal transition
// (docs/conflict-model.md §3a), so a plan that went stale while people decided never commits.

import { type Index, type Placement, type Snapshot, ACTIVE_STATUSES, cmp, indexSnapshot, occupancy, overlaps } from './snapshot.ts';
import { formatShopTime, isWithinShopHours } from './time.ts';

export type ChangeKind = 'new_booking' | 'extension' | 'time_shift' | 'same_model_swap' | 'model_change';

/** One booking's new placement. `bookingId` null = a booking the plan creates. */
export type ProposedChange = { bookingId: string | null; customerId: string; after: Placement };

export type PlanInput = {
  changes: ProposedChange[];
  /** The requester's own change needs no affected-party approval. */
  requesterCustomerId?: string | null;
  /** Owner manual edits may shorten a picked-up rental; the optimizer never does. */
  allowPickedUpShorten?: boolean;
};

export type Rule =
  | 'unknown_booking'
  | 'booking_not_active'
  | 'claimed_booking'
  | 'claimed_capacity'
  | 'bad_duration'
  | 'outside_shop_hours'
  | 'in_past'
  | 'picked_up_moved'
  | 'picked_up_shortened'
  | 'unit_inactive'
  | 'unit_model_mismatch'
  | 'unit_unavailable'
  | 'customer_excluded'
  | 'customer_constraint'
  | 'fact_no'
  | 'overlap'
  | 'shift_over_limit';

export type Violation = {
  rule: Rule;
  /** The changed booking the violation is about (null for a new booking). */
  bookingId: string | null;
  /** For `overlap`: the other booking, and whether the plan changes it too. */
  otherBookingId?: string;
  otherChanged?: boolean;
  /** Owner-facing, e.g. "overlaps Charlie's booking on A7IV-2". */
  message: string;
};

/** A fact a plan relies on that isn't `yes`. `factId` null = no row yet (reads as `unknown`). */
export type FactDependency = { factId: string | null; unitId: string; key: string };

export type Validation = {
  violations: Violation[];
  factDependencies: FactDependency[];
  /** Units in the plan with an open condition note (an owner trigger, not a violation). */
  conditionNoteUnitIds: string[];
};

type ConstraintValue = { at?: string; field?: 'start' | 'end'; modelId?: string };

const sameTime = (a: Date, b: Date) => a.getTime() === b.getTime();

export function deriveKind(before: Placement | null, after: Placement): ChangeKind {
  if (!before) return 'new_booking';
  if (after.modelId !== before.modelId) return 'model_change';
  const startSame = sameTime(after.startsAt, before.startsAt), endSame = sameTime(after.endsAt, before.endsAt);
  if (startSame && after.endsAt > before.endsAt) return 'extension';
  if (!startSame || !endSame) return 'time_shift';
  return 'same_model_swap';
}

/** Kinds that need the affected customer's approval; a same-model unit swap is notice only. */
export const needsApproval = (kind: ChangeKind) => kind !== 'same_model_swap';

export function validate(snapOrIndex: Snapshot | Index, plan: PlanInput): Validation {
  const idx = 'snap' in snapOrIndex ? snapOrIndex : indexSnapshot(snapOrIndex);
  const { snap } = idx;
  const hours = snap.shop;
  const violations: Violation[] = [];
  const factDependencies: FactDependency[] = [];
  const noteUnits = new Set<string>();
  const at = (t: Date) => formatShopTime(t, hours);

  for (const change of plan.changes) {
    const { bookingId, customerId, after: p } = change;
    const add = (rule: Rule, message: string) => violations.push({ rule, bookingId, message });
    const before = bookingId ? idx.bookings.get(bookingId) : undefined;
    if (bookingId && !before) {
      add('unknown_booking', 'booking not found');
      continue;
    }
    if (before && !ACTIVE_STATUSES.has(before.status)) add('booking_not_active', `booking is ${before.status}`);
    if (bookingId && idx.claimedBookingIds.has(bookingId)) add('claimed_booking', 'booking is held by another request');

    if (!(p.endsAt > p.startsAt)) add('bad_duration', 'return must be after pickup');
    if (p.bufferEndsAt < p.endsAt) add('bad_duration', 'buffer must end after the return');

    const startChanged = !before || !sameTime(p.startsAt, before.startsAt);
    const endChanged = !before || !sameTime(p.endsAt, before.endsAt);
    for (const [changed, t, what] of [[startChanged, p.startsAt, 'pickup'], [endChanged, p.endsAt, 'return']] as const) {
      if (!changed) continue;
      if (!isWithinShopHours(t, hours)) add('outside_shop_hours', `${what} ${at(t)} is outside shop hours`);
      if (t < snap.now) add('in_past', `${what} ${at(t)} is in the past`);
    }

    if (before?.status === 'picked_up') {
      if (p.unitId !== before.unitId) add('picked_up_moved', 'picked-up rentals never change unit');
      if (startChanged) add('picked_up_moved', 'a picked-up rental’s pickup has already happened');
      if (p.endsAt < before.endsAt && !plan.allowPickedUpShorten)
        add('picked_up_shortened', 'only the owner can shorten a picked-up rental');
    }

    if (p.unitId) {
      const unit = idx.units.get(p.unitId);
      if (!unit || !unit.active) add('unit_inactive', `${idx.unitLabel(p.unitId)} is not in service`);
      else if (unit.modelId !== p.modelId) add('unit_model_mismatch', `${unit.label} is a different model`);

      const unitChanged = !before || before.unitId !== p.unitId;
      const occupancyChanged = unitChanged || startChanged || !sameTime(p.bufferEndsAt, before!.bufferEndsAt);
      if (occupancyChanged) {
        for (const u of idx.unavailabilityOn(p.unitId))
          if (overlaps(occupancy(p), u.period)) add('unit_unavailable', `${idx.unitLabel(p.unitId)} is unavailable (${u.reason.replaceAll('_', ' ')})`);
        for (const c of idx.capacityClaimsOn(p.unitId))
          if (overlaps(occupancy(p), c.period!)) add('claimed_capacity', `${idx.unitLabel(p.unitId)} is held by another request then`);
      }
      if (unitChanged && before) {
        for (const key of before.requiredFacts) {
          const fact = idx.fact(p.unitId, key);
          if (fact?.value === 'no') add('fact_no', `${idx.unitLabel(p.unitId)}: ${key} is no`);
          else if (fact?.value !== 'yes') factDependencies.push({ factId: fact?.id ?? null, unitId: p.unitId, key });
        }
      }
      if (idx.openNotesOn(p.unitId).length) noteUnits.add(p.unitId);
    }

    const kind = deriveKind(before ?? null, p);
    const isRequester = customerId === plan.requesterCustomerId;
    if (!isRequester && needsApproval(kind) && idx.excluded.has(customerId))
      add('customer_excluded', `${idx.customerName(customerId)} declined changes to this booking`);

    for (const c of idx.constraintsOf(customerId)) {
      const v = c.value as ConstraintValue;
      const t = v.field === 'end' ? p.endsAt : p.startsAt;
      const what = v.field === 'end' ? 'return' : 'pickup';
      const broken =
        (c.kind === 'not_before' && !!v.at && t < new Date(v.at)) ||
        (c.kind === 'not_after' && !!v.at && t > new Date(v.at)) ||
        (c.kind === 'require_model' && p.modelId !== v.modelId) ||
        (c.kind === 'forbid_model' && p.modelId === v.modelId) ||
        (c.kind === 'keep_unit' && !!before && p.unitId !== before.unitId);
      if (broken) {
        const detail =
          c.kind === 'not_before' ? `${what} not before ${at(new Date(v.at!))}`
          : c.kind === 'not_after' ? `${what} not after ${at(new Date(v.at!))}`
          : c.kind === 'require_model' ? `needs the ${idx.models.get(v.modelId!)?.name ?? 'requested model'}`
          : c.kind === 'forbid_model' ? `doesn't want the ${idx.models.get(v.modelId!)?.name ?? 'model'}`
          : 'wants to keep the same unit';
        add('customer_constraint', `${idx.customerName(customerId)} said: ${detail}`);
      }
    }
  }

  violations.push(...overlapViolations(idx, plan.changes));
  return { violations, factDependencies, conditionNoteUnitIds: [...noteUnits].sort(cmp) };
}

/** Overlaps on every unit the plan touches, in the schedule as it would be after the plan. */
function overlapViolations(idx: Index, changes: ProposedChange[]): Violation[] {
  type Entry = { key: string; bookingId: string | null; customerId: string; p: Placement; changed: boolean };
  const changedIds = new Set(changes.map((c) => c.bookingId).filter((id): id is string => !!id));
  const entries: Entry[] = idx.activeBookings
    .filter((b) => !changedIds.has(b.id))
    .map((b) => ({ key: b.id, bookingId: b.id, customerId: b.customerId, p: b, changed: false }));
  changes.forEach((c, i) =>
    entries.push({ key: c.bookingId ?? `new:${i}`, bookingId: c.bookingId, customerId: c.customerId, p: c.after, changed: true }),
  );

  const touched = new Set<string>();
  for (const c of changes) {
    if (c.after.unitId) touched.add(c.after.unitId);
  }

  const out: Violation[] = [];
  for (const unitId of [...touched].sort(cmp)) {
    const onUnit = entries.filter((e) => e.p.unitId === unitId);
    for (let i = 0; i < onUnit.length; i++)
      for (let j = i + 1; j < onUnit.length; j++) {
        let a = onUnit[i]!, b = onUnit[j]!;
        if (!a.changed && !b.changed) continue;
        if (!overlaps(occupancy(a.p), occupancy(b.p))) continue;
        if (!a.changed) [a, b] = [b, a];
        out.push({
          rule: 'overlap',
          bookingId: a.bookingId,
          otherBookingId: b.bookingId ?? undefined,
          otherChanged: b.changed,
          message: `overlaps ${idx.customerName(b.customerId)}'s booking on ${idx.unitLabel(unitId)}`,
        });
      }
  }
  return out;
}
