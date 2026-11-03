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
//
// Undo puts back the owner's latest applied edit unless it overrode a request; Discard throws away a red draft.

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { logActivity } from '../activity.ts';
import type { Db, Tx } from '../db/client.ts';
import { loadSnapshot } from '../db/load-snapshot.ts';
import { allowOwnerShorten, withShopLock } from '../db/lock.ts';
import * as s from '../db/schema.ts';
import { type Placement, occupancy, overlaps } from '../optimizer/snapshot.ts';
import { type Violation, validate } from '../optimizer/validator.ts';
import type { PaymentGateway } from '../payments/gateway.ts';
import { cancelRefundRequestId, enqueueOp, runPaymentOp } from '../payments/ops.ts';
import { type StoredRequest, loadRequest } from '../proposals/request.ts';
import { type RequestChangeResult, requestChange } from '../proposals/flow.ts';
import { ACTIVE_STATES } from '../proposals/state-machine.ts';
import { endProposal } from '../proposals/store.ts';

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
export type Replanned = { proposalId: string; requesterCustomerId: string | null; replan: RequestChangeResult | null };

type Locked =
  | Exclude<OwnerEditResult, { status: 'applied' }>
  | { status: 'applied'; booking: typeof s.bookings.$inferSelect; cancelled: (typeof s.proposals.$inferSelect)[]; opIds: string[] };

export async function ownerEditBooking(db: Db, gateway: PaymentGateway, shopId: string, edit: OwnerEdit): Promise<OwnerEditResult> {
  const locked = await withShopLock(db, shopId, (tx) => applyLocked(tx, shopId, edit));
  if (locked.status !== 'applied') return locked;

  // After commit: payments are external calls and never run inside the lock (docs/conflict-model.md §3a).
  const paymentOps = [];
  for (const id of locked.opIds) paymentOps.push(await runPaymentOp(db, gateway, id));
  return { status: 'applied', booking: locked.booking, cancelled: await replanRequesters(db, shopId, locked.cancelled), paymentOps };
}

/**
 * Owner wins, and the requester is re-planned against the new schedule (docs/conflict-model.md §6): their request
 * becomes a fresh offer, and the card reaches them through the agent.
 */
async function replanRequesters(db: Db, shopId: string, ended: (typeof s.proposals.$inferSelect)[]): Promise<Replanned[]> {
  const cancelled: Replanned[] = [];
  for (const p of ended) {
    if (!p.requesterCustomerId) {
      cancelled.push({ proposalId: p.id, requesterCustomerId: null, replan: null });
      continue;
    }
    const replan = await requestChange(db, shopId, { customerId: p.requesterCustomerId, request: loadRequest(p.request as StoredRequest) });
    if (replan.status === 'offered')
      await logActivity(db, {
        shopId, at: replan.proposal.createdAt, actor: 'system', kind: 'offer_ready', proposalId: replan.proposal.id,
        payload: { customerId: p.requesterCustomerId, revisionIds: replan.revisions.map((r) => r.id), role: 'requester', replanOf: p.id },
      });
    cancelled.push({ proposalId: p.id, requesterCustomerId: p.requesterCustomerId, replan });
  }
  return cancelled;
}

// ---------------------------------------------------------------------------------------------------------
// The owner cancels a booking

export type OwnerCancel = { bookingId: string; basedOnVersion: number; agreedByPhone: boolean; override?: boolean };

export type OwnerCancelResult =
  | { status: 'cancelled'; refundCents: number; refundsOk: boolean; replanned: Replanned[] }
  | { status: 'claimed'; proposals: ClaimingProposal[] }
  | { status: 'refused'; reason: string }
  | { status: 'stale'; currentVersion: number };

/**
 * The customer agreed by phone, so the booking is cancelled and everything they paid for it goes back: what's left on
 * each order behind it, including any extension they paid for. A request that needs this booking goes the same way as
 * an owner edit (warning, then override). The schedule change never waits on PayPal; a refund that fails is retried and
 * then alerts the owner (`runPaymentOp`).
 */
