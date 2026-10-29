// Owner triggers and the plausibility envelope (CLAUDE.md "Agent autonomy", docs/conflict-model.md §2).
// Covers the booking-state, fact and condition checks. The money checks live with the quote (src/quote/quote.ts).

import type { PlanChange } from './optimizer.ts';
import type { Index } from './snapshot.ts';
import type { FactDependency } from './validator.ts';

export type OwnerTrigger = 'booking_shortened' | 'many_bookings_changed' | 'unknown_fact' | 'open_condition_note' | 'flagged_customer';
export type EnvelopeTrip = 'shift_over_limit' | 'downgrade' | 'too_many_bookings' | 'rate_out_of_bounds';

const durationMs = (p: { startsAt: Date; endsAt: Date }) => p.endsAt.getTime() - p.startsAt.getTime();

export function assess(
  idx: Index,
  changes: PlanChange[],
  factDependencies: FactDependency[],
  conditionNoteUnitIds: string[],
): { ownerTriggers: OwnerTrigger[]; envelopeTrips: EnvelopeTrip[] } {
  const { policy } = idx;
  const others = changes.filter((c) => !c.isRequester);
  const triggers = new Set<OwnerTrigger>();
  const trips = new Set<EnvelopeTrip>();

  if (others.some((c) => c.before && durationMs(c.after) < durationMs(c.before))) triggers.add('booking_shortened');
  // "A plan changes 3+ bookings", counting other customers' bookings: Scenario 4 (three, no requester) escalates,
  // Scenario 3's Plan C (Bob and Charlie) doesn't.
  if (others.length >= policy.max_bookings_touched) triggers.add('many_bookings_changed');
  if (factDependencies.length) triggers.add('unknown_fact');
  if (conditionNoteUnitIds.length) triggers.add('open_condition_note');
  if (changes.some((c) => idx.customers.get(c.customerId)?.flagged)) triggers.add('flagged_customer');

  if (others.some((c) => c.hoursShifted > policy.max_shift_hours)) trips.add('shift_over_limit');
  for (const c of changes) {
    if (c.kind !== 'model_change' || !c.before) continue;
    const from = idx.models.get(c.before.modelId), to = idx.models.get(c.after.modelId);
    if (from && to && to.tier < from.tier) trips.add('downgrade');
  }
  if (changes.length > policy.max_bookings_touched) trips.add('too_many_bookings');
  for (const c of changes) {
    const m = idx.models.get(c.after.modelId);
    if (m && (m.dailyRateCents < m.rateMinCents || m.dailyRateCents > m.rateMaxCents)) trips.add('rate_out_of_bounds');
  }

  return { ownerTriggers: [...triggers], envelopeTrips: [...trips] };
}
