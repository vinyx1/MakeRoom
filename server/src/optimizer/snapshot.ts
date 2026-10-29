// The optimizer's only input: a plain-data snapshot of one shop, built by the backend from the database.
// Nothing in src/optimizer does I/O (invariant 2). Types are the database row types, imported as types only.

import type { Policy } from '../db/policy.ts';
import type * as s from '../db/schema.ts';

export type Booking = typeof s.bookings.$inferSelect;
export type Unit = typeof s.units.$inferSelect;
export type EquipmentModel = typeof s.equipmentModels.$inferSelect;
export type Customer = typeof s.customers.$inferSelect;
export type Fact = typeof s.facts.$inferSelect;
export type Claim = typeof s.claims.$inferSelect;
export type CustomerConstraint = typeof s.customerConstraints.$inferSelect;

export type Snapshot = {
  /** Shop clock. */
  now: Date;
  shop: { timezone: string; opensAt: string; closesAt: string; policy: Policy };
  models: EquipmentModel[];
  substitutes: (typeof s.modelSubstitutes.$inferSelect)[];
  units: Unit[];
  unavailability: (typeof s.unitUnavailability.$inferSelect)[];
  conditionNotes: (typeof s.conditionNotes.$inferSelect)[];
  facts: Fact[];
  customers: Customer[];
  bookings: Booking[];
  /** Active claims held by proposals other than the one being planned. */
  otherClaims: Claim[];
  /** Customers who refused in this proposal (`proposal_exclusions`). */
  excludedCustomerIds: string[];
  /** This proposal's customer-stated constraints. */
  constraints: CustomerConstraint[];
};

/** Where a booking sits: the part of a booking a plan can change. */
export type Placement = { unitId: string | null; modelId: string; startsAt: Date; endsAt: Date; bufferEndsAt: Date };

export const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['confirmed', 'picked_up']);

/** Byte-order comparison: unlike localeCompare, the same on every machine. */
export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const overlaps = (a: { start: Date; end: Date }, b: { start: Date; end: Date }) =>
  a.start < b.end && b.start < a.end;

/** A placement's occupancy of its unit: `[start, buffer end)`. */
export const occupancy = (p: Placement) => ({ start: p.startsAt, end: p.bufferEndsAt });

export const placementOf = (b: Booking): Placement => ({
  unitId: b.unitId,
  modelId: b.modelId,
  startsAt: b.startsAt,
  endsAt: b.endsAt,
  bufferEndsAt: b.bufferEndsAt,
});

/** Lookups over a snapshot, sorted so every iteration order is deterministic. */
export type Index = ReturnType<typeof indexSnapshot>;

export function indexSnapshot(snap: Snapshot) {
  const byId = <T extends { id: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]));
  const units = [...snap.units].sort((a, b) => cmp(a.label, b.label) || cmp(a.id, b.id));
  const activeBookings = snap.bookings
    .filter((b) => ACTIVE_STATUSES.has(b.status))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || cmp(a.id, b.id));
  const models = byId(snap.models);

  return {
    snap,
    policy: snap.shop.policy,
    models,
    units: byId(snap.units),
    bookings: byId(snap.bookings),
    customers: byId(snap.customers),
    activeBookings,
    /** Active units of a model, by label. */
    unitsOfModel: (modelId: string) => units.filter((u) => u.modelId === modelId && u.active),
    /** Substitute models, by tier then name. */
    substitutesOf: (modelId: string) =>
      snap.substitutes
        .filter((x) => x.modelId === modelId)
        .map((x) => models.get(x.substituteModelId)!)
        .filter(Boolean)
        .sort((a, b) => a.tier - b.tier || cmp(a.name, b.name)),
    unavailabilityOn: (unitId: string) => snap.unavailability.filter((u) => u.unitId === unitId),
    openNotesOn: (unitId: string) => snap.conditionNotes.filter((n) => n.unitId === unitId && !n.resolvedAt),
    /** A unit-level fact wins over a model-level one. */
    fact: (unitId: string, key: string) => {
      const unit = snap.units.find((u) => u.id === unitId);
      return (
        snap.facts.find((f) => f.unitId === unitId && f.key === key) ??
        snap.facts.find((f) => f.modelId === unit?.modelId && f.key === key)
      );
    },
    claimedBookingIds: new Set(snap.otherClaims.filter((c) => c.bookingId && !c.releasedAt).map((c) => c.bookingId!)),
    capacityClaimsOn: (unitId: string) => snap.otherClaims.filter((c) => c.unitId === unitId && c.period && !c.releasedAt),
    excluded: new Set(snap.excludedCustomerIds),
    constraintsOf: (customerId: string) => snap.constraints.filter((c) => c.customerId === customerId),
    customerName: (customerId: string) => snap.customers.find((c) => c.id === customerId)?.name ?? 'a customer',
    unitLabel: (unitId: string | null) => (unitId ? (snap.units.find((u) => u.id === unitId)?.label ?? 'unknown unit') : 'no unit'),
  };
}