export async function ownerCancelBooking(db: Db, gateway: PaymentGateway, shopId: string, input: OwnerCancel): Promise<OwnerCancelResult> {
  const locked = await withShopLock(db, shopId, async (tx) => {
    const [booking] = await tx.select().from(s.bookings).where(and(eq(s.bookings.id, input.bookingId), eq(s.bookings.shopId, shopId)));
    if (!booking) return { status: 'refused' as const, reason: 'booking not found' };
    if (booking.status === 'picked_up') return { status: 'refused' as const, reason: 'this rental is out with the customer: mark it returned instead of cancelling it' };
    if (booking.status !== 'confirmed') return { status: 'refused' as const, reason: `this booking is already ${booking.status.replace('_', ' ')}` };
    if (booking.version !== input.basedOnVersion) return { status: 'stale' as const, currentVersion: booking.version };
    const now = (await loadSnapshot(tx, shopId)).now;
    if (!input.agreedByPhone) {
      const [customer] = await tx.select().from(s.customers).where(eq(s.customers.id, booking.customerId));
      return { status: 'refused' as const, reason: `${customer?.name ?? 'The customer'} hasn't agreed: tick "agreed by phone" to cancel their booking` };
    }

    const claiming = await claimingProposals(tx, shopId, booking.id, null);
    if (claiming.some((p) => p.state === 'CAPTURING')) return { status: 'refused' as const, reason: 'a payment for this booking is being captured; try again in a few seconds' };
    // The customer's own request about this booking is pointless now, so it ends without a warning.
    const own = await tx.select().from(s.proposals).where(and(eq(s.proposals.subjectBookingId, booking.id), inArray(s.proposals.state, [...ACTIVE_STATES])));
    if (own.some((p) => p.state === 'CAPTURING')) return { status: 'refused' as const, reason: 'a payment for this booking is being captured; try again in a few seconds' };
    const ownIds = new Set(own.map((p) => p.id));
    const others = claiming.filter((p) => !ownIds.has(p.id));
    if (others.length && !input.override) return { status: 'claimed' as const, proposals: others };

    const opIds: string[] = [];
    const replan: (typeof s.proposals.$inferSelect)[] = [];
    for (const c of others) {
      const [p] = await tx.select().from(s.proposals).where(eq(s.proposals.id, c.id));
      opIds.push(...(await endProposal(tx, p!, 'owner_override', 'The owner cancelled a booking this request depended on', now, 'owner')).opIds);
      replan.push((await tx.select().from(s.proposals).where(eq(s.proposals.id, c.id)))[0]!);
    }
    for (const p of own) opIds.push(...(await endProposal(tx, p, 'owner_override', 'The owner cancelled this booking', now, 'owner')).opIds);

    // Everything paid for this booking: its prepayment, plus what committed requests about it captured.
    const committed = (await tx.select({ id: s.proposals.id }).from(s.proposals).where(and(eq(s.proposals.subjectBookingId, booking.id), eq(s.proposals.state, 'COMMITTED')))).map((p) => p.id);
    const orders = (await tx.select().from(s.paypalOrders).where(and(eq(s.paypalOrders.shopId, shopId), eq(s.paypalOrders.status, 'captured'))))
      .filter((o) => o.id === booking.prepaidOrderId || (o.proposalId && committed.includes(o.proposalId)));
    // `price_cents` is what the booking currently stands at, net of earlier refunds: never refund more than that.
    let left = booking.priceCents;
    let refundCents = 0;
    for (const order of orders) {
      const amountCents = Math.min(order.capturedCents - order.refundedCents, left);
      if (amountCents <= 0) continue;
      opIds.push(await enqueueOp(tx, {
        order, kind: 'refund', amountCents, proposalId: null, revisionId: null, customerId: booking.customerId, at: now,
        requestId: cancelRefundRequestId(order.id, booking.customerId),
      }));
      left -= amountCents;
      refundCents += amountCents;
    }

    const [updated] = await tx.update(s.bookings).set({ status: 'cancelled', version: booking.version + 1 }).where(eq(s.bookings.id, booking.id)).returning();
    await tx.delete(s.ownerDrafts).where(eq(s.ownerDrafts.bookingId, booking.id));
    await tx.update(s.escalations).set({ status: 'resolved', resolution: { bookingCancelled: true } })
      .where(and(eq(s.escalations.bookingId, booking.id), eq(s.escalations.status, 'open')));
    await logActivity(tx, {
      shopId, at: now, actor: 'owner', kind: 'booking_cancelled',
      payload: { bookingId: booking.id, customerId: booking.customerId, refundCents, agreedByPhone: true, overrode: others.map((p) => p.id), version: updated!.version },
    });
    return { status: 'cancelled' as const, refundCents, opIds, replan };
  });
  if (locked.status !== 'cancelled') return locked;

  let refundsOk = true;
  for (const id of locked.opIds) {
    const op = await runPaymentOp(db, gateway, id);
    if (op.kind === 'refund' && op.status !== 'succeeded') refundsOk = false;
  }
  return { status: 'cancelled', refundCents: locked.refundCents, refundsOk, replanned: await replanRequesters(db, shopId, locked.replan) };
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
    const ended = await endProposal(tx, p!, 'owner_override', 'The owner changed a booking this request depended on', snapshot.now, 'owner');
    opIds.push(...ended.opIds);
    cancelled.push((await tx.select().from(s.proposals).where(eq(s.proposals.id, c.id)))[0]!);
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
      version: updated!.version,
    },
  });
  return { status: 'applied', booking: updated!, cancelled, opIds };
}

// ---------------------------------------------------------------------------------------------------------
// Undo and discard

export type UndoableEdit = {
  bookingId: string;
  customerId: string;
  before: { unitId: string | null; startsAt: string; endsAt: string };
  after: { unitId: string | null; startsAt: string; endsAt: string };
};

/**
 * The owner's latest edit, if Undo can still put it back exactly: nothing has changed the booking since, and the
 * edit didn't override a request (that request was cancelled, its hold voided and its customers told, which no undo
 * can take back).
 */
