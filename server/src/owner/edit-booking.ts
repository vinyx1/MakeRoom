// An owner drag or resize in Bryntum (docs/conflict-model.md §1, §6; judge scenarios D1–D5; demo Scenario 6).
//
//   invalid (outside hours, in the past, moving a picked-up rental) → refused, with the reason
//   overlaps another booking                                         → saved as a red draft; blocks nothing
//   clean, but the customer hasn't agreed                            → refused until "agreed by phone" is ticked
//   clean, but a pending proposal holds the booking or the slot      → warning; nothing changes
//   ... and the owner overrides                                      → owner wins: the proposal is CANCELLED,
//                                                                      its authorization voided, the edit applied,
//                                                                      and the requester re-planned
//   ... while that proposal is CAPTURING                             → refused for those few seconds

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { logActivity } from '../activity.ts';
import type { Db, Tx } from '../db/client.ts';
import { loadSnapshot } from '../db/load-snapshot.ts';
import { allowOwnerShorten, withShopLock } from '../db/lock.ts';
import * as s from '../db/schema.ts';
import { type OptimizeResult, optimize } from '../optimizer/optimizer.ts';
import { type Placement, occupancy, overlaps } from '../optimizer/snapshot.ts';
import { type Violation, validate } from '../optimizer/validator.ts';
import type { PaymentGateway } from '../payments/gateway.ts';
import { enqueueVoid, runPaymentOp } from '../payments/ops.ts';
import { type StoredRequest, loadRequest } from '../proposals/request.ts';
import { ACTIVE_STATES, transition } from '../proposals/state-machine.ts';

export type OwnerEdit = {
  bookingId: string;
  unitId: string;
  startsAt: Date;
  endsAt: Date;
  /** The booking version the owner's view showed; a mismatch means the view is stale. */
  basedOnVersion: number;
  /** "Agreed by phone". */
  attestedCustomerIds: string[];
  /** The owner saw the pending-request warning and chose to go ahead. */
  override?: boolean;
};

export type ClaimingProposal = { id: string; state: string; requesterCustomerId: string | null; requesterName: string | null };

export type OwnerEditResult =
  | { status: 'applied'; booking: typeof s.bookings.$inferSelect; cancelled: Replanned[]; paymentOps: (typeof s.paymentOps.$inferSelect | undefined)[] }
  | { status: 'draft'; draftId: string; violations: Violation[] }
  | { status: 'claimed'; proposals: ClaimingProposal[] }
  | { status: 'refused'; reason: string; violations?: Violation[] }
  | { status: 'stale'; currentVersion: number };

/** A proposal the override cancelled, and the requester's request planned again against the new schedule. */
export type Replanned = { proposalId: string; requesterCustomerId: string | null; replan: OptimizeResult | null };

type Locked =
  | Exclude<OwnerEditResult, { status: 'applied' }>
  | { status: 'applied'; booking: typeof s.bookings.$inferSelect; cancelled: (typeof s.proposals.$inferSelect)[]; opIds: string[] };

export async function ownerEditBooking(db: Db, gateway: PaymentGateway, shopId: string, edit: OwnerEdit): Promise<OwnerEditResult> {
  const locked = await withShopLock(db, shopId, (tx) => applyLocked(tx, shopId, edit));
  if (locked.status !== 'applied') return locked;

  // After commit: payments are external calls and never run inside the lock (docs/conflict-model.md §3a).
  const paymentOps = [];
  for (const id of locked.opIds) paymentOps.push(await runPaymentOp(db, gateway, id));

  const cancelled: Replanned[] = [];
  for (const p of locked.cancelled) {
    const snapshot = await db.transaction((tx) => loadSnapshot(tx, shopId));
    const request = loadRequest(p.request as StoredRequest);
    cancelled.push({ proposalId: p.id, requesterCustomerId: p.requesterCustomerId, replan: p.requesterCustomerId ? optimize(snapshot, request) : null });
  }
  return { status: 'applied', booking: locked.booking, cancelled, paymentOps };
}