export async function lastUndoableEdit(tx: Tx, shopId: string): Promise<UndoableEdit | null> {
  const [row] = await tx
    .select()
    .from(s.activityLog)
    .where(and(eq(s.activityLog.shopId, shopId), eq(s.activityLog.kind, 'booking_edited')))
    .orderBy(desc(s.activityLog.seq))
    .limit(1);
  if (!row) return null;
  const p = row.payload as { bookingId: string; before: UndoableEdit['before']; after: UndoableEdit['after']; overrode?: string[]; version?: number };
  if (p.overrode?.length || p.version === undefined) return null;
  const [booking] = await tx.select().from(s.bookings).where(and(eq(s.bookings.id, p.bookingId), eq(s.bookings.shopId, shopId)));
  if (!booking || booking.version !== p.version) return null;
  return { bookingId: p.bookingId, customerId: booking.customerId, before: p.before, after: p.after };
}

/** Puts the booking back where it was before the owner's latest edit, if that slot is still free. */
export function undoOwnerEdit(db: Db, shopId: string, input: { bookingId: string }) {
  return withShopLock(db, shopId, async (tx) => {
    const edit = await lastUndoableEdit(tx, shopId);
    if (!edit || edit.bookingId !== input.bookingId) return { status: 'refused' as const, reason: 'that change can no longer be undone' };
    const [booking] = await tx.select().from(s.bookings).where(eq(s.bookings.id, edit.bookingId));
    const snapshot = await loadSnapshot(tx, shopId);
    const back: Placement = {
      unitId: edit.before.unitId,
      modelId: edit.before.unitId ? snapshot.units.find((u) => u.id === edit.before.unitId)!.modelId : booking!.modelId,
      startsAt: new Date(edit.before.startsAt),
      endsAt: new Date(edit.before.endsAt),
      bufferEndsAt: new Date(new Date(edit.before.endsAt).getTime() + (booking!.bufferEndsAt.getTime() - booking!.endsAt.getTime())),
    };
    // The old slot may have been taken since, or have passed: the same checks as any edit, minus "agreed by phone"
    // (this is the booking the customer agreed to in the first place).
    const v = validate(snapshot, { changes: [{ bookingId: booking!.id, customerId: booking!.customerId, after: back }], requesterCustomerId: booking!.customerId, allowPickedUpShorten: true });
    if (v.violations.length) return { status: 'refused' as const, reason: `can't undo: ${[...new Set(v.violations.map((x) => x.message))].join('; ')}` };

    await allowOwnerShorten(tx);
    await tx
      .update(s.bookings)
      .set({ unitId: back.unitId, modelId: back.modelId, startsAt: back.startsAt, endsAt: back.endsAt, bufferEndsAt: back.bufferEndsAt, version: booking!.version + 1 })
      .where(eq(s.bookings.id, booking!.id));
    await logActivity(tx, { shopId, at: snapshot.now, actor: 'owner', kind: 'booking_edit_undone', payload: { bookingId: booking!.id, restored: edit.before } });
    return { status: 'undone' as const };
  });
}

/** Throws away a red draft. Drafts hold nothing and block nothing, so this restores the state exactly. */
export function discardDraft(db: Db, shopId: string, input: { draftId: string }) {
  return withShopLock(db, shopId, async (tx) => {
    const [draft] = await tx.delete(s.ownerDrafts).where(and(eq(s.ownerDrafts.id, input.draftId), eq(s.ownerDrafts.shopId, shopId))).returning();
    if (!draft) return { status: 'refused' as const, reason: 'draft not found' };
    await logActivity(tx, { shopId, at: (await loadSnapshot(tx, shopId)).now, actor: 'owner', kind: 'draft_discarded', payload: { bookingId: draft.bookingId } });
    return { status: 'discarded' as const };
  });
}

/** Active proposals holding this booking, or holding capacity the edit moves into. */
async function claimingProposals(tx: Tx, shopId: string, bookingId: string, after: Placement | null): Promise<ClaimingProposal[]> {
  const rows = await tx
    .select({ claim: s.claims, proposal: s.proposals, requester: s.customers })
    .from(s.claims)
    .innerJoin(s.proposals, eq(s.claims.proposalId, s.proposals.id))
    .leftJoin(s.customers, eq(s.proposals.requesterCustomerId, s.customers.id))
    .where(and(eq(s.claims.shopId, shopId), isNull(s.claims.releasedAt), inArray(s.proposals.state, [...ACTIVE_STATES])));
  const hits = rows.filter(
    ({ claim }) =>
      claim.bookingId === bookingId ||
      (after && claim.unitId === after.unitId && claim.period && overlaps(claim.period, occupancy(after))),
  );
  const byId = new Map(hits.map(({ proposal, requester }) => [
    proposal.id,
    { id: proposal.id, state: proposal.state, requesterCustomerId: proposal.requesterCustomerId, requesterName: requester?.name ?? null },
  ]));
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}