async function applyLocked(tx: Tx, shopId: string, edit: OwnerEdit): Promise<Locked> {
  const [booking] = await tx.select().from(s.bookings).where(and(eq(s.bookings.id, edit.bookingId), eq(s.bookings.shopId, shopId)));
  if (!booking) return { status: 'refused', reason: 'booking not found' };
  if (booking.version !== edit.basedOnVersion) return { status: 'stale', currentVersion: booking.version };
  const [unit] = await tx.select().from(s.units).where(and(eq(s.units.id, edit.unitId), eq(s.units.shopId, shopId)));
  if (!unit) return { status: 'refused', reason: 'unit not found' };

  const after: Placement = {
    unitId: unit.id,
    modelId: unit.modelId,
    startsAt: edit.startsAt,
    endsAt: edit.endsAt,
    bufferEndsAt: new Date(edit.endsAt.getTime() + (booking.bufferEndsAt.getTime() - booking.endsAt.getTime())),
  };
  if (
    after.unitId === booking.unitId &&
    after.startsAt.getTime() === booking.startsAt.getTime() &&
    after.endsAt.getTime() === booking.endsAt.getTime()
  )
    return { status: 'refused', reason: 'nothing changed' };

  const snapshot = await loadSnapshot(tx, shopId);
  const claiming = await claimingProposals(tx, shopId, booking.id, after);
  const claimingIds = new Set(claiming.map((p) => p.id));
  // Validate as if the claiming proposals were gone: their claims are what the override would remove.
  const v = validate(
    { ...snapshot, otherClaims: snapshot.otherClaims.filter((c) => !claimingIds.has(c.proposalId)) },
    { changes: [{ bookingId: booking.id, customerId: booking.customerId, after }], requesterCustomerId: booking.customerId, allowPickedUpShorten: true },
  );
  const hard = v.violations.filter((x) => x.rule !== 'overlap');
  if (hard.length) return { status: 'refused', reason: hard.map((x) => x.message).join('; '), violations: hard };

  if (v.violations.length) {
    const [draft] = await tx
      .insert(s.ownerDrafts)
      .values({
        shopId,
        bookingId: booking.id,
        proposed: { unitId: after.unitId, startsAt: after.startsAt.toISOString(), endsAt: after.endsAt.toISOString() },
        basedOnVersion: booking.version,
        attestedCustomerIds: edit.attestedCustomerIds,
      })
      .onConflictDoUpdate({
        target: s.ownerDrafts.bookingId,
        set: {
          proposed: { unitId: after.unitId, startsAt: after.startsAt.toISOString(), endsAt: after.endsAt.toISOString() },
          basedOnVersion: booking.version,
          attestedCustomerIds: edit.attestedCustomerIds,
        },
      })
      .returning();
    await logActivity(tx, { shopId, at: snapshot.now, actor: 'owner', kind: 'draft_saved', payload: { bookingId: booking.id, violations: v.violations.map((x) => x.message) } });
    return { status: 'draft', draftId: draft!.id, violations: v.violations };
  }

  if (!edit.attestedCustomerIds.includes(booking.customerId)) {
    const [customer] = await tx.select().from(s.customers).where(eq(s.customers.id, booking.customerId));
    return { status: 'refused', reason: `${customer?.name ?? 'The customer'} hasn't agreed: tick "agreed by phone", or resolve it with the agent` };
  }

  const capturing = claiming.find((p) => p.state === 'CAPTURING');
  if (capturing) return { status: 'refused', reason: 'a payment for this booking is being captured; try again in a few seconds' };
  if (claiming.length && !edit.override) return { status: 'claimed', proposals: claiming };

  // Owner wins: end every claiming proposal before applying the edit.
  const cancelled: (typeof s.proposals.$inferSelect)[] = [];
  const opIds: string[] = [];
  for (const c of claiming) {
    const [p] = await tx.select().from(s.proposals).where(eq(s.proposals.id, c.id));
    const t = transition(p!.state, 'owner_override');
    // Unreachable (CAPTURING is refused above); throwing rolls back any proposal already cancelled.
    if (!t.ok) throw new Error(`owner override: ${t.reason}`);
    const [updated] = await tx
      .update(s.proposals)
      .set({ state: t.to, endedReason: 'The owner changed a booking this request depended on', version: p!.version + 1 })
      .where(eq(s.proposals.id, p!.id))
      .returning();
    cancelled.push(updated!);
    if (t.effects.includes('release_claims'))
      await tx.update(s.claims).set({ releasedAt: snapshot.now }).where(and(eq(s.claims.proposalId, p!.id), isNull(s.claims.releasedAt)));
    if (t.effects.includes('void_authorization')) {
      const orders = await tx.select().from(s.paypalOrders).where(eq(s.paypalOrders.proposalId, p!.id));
      for (const o of orders) {
        const opId = await enqueueVoid(tx, o, snapshot.now);
        if (opId) opIds.push(opId);
      }
    }
    await logActivity(tx, {
      shopId, at: snapshot.now, actor: 'owner', kind: 'proposal_cancelled', proposalId: p!.id,
      payload: { reason: 'owner_override', bookingId: booking.id, from: p!.state, to: t.to },
    });
  }

  await allowOwnerShorten(tx);
  const [updated] = await tx
    .update(s.bookings)
    .set({ unitId: after.unitId, modelId: after.modelId, startsAt: after.startsAt, endsAt: after.endsAt, bufferEndsAt: after.bufferEndsAt, version: booking.version + 1 })
    .where(eq(s.bookings.id, booking.id))
    .returning();
  await tx.delete(s.ownerDrafts).where(eq(s.ownerDrafts.bookingId, booking.id));
  await logActivity(tx, {
    shopId, at: snapshot.now, actor: 'owner', kind: 'booking_edited',
    payload: {
      bookingId: booking.id,
      before: { unitId: booking.unitId, startsAt: booking.startsAt, endsAt: booking.endsAt },
      after: { unitId: after.unitId, startsAt: after.startsAt, endsAt: after.endsAt },
      agreedByPhone: edit.attestedCustomerIds,
      overrode: cancelled.map((p) => p.id),
    },
  });
  return { status: 'applied', booking: updated!, cancelled, opIds };
}

/** Active proposals holding this booking, or holding capacity the edit moves into. */
async function claimingProposals(tx: Tx, shopId: string, bookingId: string, after: Placement): Promise<ClaimingProposal[]> {
  const rows = await tx
    .select({ claim: s.claims, proposal: s.proposals, requester: s.customers })
    .from(s.claims)
    .innerJoin(s.proposals, eq(s.claims.proposalId, s.proposals.id))
    .leftJoin(s.customers, eq(s.proposals.requesterCustomerId, s.customers.id))
    .where(and(eq(s.claims.shopId, shopId), isNull(s.claims.releasedAt), inArray(s.proposals.state, [...ACTIVE_STATES])));
  const hits = rows.filter(
    ({ claim }) =>
      claim.bookingId === bookingId ||
      (claim.unitId === after.unitId && claim.period && overlaps(claim.period, occupancy(after))),
  );
  const byId = new Map(hits.map(({ proposal, requester }) => [
    proposal.id,
    { id: proposal.id, state: proposal.state, requesterCustomerId: proposal.requesterCustomerId, requesterName: requester?.name ?? null },
  ]));
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}
