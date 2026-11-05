// The proposal flow: Scenario 1 from request to refund (docs/conflict-model.md §3–6, docs/data-model.md §9).
//
//   requestChange          customer asks → optimizer → proposal (DRAFT) with up to 2 option revisions
//   createRequesterOrder   the PayPal button asks for an order to authorize
//   requesterAccept        requester's Accept + authorization → claims → AWAITING_APPROVALS → offers go out
//   affectedAccept         an affected party picks an option → siblings superseded → owner asked if needed
//   ownerDecision          owner approves or declines a revision
//   expireDue              timeouts (approval and authorization), driven by the shop clock
//
// When every approval on the selected revision is in: CAPTURING → capture (outside the lock) → revalidate →
// apply all changes in one transaction → COMMITTED → refunds. Any exit before capture voids the
// authorization; a failure after capture refunds it (invariant 4).
//
// Every write runs in `withShopLock` and revalidates against current state first (invariant 5). Payment calls
// run after the transaction commits. Approvals are only ever recorded here, from clicks (invariant 3).
//
//   affectedRefuse         "Keep my booking as is" → that customer excluded → fallback plan or closest alternative
//   requesterCancel        the requester backs out before capture
//   requestChange          again on an unpaid offer: the requester's correction replaces it
//   affectedCounter        an affected party's terms → a draft on their card, or the nearest time that works
//   counterSend/Discard    their click on it: Send is their approval of it
//   markOverdue            a late return: the next renters re-planned around it, with no one paying
//   markReturned           the rental is back; anything planned around it ends
//
// Not yet: customer-stated constraints. Customers are told by the agent, which reads
// the activity events (`offer_ready`, `affected_refused`, `proposal_update`, `proposal_ended`).

import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { logActivity } from '../activity.ts';
import type { Db, Tx } from '../db/client.ts';
import { loadSnapshot } from '../db/load-snapshot.ts';
import { allowOwnerShorten, withShopLock } from '../db/lock.ts';
import * as s from '../db/schema.ts';
import { type Plan, type Pruned, type Request, nearestAlternative, optimize, planCounter } from '../optimizer/optimizer.ts';
import { type Index, type Placement, indexSnapshot } from '../optimizer/snapshot.ts';
import { formatShopTime } from '../optimizer/time.ts';
import { type Violation, validate } from '../optimizer/validator.ts';
import type { PaymentGateway } from '../payments/gateway.ts';
import { compactId, enqueueOp, enqueueVoid, runPaymentOp } from '../payments/ops.ts';
import { type StoredRequest, loadRequest, storeRequest } from './request.ts';
import { ACTIVE_STATES, transition } from './state-machine.ts';
import {
  LIVE_REVISION_STATUSES,
  type Proposal,
  type Revision,
  type RevisionChange,
  afterOf,
  allApproved,
  cloneRevision,
  endProposal,
  ensureOwnerApproval,
  insertRevision,
  placeClaims,
  proposedChanges,
  releaseClaims,
} from './store.ts';

type Refused = { status: 'refused'; reason: string };
const refused = (reason: string): Refused => ({ status: 'refused', reason });

/** The outcome once every approval is in, or the proposal ended. */
export type Settled =
  | { status: 'committed'; proposalId: string; refundOps: (typeof s.paymentOps.$inferSelect)[] }
  | { status: 'failed'; proposalId: string; reason: string; violations?: Violation[] };

// ---------------------------------------------------------------------------------------------------------
// 1. Request

export type RequestChangeResult =
  | { status: 'offered'; proposal: Proposal; revisions: Revision[]; chargeCents: number; isAlternative: boolean; pruned: Pruned[] }
  | { status: 'invalid'; violations: Violation[] }
  | { status: 'infeasible'; pruned: Pruned[] }
  | { status: 'revision_limit' }
  | Refused;

export function requestChange(db: Db, shopId: string, input: { customerId: string; request: Request }): Promise<RequestChangeResult> {
  return withShopLock(db, shopId, async (tx) => {
    const { request, customerId } = input;
    const snapshot = await loadSnapshot(tx, shopId);
    const idx = indexSnapshot(snapshot);
    const now = snapshot.now;

    const bookingId = request.kind === 'new_booking' ? null : request.bookingId;
    if (bookingId ? idx.bookings.get(bookingId)?.customerId !== customerId : request.kind === 'new_booking' && request.customerId !== customerId)
      return refused('booking not found');
    if (bookingId) {
      const [active] = await tx
        .select()
        .from(s.proposals)
        .where(and(eq(s.proposals.subjectBookingId, bookingId), eq(s.proposals.requesterCustomerId, customerId), inArray(s.proposals.state, [...ACTIVE_STATES])));
      if (active) return replaceUnpaidOffer(tx, active, request, customerId);
    }

    const result = optimize(snapshot, request);
    await logActivity(tx, {
      shopId, at: now, actor: 'system', kind: 'optimizer_run',
      payload: {
        request: storeRequest(request),
        status: result.status,
        plans: result.status === 'fits' || result.status === 'needs_other_changes' ? result.plans.map(planSummary) : [],
        pruned: result.status === 'invalid_request' ? [] : result.pruned.map((p) => ({ message: p.message, rules: p.rules, bookingId: p.bookingId, customerId: p.customerId, after: p.after, conflictsWith: p.conflictsWith })),
      },
    });
    if (result.status === 'invalid_request') return { status: 'invalid', violations: result.violations };

    const options = result.status === 'infeasible' ? (result.nearest ? [result.nearest] : []) : chooseOptions(result.plans);
    if (!options.length) return { status: 'infeasible', pruned: result.pruned };

    const policy = snapshot.shop.policy;
    const [proposal] = await tx
      .insert(s.proposals)
      .values({
        shopId, source: 'customer_request', requesterCustomerId: customerId, subjectBookingId: bookingId,
        request: storeRequest(request), state: 'DRAFT', revisionSeq: 1,
        expiresAt: new Date(now.getTime() + policy.approval_timeout_minutes * 60_000), createdAt: now,
      })
      .returning();
    const revisions: Revision[] = [];
    for (const [i, plan] of options.entries()) {
      const { revision } = await insertRevision(tx, {
        proposal: proposal!, seq: 1, optionLabel: options.length > 1 ? (['A', 'B'] as const)[i]! : null, plan,
        origin: plan.isAlternative ? 'alternative' : 'optimizer', at: now,
      });
      revisions.push(revision);
    }
    await tx.insert(s.approvals).values(
      revisions.map((r) => ({
        shopId, revisionId: r.id, proposalId: proposal!.id, role: 'requester' as const, customerId,
        requestedAt: now, expiresAt: proposal!.expiresAt,
      })),
    );
    await logActivity(tx, {
      shopId, at: now, actor: `customer:${customerId}`, kind: 'proposal_created', proposalId: proposal!.id,
      payload: { revisions: revisions.map((r) => ({ id: r.id, option: r.optionLabel, needsOwner: r.needsOwner, quote: r.quote })) },
    });
    return {
      status: 'offered', proposal: proposal!, revisions, chargeCents: options[0]!.quote.chargeCents,
      isAlternative: options[0]!.isAlternative, pruned: result.pruned,
    };
  });
}

/**
 * The requester changes their mind before paying ("not 6pm, 3pm"): the request carries on with new terms, so they
 * don't have to cancel and ask again. Once they've paid, other customers may be deciding on the old terms, so this
 * doesn't apply. If the new terms can't work at all, their current offer stands.
 */
async function replaceUnpaidOffer(tx: Tx, p: Proposal, request: Request, customerId: string): Promise<RequestChangeResult> {
  const inProgress = refused('this booking already has a request in progress');
  if (p.state !== 'DRAFT' || p.source !== 'customer_request') return inProgress;
  const orders = await tx.select().from(s.paypalOrders).where(eq(s.paypalOrders.proposalId, p.id));
  if (orders.some((o) => o.status === 'authorized' || o.status === 'captured')) return inProgress;

  const snapshot = await loadSnapshot(tx, p.shopId, { proposalId: p.id });
  const policy = snapshot.shop.policy;
  const now = snapshot.now;
  if (p.revisionSeq >= policy.max_revisions) return { status: 'revision_limit' };

  const result = optimize(snapshot, request);
  await logActivity(tx, {
    shopId: p.shopId, at: now, actor: 'system', kind: 'optimizer_run', proposalId: p.id,
    payload: {
      request: storeRequest(request), source: 'correction', status: result.status,
      plans: result.status === 'fits' || result.status === 'needs_other_changes' ? result.plans.map(planSummary) : [],
      pruned: result.status === 'invalid_request' ? [] : result.pruned.map((x) => ({ message: x.message, rules: x.rules, bookingId: x.bookingId })),
    },
  });
  if (result.status === 'invalid_request') return { status: 'invalid', violations: result.violations };
  const options = result.status === 'infeasible' ? (result.nearest ? [result.nearest] : []) : chooseOptions(result.plans);
  if (!options.length) return { status: 'infeasible', pruned: result.pruned };

  const old = await liveRevisions(tx, p.id);
  const seq = p.revisionSeq + 1;
  const expiresAt = new Date(now.getTime() + policy.approval_timeout_minutes * 60_000);
  const revisions: Revision[] = [];
  for (const [i, plan] of options.entries()) {
    const { revision } = await insertRevision(tx, {
      proposal: p, seq, optionLabel: options.length > 1 ? (['A', 'B'] as const)[i]! : null, plan,
      origin: plan.isAlternative ? 'alternative' : 'optimizer', at: now,
    });
    revisions.push(revision);
  }
  await tx.insert(s.approvals).values(revisions.map((r) => ({
    shopId: p.shopId, revisionId: r.id, proposalId: p.id, role: 'requester' as const, customerId, requestedAt: now, expiresAt,
  })));
  if (old.length) {
    await tx.update(s.revisions).set({ status: 'superseded' }).where(inArray(s.revisions.id, old.map((r) => r.id)));
    await tx.update(s.escalations).set({ status: 'resolved', resolution: { superseded: true } })
      .where(and(inArray(s.escalations.revisionId, old.map((r) => r.id)), eq(s.escalations.status, 'open')));
  }
  // An unpaid order for the old amount must not be paid: one request id means one amount.
  for (const o of orders) if (o.status === 'created' || o.status === 'approved') await tx.update(s.paypalOrders).set({ status: 'voided' }).where(eq(s.paypalOrders.id, o.id));
  await tx.update(s.proposals).set({ request: storeRequest(request), revisionSeq: seq, expiresAt, version: sql`${s.proposals.version} + 1` }).where(eq(s.proposals.id, p.id));
  await logActivity(tx, {
    shopId: p.shopId, at: now, actor: `customer:${customerId}`, kind: 'request_corrected', proposalId: p.id,
    payload: { revisions: revisions.map((r) => ({ id: r.id, option: r.optionLabel, needsOwner: r.needsOwner, quote: r.quote })) },
  });
  return { status: 'offered', proposal: { ...p, expiresAt, revisionSeq: seq }, revisions, chargeCents: options[0]!.quote.chargeCents, isAlternative: options[0]!.isAlternative, pruned: result.pruned };
}

/**
 * Up to two options, all giving the requester identical terms (the requester sees one offer). Plans outside
 * the envelope only if nothing else works. Options that need no shop confirmation come first, so they get
 * label A ("Plan A: free upgrade; Plan B: 2pm, needs shop confirmation").
 */
function chooseOptions(plans: Plan[]): Plan[] {
  const requesterTerms = (p: Plan) => {
    const r = p.changes.find((c) => c.isRequester)!;
    return JSON.stringify([r.after, p.quote.chargeCents, p.quote.lines]);
  };
  const same = plans.filter((p) => requesterTerms(p) === requesterTerms(plans[0]!));
  const inEnvelope = same.filter((p) => !p.envelopeTrips.length);
  return (inEnvelope.length ? inEnvelope : same).slice(0, 2).sort((a, b) => Number(a.needsOwner) - Number(b.needsOwner));
}

const planSummary = (p: Plan) => ({
  key: p.key, changes: p.changes.map((c) => ({ bookingId: c.bookingId, kind: c.kind, unitId: c.after.unitId, startsAt: c.after.startsAt, endsAt: c.after.endsAt })),
  quote: p.quote, ownerTriggers: p.ownerTriggers, envelopeTrips: p.envelopeTrips, rank: p.rank,
});

// ---------------------------------------------------------------------------------------------------------
// 1b. The owner's "Resolve with agent" on a red draft (demo Scenario 2)

export type ResolveResult =
  | { status: 'resolved'; proposal: Proposal; revisions: Revision[]; pruned: Pruned[] }
  | { status: 'invalid'; violations: Violation[] }
  | { status: 'infeasible'; pruned: Pruned[] }
  | Refused;

/**
 * Turns an owner draft into a proposal for the booking's customer, who agreed by phone (an owner-attested
 * approval). The owner reviews any plan that needs it while it is still a draft; then the customer gets the card
 * to pay, and affected customers are asked as usual.
 */
export function resolveDraft(db: Db, shopId: string, input: { draftId: string; agreedByPhone?: boolean }): Promise<ResolveResult> {
  return withShopLock(db, shopId, async (tx) => {
    const [draft] = await tx.select().from(s.ownerDrafts).where(and(eq(s.ownerDrafts.id, input.draftId), eq(s.ownerDrafts.shopId, shopId)));
    if (!draft) return refused('draft not found');
    const snapshot = await loadSnapshot(tx, shopId);
    const idx = indexSnapshot(snapshot);
    const now = snapshot.now;
    const booking = idx.bookings.get(draft.bookingId)!;
    if (booking.version !== draft.basedOnVersion) return refused('the booking changed since this draft; drag it again');
    // "Agreed by phone" can be given at the drag or here, when the owner resolves.
    if (!input.agreedByPhone && !draft.attestedCustomerIds.includes(booking.customerId))
      return refused(`confirm that ${idx.customerName(booking.customerId)} agreed by phone first: the request is on their behalf`);
    const proposed = { unitId: draft.proposed.unitId ?? booking.unitId, startsAt: new Date(draft.proposed.startsAt!), endsAt: new Date(draft.proposed.endsAt!) };
    if (proposed.unitId !== booking.unitId) return refused('moving a booking to another unit has to be resolved by hand for now');

    const sameStart = proposed.startsAt.getTime() === booking.startsAt.getTime();
    const request: Request =
      sameStart && proposed.endsAt > booking.endsAt
        ? { kind: 'extend', bookingId: booking.id, newEndsAt: proposed.endsAt }
        : { kind: 'shift', bookingId: booking.id, newStartsAt: proposed.startsAt, newEndsAt: proposed.endsAt };
    const [active] = await tx
      .select()
      .from(s.proposals)
      .where(and(eq(s.proposals.subjectBookingId, booking.id), inArray(s.proposals.state, [...ACTIVE_STATES])));
    if (active) return refused('this booking already has a request in progress');

    const result = optimize(snapshot, request);
    await logActivity(tx, {
      shopId, at: now, actor: 'owner', kind: 'optimizer_run',
      payload: {
        request: storeRequest(request), source: 'owner_resolve', status: result.status,
        plans: result.status === 'fits' || result.status === 'needs_other_changes' ? result.plans.map(planSummary) : [],
        pruned: result.status === 'invalid_request' ? [] : result.pruned.map((p) => ({ message: p.message, rules: p.rules, bookingId: p.bookingId, customerId: p.customerId, after: p.after, conflictsWith: p.conflictsWith })),
      },
    });
    if (result.status === 'invalid_request') return { status: 'invalid', violations: result.violations };
    const options = result.status === 'infeasible' ? (result.nearest ? [result.nearest] : []) : chooseOptions(result.plans);
    if (!options.length) return { status: 'infeasible', pruned: result.pruned };

    const [proposal] = await tx
      .insert(s.proposals)
      .values({
        shopId, source: 'owner_resolve', requesterCustomerId: booking.customerId, subjectBookingId: booking.id,
        request: storeRequest(request), state: 'DRAFT', revisionSeq: 1,
        expiresAt: new Date(now.getTime() + snapshot.shop.policy.approval_timeout_minutes * 60_000), createdAt: now,
      })
      .returning();
    const revisions: Revision[] = [];
    for (const [i, plan] of options.entries()) {
      const { revision, changes } = await insertRevision(tx, {
        proposal: proposal!, seq: 1, optionLabel: options.length > 1 ? (['A', 'B'] as const)[i]! : null, plan,
        origin: plan.isAlternative ? 'alternative' : 'optimizer', at: now,
      });
      revisions.push(revision);
      if (revision.needsOwner) await ensureOwnerApproval(tx, idx, proposal!, revision, changes, 'plan_review', now);
    }
    // "Agreed by phone": the customer's approval, attested by the owner. They still pay on their card.
    await tx.insert(s.approvals).values(
      revisions.map((r) => ({
        shopId, revisionId: r.id, proposalId: proposal!.id, role: 'requester' as const, customerId: booking.customerId,
        status: 'approved' as const, source: 'owner_attested' as const, requestedAt: now, respondedAt: now,
      })),
    );
    await tx.delete(s.ownerDrafts).where(eq(s.ownerDrafts.id, draft.id));
    await logActivity(tx, {
      shopId, at: now, actor: 'owner', kind: 'proposal_created', proposalId: proposal!.id,
      payload: { source: 'owner_resolve', revisions: revisions.map((r) => ({ id: r.id, option: r.optionLabel, needsOwner: r.needsOwner, quote: r.quote })) },
    });
    await offerToRequesterIfReviewed(tx, proposal!, now);
    return { status: 'resolved', proposal: proposal!, revisions, pruned: result.pruned };
  });
}

// ---------------------------------------------------------------------------------------------------------
// 1c. An overdue return (docs/conflict-model.md §8; judge D10)

export type OverdueResult =
  /** Nothing else needed to move: the late booking now runs to the expected return. */
  | { status: 'extended' }
  /** The next renters are affected: plans go to the owner first, then to those customers. */
  | { status: 'planned'; proposal: Proposal; revisions: Revision[]; pruned: Pruned[] }
  /** Nothing can make room: the owner has to sort it out with the next renter. */
  | { status: 'no_plan'; pruned: Pruned[] }
  | Refused;

/**
 * The owner marks a picked-up rental overdue, with when the customer now expects to bring it back. It is planned as
 * an extension that happens whether anyone agrees or not (`forced`): the late customer isn't charged (no late fees
 * in the PoC), and the plans move the next renters, never the late rental. With no one paying, every plan that
 * compensates someone runs at a loss, so the owner reviews it before the next renter is asked. If they refuse every
 * option, or nobody answers, the owner is alerted (`endProposal`), since their pickup may have no equipment.
 * Marking it again with a new time replaces the earlier plan.
 */
export async function markOverdue(
  db: Db, gateway: PaymentGateway, shopId: string, input: { bookingId: string; expectedReturnAt: Date },
): Promise<OverdueResult> {
  const locked = await withShopLock(db, shopId, async (tx): Promise<{ result: OverdueResult; ops: string[]; capture?: { proposalId: string; captureOpId: string | null } }> => {
    const snapshot = await loadSnapshot(tx, shopId);
    const now = snapshot.now;
    const b = snapshot.bookings.find((x) => x.id === input.bookingId);
    if (!b) return { result: refused('booking not found'), ops: [] };
    const name = snapshot.customers.find((c) => c.id === b.customerId)?.name ?? 'The customer';
    if (b.status !== 'picked_up') return { result: refused('only a rental that has been picked up can be overdue'), ops: [] };
    if (now < b.endsAt) return { result: refused(`${name}'s rental isn't due back until ${formatShopTime(b.endsAt, snapshot.shop)}`), ops: [] };
    if (input.expectedReturnAt <= now) return { result: refused('the expected return has to be later than now'), ops: [] };

    const active = await tx.select().from(s.proposals).where(and(eq(s.proposals.subjectBookingId, b.id), inArray(s.proposals.state, [...ACTIVE_STATES])));
    if (active.some((p) => p.state === 'CAPTURING')) return { result: refused('a change to this booking is being confirmed right now; try again in a few seconds'), ops: [] };
    if (active.some((p) => p.source !== 'overdue')) return { result: refused(`${name} has a request in progress for this booking; it has to finish first`), ops: [] };

    // Plan against the schedule without the earlier overdue plan (it is replaced), before writing anything, so an
    // invalid time leaves everything as it was.
    const replaced = new Set(active.map((p) => p.id));
    const request: Request = { kind: 'extend', bookingId: b.id, newEndsAt: input.expectedReturnAt, forced: true };
    const result = optimize({ ...snapshot, otherClaims: snapshot.otherClaims.filter((c) => !replaced.has(c.proposalId)) }, request);
    if (result.status === 'invalid_request') return { result: refused([...new Set(result.violations.map((v) => v.message))].join('; ')), ops: [] };

    const ops: string[] = [];
    for (const p of active) ops.push(...(await endProposal(tx, p, 'owner_override', 'The expected return time changed', now, 'owner')).opIds);
    await tx.update(s.bookings).set({ overdueMarkedAt: now }).where(eq(s.bookings.id, b.id));
    await logActivity(tx, {
      shopId, at: now, actor: 'owner', kind: 'optimizer_run',
      payload: {
        request: storeRequest(request), source: 'overdue', status: result.status,
        plans: result.status === 'infeasible' ? [] : result.plans.map(planSummary),
        pruned: result.pruned.map((p) => ({ message: p.message, rules: p.rules, bookingId: p.bookingId, customerId: p.customerId, after: p.after, conflictsWith: p.conflictsWith })),
      },
    });
    const overdueLog = (outcome: string) =>
      logActivity(tx, {
        shopId, at: now, actor: 'owner', kind: 'overdue_marked',
        payload: { bookingId: b.id, customerId: b.customerId, dueAt: b.endsAt, expectedReturnAt: input.expectedReturnAt, outcome },
      });

    // Nobody else is affected: the booking simply runs later.
    if (result.status === 'fits') {
      await tx
        .update(s.bookings)
        .set({ endsAt: input.expectedReturnAt, bufferEndsAt: new Date(input.expectedReturnAt.getTime() + (b.bufferEndsAt.getTime() - b.endsAt.getTime())), version: b.version + 1 })
        .where(eq(s.bookings.id, b.id));
      await overdueLog('extended');
      return { result: { status: 'extended' }, ops };
    }

    if (result.status === 'infeasible') {
      await tx.insert(s.escalations).values({
        shopId, kind: 'overdue', bookingId: b.id, reasons: ['overdue', 'no_plan'], at: now,
        summary: `${name} is overdue with ${snapshot.units.find((u) => u.id === b.unitId)?.label ?? 'their rental'} (due ${formatShopTime(b.endsAt, snapshot.shop)}, expected back ${formatShopTime(input.expectedReturnAt, snapshot.shop)}), and no rearrangement makes room for the next booking. Contact the next renter: cancel with a full refund, or find other equipment.`,
      });
      await overdueLog('no_plan');
      return { result: { status: 'no_plan', pruned: result.pruned }, ops };
    }

    const idx = indexSnapshot(await loadSnapshot(tx, shopId));
    const options = chooseOptions(result.plans);
    const expiresAt = new Date(now.getTime() + snapshot.shop.policy.approval_timeout_minutes * 60_000);
    const [proposal] = await tx
      .insert(s.proposals)
      .values({ shopId, source: 'overdue', requesterCustomerId: null, subjectBookingId: b.id, request: storeRequest(request), state: 'DRAFT', revisionSeq: 1, expiresAt, createdAt: now })
      .returning();
    const revisions: Revision[] = [];
    const rows = new Map<string, RevisionChange[]>();
    try {
      await tx.transaction(async (sp) => {
        for (const [i, plan] of options.entries()) {
          const { revision, changes } = await insertRevision(sp, {
            proposal: proposal!, seq: 1, optionLabel: options.length > 1 ? (['A', 'B'] as const)[i]! : null, plan, origin: 'optimizer', at: now,
          });
          revisions.push(revision);
          rows.set(revision.id, changes);
          await placeClaims(sp, proposal!, revision.id, changes);
        }
      });
    } catch (e) {
      // Another request holds the next booking or the capacity a plan needs: nothing can be offered right now.
      if (pgCode(e) !== '23P01') throw e;
      await tx.delete(s.proposals).where(eq(s.proposals.id, proposal!.id));
      await tx.insert(s.escalations).values({
        shopId, kind: 'overdue', bookingId: b.id, reasons: ['overdue', 'claimed'], at: now,
        summary: `${name} is overdue (expected back ${formatShopTime(input.expectedReturnAt, snapshot.shop)}), but another request is holding the booking that needs to move. Try again once it finishes, or contact the next renter.`,
      });
      await overdueLog('no_plan');
      return { result: { status: 'no_plan', pruned: result.pruned }, ops };
    }

    // No payment to wait for: claims are held, so the offers can go out (to the owner first, for any plan at a loss).
    const t = transition(proposal!.state, 'offer');
    if (!t.ok) throw new Error(t.reason);
    await tx.update(s.proposals).set({ state: t.to, version: sql`${s.proposals.version} + 1` }).where(eq(s.proposals.id, proposal!.id));
    const p = { ...proposal!, state: t.to };
    await openOffers(tx, idx, p, revisions, rows, now, expiresAt);
    await overdueLog('planned');

    // Only notice-only swaps (a same-model unit for the next renter): nobody needs asking.
    if (revisions.length === 1 && !revisions[0]!.needsOwner && !rows.get(revisions[0]!.id)!.some((c) => c.requiresApproval))
      return { result: { status: 'planned', proposal: p, revisions, pruned: result.pruned }, ops, capture: { proposalId: p.id, captureOpId: await startCapture(tx, p, revisions[0]!, now) } };
    return { result: { status: 'planned', proposal: p, revisions, pruned: result.pruned }, ops };
  });
  await runOps(db, gateway, locked.ops);
  if (locked.capture) await captureAndCommit(db, gateway, shopId, locked.capture.proposalId, locked.capture.captureOpId);
  return locked.result;
}

/**
 * The owner marks a picked-up rental returned (on time, late or early). The unit is free again: any request still
 * planning around this rental ends, since nothing needs to change any more. The return time is recorded as now.
 */
export async function markReturned(db: Db, gateway: PaymentGateway, shopId: string, input: { bookingId: string }): Promise<{ status: 'returned'; ended: number } | Refused> {
  const locked = await withShopLock(db, shopId, async (tx) => {
    const now = (await loadSnapshot(tx, shopId)).now;
    const [b] = await tx.select().from(s.bookings).where(and(eq(s.bookings.id, input.bookingId), eq(s.bookings.shopId, shopId)));
    if (!b) return { result: refused('booking not found'), ops: [] as string[] };
    if (b.status !== 'picked_up') return { result: refused(`this booking is ${b.status.replace('_', ' ')}, not out with the customer`), ops: [] as string[] };
    const active = await tx.select().from(s.proposals).where(and(eq(s.proposals.subjectBookingId, b.id), inArray(s.proposals.state, [...ACTIVE_STATES])));
    if (active.some((p) => p.state === 'CAPTURING')) return { result: refused('a change to this booking is being confirmed right now; try again in a few seconds'), ops: [] as string[] };

    const ops: string[] = [];
    for (const p of active)
      ops.push(...(p.source === 'overdue'
        ? await endProposal(tx, p, 'owner_override', 'The equipment came back in time, so nothing needs to change', now, 'owner')
        : await endProposal(tx, p, 'reject', 'The rental was returned, so the change is no longer needed', now, 'owner')).opIds);
    await allowOwnerShorten(tx);
    await tx
      .update(s.bookings)
      .set({ status: 'returned', endsAt: now, bufferEndsAt: new Date(now.getTime() + (b.bufferEndsAt.getTime() - b.endsAt.getTime())), version: b.version + 1 })
      .where(eq(s.bookings.id, b.id));
    await tx.update(s.escalations).set({ status: 'resolved', resolution: { returned: true } })
      .where(and(eq(s.escalations.bookingId, b.id), eq(s.escalations.kind, 'overdue'), eq(s.escalations.status, 'open')));
    await logActivity(tx, {
      shopId, at: now, actor: 'owner', kind: 'booking_returned',
      payload: { bookingId: b.id, customerId: b.customerId, dueAt: b.endsAt, late: now > b.endsAt },
    });
    return { result: { status: 'returned' as const, ended: active.length }, ops };
  });
  await runOps(db, gateway, locked.ops);
  return locked.result;
}

// ---------------------------------------------------------------------------------------------------------
// 2. The requester's PayPal order

export type OrderResult = { status: 'ok'; orderId: string } | { status: 'payment_failed'; error: string } | Refused;

/** For the PayPal button's `createOrder`. `testCard` authorizes on create with no buyer (tests and scripts). */
export async function createRequesterOrder(
  db: Db, gateway: PaymentGateway, shopId: string, input: { proposalId: string; customerId: string; testCard?: boolean },
): Promise<OrderResult> {
  const prep = await withShopLock(db, shopId, async (tx) => {
    const p = await getProposal(tx, shopId, input.proposalId);
    if (!p || p.requesterCustomerId !== input.customerId) return refused('request not found');
    if (p.state !== 'DRAFT') return refused('this request is past the payment step');
    const [rev] = await liveRevisions(tx, p.id);
    if (!rev) return refused('nothing to pay for');
    if (rev.quote.chargeCents <= 0) return refused('nothing to pay');
    const orders = await tx.select().from(s.paypalOrders).where(eq(s.paypalOrders.proposalId, p.id)).orderBy(desc(s.paypalOrders.id));
    const usable = orders.find((o) => o.status === 'created' || o.status === 'approved' || o.status === 'authorized');
    return { proposal: p, revision: rev, usable, attempt: orders.length + 1 };
  });
  if ('status' in prep) return prep;
  if (prep.usable) return { status: 'ok', orderId: prep.usable.paypalOrderId };

  const { proposal, revision } = prep;
  const created = await gateway.createOrder({
    intent: 'AUTHORIZE', amountCents: revision.quote.chargeCents, testCard: input.testCard,
    // A new id per attempt: a failed order's id would replay the failed order.
    requestId: `order:${compactId(proposal.id)}:${compactId(revision.id)}:${compactId(input.customerId)}:${prep.attempt}`,
    description: `MakeRoom: ${revision.quote.lines.map((l) => l.label).join(', ')}`,
  });
  if (!created.ok) return { status: 'payment_failed', error: created.error };

  await withShopLock(db, shopId, async (tx) => {
    await tx
      .insert(s.paypalOrders)
      .values({
        shopId, proposalId: proposal.id, revisionId: revision.id, customerId: input.customerId, paypalOrderId: created.orderId,
        intent: 'AUTHORIZE', amountCents: revision.quote.chargeCents,
        authorizationId: created.authorizationId, status: created.authorizationId ? 'authorized' : 'created',
      })
      .onConflictDoNothing({ target: s.paypalOrders.paypalOrderId });
    await logActivity(tx, {
      shopId, at: (await loadSnapshot(tx, shopId)).now, actor: 'system', kind: 'payment_order_created', proposalId: proposal.id, revisionId: revision.id,
      payload: { orderId: created.orderId, customerId: input.customerId, amountCents: revision.quote.chargeCents, authorizedOnCreate: !!created.authorizationId },
    });
  });
  return { status: 'ok', orderId: created.orderId };
}

// ---------------------------------------------------------------------------------------------------------
// 3. The requester accepts (and authorizes)

export type AcceptResult =
  | { status: 'awaiting_approvals'; proposalId: string; offers: { customerId: string; revisionIds: string[] }[] }
  | { status: 'already_accepted' }
  | { status: 'payment_failed'; error: string }
  | { status: 'expired' | 'stale' | 'claims_failed'; reason: string }
  | Settled
  | Refused;

export async function requesterAccept(db: Db, gateway: PaymentGateway, shopId: string, input: { proposalId: string; customerId: string }): Promise<AcceptResult> {
  // a) Authorize the buyer-approved order, if the button hasn't been authorized yet. Recorded, then called.
  const prep = await withShopLock(db, shopId, async (tx): Promise<AcceptResult | { opId: string | null }> => {
    const p = await getProposal(tx, shopId, input.proposalId);
    if (!p || p.requesterCustomerId !== input.customerId) return refused('request not found');
    if (p.state !== 'DRAFT') return (await requesterApproved(tx, p.id)) ? { status: 'already_accepted' } : refused(`request is ${p.state}`);
    const [rev] = await liveRevisions(tx, p.id);
    if (!rev) return refused('nothing to accept');
    if (rev.quote.chargeCents <= 0) return { opId: null };
    const order = await currentOrder(tx, p.id);
    if (!order) return refused('payment not started');
    if (order.status === 'authorized') return { opId: null };
    if (order.status !== 'created' && order.status !== 'approved') return refused(`payment is ${order.status}`);
    const now = (await loadSnapshot(tx, shopId)).now;
    return {
      opId: await enqueueOp(tx, { order, kind: 'authorize', amountCents: order.amountCents, proposalId: p.id, revisionId: order.revisionId, customerId: order.customerId, at: now }),
    };
  });
  if (!('opId' in prep)) return prep;
  if (prep.opId) {
    const op = await runPaymentOp(db, gateway, prep.opId);
    if (op.status !== 'succeeded') return { status: 'payment_failed', error: op.lastError ?? 'authorization failed' };
  }

  // b) In the lock: revalidate, record the approval, take claims, open the offers.
  const locked = await withShopLock(db, shopId, async (tx) => {
    const p = (await getProposal(tx, shopId, input.proposalId))!;
    if (p.state !== 'DRAFT') return { result: { status: 'already_accepted' } as AcceptResult, ops: [] as string[] };
    const snapshot = await loadSnapshot(tx, shopId, { proposalId: p.id });
    const idx = indexSnapshot(snapshot);
    const now = snapshot.now;
    if (p.expiresAt && now >= p.expiresAt) {
      const ended = await endProposal(tx, p, 'expire', 'The offer expired before it was accepted', now);
      return { result: { status: 'expired', reason: 'the offer expired' } as AcceptResult, ops: ended.opIds };
    }

    const revs = await liveRevisions(tx, p.id);
    const rows = await changesByRevision(tx, revs.map((r) => r.id));
    const valid = revs.filter((r) => isStillValid(idx, p, rows.get(r.id)!));
    const invalid = revs.filter((r) => !valid.includes(r));
    if (invalid.length) await tx.update(s.revisions).set({ status: 'dropped' }).where(inArray(s.revisions.id, invalid.map((r) => r.id)));
    if (!valid.length) {
      const ended = await endProposal(tx, p, 'expire', 'The schedule changed before the offer went out', now);
      return { result: { status: 'stale', reason: 'the schedule changed; nothing was charged' } as AcceptResult, ops: ended.opIds };
    }
    if (valid[0]!.quote.chargeCents > 0 && (await currentOrder(tx, p.id))?.status !== 'authorized')
      return { result: refused('payment not authorized') as AcceptResult, ops: [] };

    await tx
      .update(s.approvals)
      .set({ status: 'approved', source: 'card_click', respondedAt: now })
      .where(and(
        eq(s.approvals.proposalId, p.id), eq(s.approvals.role, 'requester'), eq(s.approvals.status, 'pending'),
        inArray(s.approvals.revisionId, valid.map((r) => r.id)),
      ));

    // Claims before anyone else is contacted. A conflict means another request got there first.
    try {
      await tx.transaction(async (sp) => {
        for (const r of valid) await placeClaims(sp, p, r.id, rows.get(r.id)!);
      });
    } catch (e) {
      if (pgCode(e) !== '23P01') throw e;
      const ended = await endProposal(tx, p, 'expire', 'Someone else is mid-request for this equipment; try again in a few minutes', now);
      return { result: { status: 'claims_failed', reason: 'someone else is mid-request for this equipment; try again in a few minutes' } as AcceptResult, ops: ended.opIds };
    }

    const t = transition(p.state, 'offer');
    if (!t.ok) throw new Error(t.reason);
    const expiresAt = new Date(now.getTime() + snapshot.shop.policy.approval_timeout_minutes * 60_000);
    await tx.update(s.proposals).set({ state: t.to, expiresAt, version: sql`${s.proposals.version} + 1` }).where(eq(s.proposals.id, p.id));

    await logActivity(tx, { shopId, at: now, actor: `customer:${input.customerId}`, kind: 'requester_accepted', proposalId: p.id, payload: { revisionIds: valid.map((r) => r.id) } });
    const offers = await openOffers(tx, idx, p, valid, rows, now, expiresAt);

    // Nobody else to ask (the request fits as is, or only same-model swaps): straight to capture.
    if (valid.length === 1 && (await allApproved(tx, valid[0]!))) {
      const captureOpId = await startCapture(tx, { ...p, state: t.to }, valid[0]!, now);
      return { result: null, ops: [], capture: { captureOpId } };
    }
    return {
      result: { status: 'awaiting_approvals', proposalId: p.id, offers: [...offers].map(([customerId, revisionIds]) => ({ customerId, revisionIds })) } as AcceptResult,
      ops: [],
    };
  });
  await runOps(db, gateway, locked.ops);
  if ('capture' in locked && locked.capture) return captureAndCommit(db, gateway, shopId, input.proposalId, locked.capture.captureOpId);
  return locked.result!;
}

// ---------------------------------------------------------------------------------------------------------
// 4. An affected party picks an option

export type DecisionResult =
  | { status: 'awaiting_approvals'; waitingOn: ('owner' | 'affected' | 'requester')[] }
  | { status: 'already_decided' }
  | { status: 'rejected' }
  | { status: 'stale'; reason: string }
  | Settled
  | Refused;

export async function affectedAccept(
  db: Db, gateway: PaymentGateway, shopId: string, input: { proposalId: string; customerId: string; revisionId: string },
): Promise<DecisionResult> {
  const locked = await withShopLock(db, shopId, async (tx) => {
    const p = await getProposal(tx, shopId, input.proposalId);
    if (!p) return { result: refused('request not found') };
    const [approval] = await tx
      .select()
      .from(s.approvals)
      .where(and(eq(s.approvals.revisionId, input.revisionId), eq(s.approvals.role, 'affected'), eq(s.approvals.customerId, input.customerId)));
    if (!approval) return { result: refused('no decision is pending for you on this offer') };
    if (approval.status === 'approved') return { result: { status: 'already_decided' } as DecisionResult };
    if (p.state !== 'AWAITING_APPROVALS') return { result: refused(`this request is ${p.state}`) };

    const snapshot = await loadSnapshot(tx, shopId, { proposalId: p.id });
    const idx = indexSnapshot(snapshot);
    const now = snapshot.now;
    const expired = await expireIfDue(tx, p, now);
    if (expired) return { result: { status: 'stale', reason: 'the offer expired' } as DecisionResult, ops: expired };

    const [rev] = await tx.select().from(s.revisions).where(and(eq(s.revisions.id, input.revisionId), eq(s.revisions.proposalId, p.id)));
    if (!rev || !(LIVE_REVISION_STATUSES as readonly string[]).includes(rev.status)) return { result: refused('this option is no longer available') };
    if (rev.envelopeTrips.length && !(await ownerApproved(tx, rev.id))) return { result: refused('this option is waiting for the shop') };
    const rows = (await changesByRevision(tx, [rev.id])).get(rev.id)!;
    if (!isStillValid(idx, p, rows)) return { result: { status: 'stale', reason: 'the schedule changed; this option no longer works' } as DecisionResult };

    await tx.update(s.approvals).set({ status: 'approved', source: 'card_click', respondedAt: now }).where(eq(s.approvals.id, approval.id));
    await dropUnsentCounters(tx, p.id, input.customerId);
    // A pick that still needs the shop isn't final: the other options stay open in case the owner declines
    // this one (judge B8). Otherwise the pick supersedes them now.
    if (!rev.needsOwner || (await ownerApproved(tx, rev.id))) await selectRevision(tx, p, rev, now);
    await logActivity(tx, {
      shopId, at: now, actor: `customer:${input.customerId}`, kind: 'affected_accepted', proposalId: p.id, revisionId: rev.id,
      payload: { option: rev.optionLabel },
    });
    if (rev.needsOwner) await ensureOwnerApproval(tx, idx, p, rev, rows, 'approval', now);

    if (await allApproved(tx, rev)) return { capture: { captureOpId: await startCapture(tx, p, rev, now) } };
    return { result: { status: 'awaiting_approvals', waitingOn: await waitingOn(tx, rev) } as DecisionResult };
  });
  await runOps(db, gateway, locked.ops ?? []);
  if (locked.capture) return captureAndCommit(db, gateway, shopId, input.proposalId, locked.capture.captureOpId);
  return locked.result!;
}

// ---------------------------------------------------------------------------------------------------------
// 4b. An affected party keeps their booking as is (docs/conflict-model.md §7, demo Scenario 3)

export type RefuseResult =
  | {
      status: 'kept';
      /** What the request does next: other options still open, a fallback plan to someone else, the closest
       * alternative back to the requester, or nothing (ended, hold released). */
      next: 'other_options' | 'fallback' | 'alternative' | 'ended';
    }
  | { status: 'already_decided' }
  | { status: 'stale'; reason: string }
  | Settled
  | Refused;

/**
 * "Keep my booking as is": every option that changes this customer's booking is dropped and they're excluded from
 * approval-needing changes for the rest of the request. A pick they made earlier is withdrawn the same way (judge
 * B5). Their booking is never touched. The backend then re-plans (`planFallback`).
 */
export async function affectedRefuse(
  db: Db, gateway: PaymentGateway, shopId: string, input: { proposalId: string; customerId: string },
): Promise<RefuseResult> {
  const locked = await withShopLock(db, shopId, async (tx): Promise<{ result?: RefuseResult; ops?: string[]; capture?: { captureOpId: string | null } }> => {
    const p = await getProposal(tx, shopId, input.proposalId);
    if (!p) return { result: refused('request not found') };
    const [excluded] = await tx.select().from(s.proposalExclusions).where(and(eq(s.proposalExclusions.proposalId, p.id), eq(s.proposalExclusions.customerId, input.customerId)));
    if (excluded) return { result: { status: 'already_decided' } };
    if (p.state === 'CAPTURING') return { result: refused('too late: the request is being confirmed right now') };
    if (p.state !== 'AWAITING_APPROVALS') return { result: refused(`this request is ${p.state}`) };

    const now = (await loadSnapshot(tx, shopId)).now;
    const expired = await expireIfDue(tx, p, now);
    if (expired) return { result: { status: 'stale', reason: 'the offer expired; your booking stays as it is' }, ops: expired };

    const live = await liveRevisions(tx, p.id);
    const mine = live.length
      ? await tx.select().from(s.approvals).where(and(
          inArray(s.approvals.revisionId, live.map((r) => r.id)), eq(s.approvals.role, 'affected'), eq(s.approvals.customerId, input.customerId),
        ))
      : [];
    if (!mine.length) return { result: refused('no decision is pending for you on this offer') };

    await tx
      .update(s.approvals)
      .set({ status: 'rejected', refusal: true, source: 'card_click', respondedAt: now })
      .where(inArray(s.approvals.id, mine.map((a) => a.id)));
    await tx.insert(s.proposalExclusions).values({ shopId, proposalId: p.id, customerId: input.customerId, reason: 'kept their booking as is' }).onConflictDoNothing();
    await dropUnsentCounters(tx, p.id, input.customerId);
    const dropped = live.filter((r) => mine.some((a) => a.revisionId === r.id));
    await dropRevisions(tx, p, dropped.map((r) => r.id), now);
    await logActivity(tx, {
      shopId, at: now, actor: `customer:${input.customerId}`, kind: 'affected_refused', proposalId: p.id,
      payload: { customerId: input.customerId, revisionIds: dropped.map((r) => r.id), withdrew: mine.some((a) => a.status === 'approved') },
    });

    // Options that don't touch this customer are still open (rare: options normally all ask the same party).
    const remaining = live.filter((r) => !dropped.includes(r));
    if (remaining.length) {
      await reofferPending(tx, p, remaining, now);
      if (remaining.length === 1 && (await allApproved(tx, remaining[0]!))) return { capture: { captureOpId: await startCapture(tx, p, remaining[0]!, now) } };
      return { result: { status: 'kept', next: 'other_options' } };
    }
    return planFallback(tx, p, now);
  });
  await runOps(db, gateway, locked.ops ?? []);
  if (locked.capture) return captureAndCommit(db, gateway, shopId, input.proposalId, locked.capture.captureOpId);
  return locked.result!;
}

/**
 * After a refusal left nothing to offer: re-plan around everyone who refused (they're excluded now). Up to
 * `max_fallback_plans` new plans with the requester's terms unchanged go out as new revisions, the requester's
 * approval and hold carrying over. After that, the requester gets the closest alternative ("no, but here's what I
 * can do"), or the request ends and the hold is released. The requester never pays more than they authorized.
 */
async function planFallback(tx: Tx, p: Proposal, now: Date): Promise<{ result?: RefuseResult; ops?: string[]; capture?: { captureOpId: string | null } }> {
  const snapshot = await loadSnapshot(tx, p.shopId, { proposalId: p.id });
  const idx = indexSnapshot(snapshot);
  const policy = snapshot.shop.policy;
  const request = loadRequest(p.request as StoredRequest);
  const order = await currentOrder(tx, p.id);
  const heldCents = order?.status === 'authorized' ? order.amountCents : 0;
  const [before] = await tx
    .select()
    .from(s.revisions)
    .where(and(eq(s.revisions.proposalId, p.id), inArray(s.revisions.status, ['dropped', 'superseded'])))
    .orderBy(desc(s.revisions.seq));
  const beforeRows = before ? (await changesByRevision(tx, [before.id])).get(before.id)! : [];
  // The change the request is about (an overdue request has no requester, only the late booking).
  const was = beforeRows.find((c) => c.bookingId === p.subjectBookingId);
  const sameForRequester = (plan: Plan) =>
    !!was && plan.quote.chargeCents === before!.quote.chargeCents && placementKey(plan.changes.find((c) => c.isRequester)!.after) === placementKey(afterOf(was));

  const result = optimize(snapshot, request);
  const plans = result.status === 'fits' || result.status === 'needs_other_changes' ? result.plans : [];
  await logActivity(tx, {
    shopId: p.shopId, at: now, actor: 'system', kind: 'optimizer_run', proposalId: p.id,
    payload: {
      request: storeRequest(request), source: 'fallback', status: result.status, excluded: snapshot.excludedCustomerIds,
      plans: plans.map(planSummary),
      pruned: result.status === 'invalid_request' ? [] : result.pruned.map((x) => ({ message: x.message, rules: x.rules, bookingId: x.bookingId })),
    },
  });
  const seq = p.revisionSeq + 1;
  const expiresAt = new Date(now.getTime() + policy.approval_timeout_minutes * 60_000);

  // 1. A fallback plan: same terms for the requester, so their approval and hold carry over.
  const fallbacks = p.fallbackPlansUsed < policy.max_fallback_plans ? chooseOptions(plans.filter(sameForRequester)) : [];
  if (fallbacks.length) {
    const ok = await tx.transaction(async (sp) => {
      const revs: Revision[] = [];
      const rows = new Map<string, RevisionChange[]>();
      for (const [i, plan] of fallbacks.entries()) {
        const { revision, changes } = await insertRevision(sp, {
          proposal: p, seq, optionLabel: fallbacks.length > 1 ? (['A', 'B'] as const)[i]! : null, plan, origin: 'fallback', at: now,
        });
        revs.push(revision);
        rows.set(revision.id, changes);
        await placeClaims(sp, p, revision.id, changes);
      }
      return { revs, rows };
    }).catch((e) => {
      // Another request holds capacity this plan needs: it is never offered (docs/conflict-model.md §6).
      if (pgCode(e) !== '23P01') throw e;
      return null;
    });
    if (ok) {
      // An overdue request has no requester whose approval could carry over.
      if (p.requesterCustomerId) {
        const [carried] = await tx.select().from(s.approvals).where(and(eq(s.approvals.proposalId, p.id), eq(s.approvals.role, 'requester'), eq(s.approvals.status, 'approved')));
        await tx.insert(s.approvals).values(ok.revs.map((r) => ({
          shopId: p.shopId, revisionId: r.id, proposalId: p.id, role: 'requester' as const, customerId: p.requesterCustomerId,
          status: 'approved' as const, source: 'carried_over' as const, carriedFromId: carried?.id ?? null, requestedAt: now, respondedAt: now,
        })));
      }
      await tx
        .update(s.proposals)
        .set({ revisionSeq: seq, fallbackPlansUsed: p.fallbackPlansUsed + 1, expiresAt, version: sql`${s.proposals.version} + 1` })
        .where(eq(s.proposals.id, p.id));
      await logActivity(tx, {
        shopId: p.shopId, at: now, actor: 'system', kind: 'fallback_planned', proposalId: p.id,
        payload: { revisions: ok.revs.map((r) => ({ id: r.id, option: r.optionLabel, needsOwner: r.needsOwner, quote: r.quote })) },
      });
      await openOffers(tx, idx, p, ok.revs, ok.rows, now, expiresAt);
      // Nobody left to ask (only notice-only swaps): straight to capture.
      if (ok.revs.length === 1 && (await allApproved(tx, ok.revs[0]!))) return { capture: { captureOpId: await startCapture(tx, p, ok.revs[0]!, now) } };
      return { result: { status: 'kept', next: 'fallback' } };
    }
  }

  // 2. The closest alternative, back to the requester to accept again. Never more than they already authorized.
  const nearest = nearestAlternative(snapshot, request);
  if (nearest && p.requesterCustomerId && nearest.quote.chargeCents <= heldCents) {
    const t = transition(p.state, 'new_revision');
    if (!t.ok) throw new Error(t.reason);
    const { revision, changes } = await insertRevision(tx, { proposal: p, seq, optionLabel: null, plan: nearest, origin: 'alternative', at: now });
    await tx.insert(s.approvals).values({
      shopId: p.shopId, revisionId: revision.id, proposalId: p.id, role: 'requester', customerId: p.requesterCustomerId, requestedAt: now, expiresAt,
    });
    if (revision.needsOwner) await ensureOwnerApproval(tx, idx, p, revision, changes, 'plan_review', now);
    // Nothing to pay: release the hold now rather than leave it waiting on their answer.
    const ops: string[] = [];
    if (nearest.quote.chargeCents === 0 && order) {
      const id = await enqueueVoid(tx, order, now);
      if (id) ops.push(id);
    }
    await tx.update(s.proposals).set({ state: t.to, revisionSeq: seq, expiresAt, version: sql`${s.proposals.version} + 1` }).where(eq(s.proposals.id, p.id));
    await logActivity(tx, {
      shopId: p.shopId, at: now, actor: 'system', kind: 'alternative_offered', proposalId: p.id, revisionId: revision.id,
      payload: { quote: revision.quote, holdReleased: ops.length > 0 },
    });
    await offerToRequesterIfReviewed(tx, { ...p, state: t.to }, now, { fallback: true, holdReleased: ops.length > 0 });
    return { result: { status: 'kept', next: 'alternative' }, ops };
  }

  // 3. Nothing works: the request ends, the hold is released, every booking stays as it was.
  const ended = await endProposal(tx, p, 'reject', 'The other customer kept their booking, and nothing else fits', now);
  return { result: { status: 'kept', next: 'ended' }, ops: ended.opIds };
}

// ---------------------------------------------------------------------------------------------------------
// 4b2. An affected party counters (docs/conflict-model.md §4, §7; judge B1–B4)

export type CounterResult =
  | { status: 'drafted'; revision: Revision; changes: RevisionChange[] }
  | { status: 'invalid'; violations: Violation[] }
  /** It can't work; the schedule is untouched. `nearestStart`: the closest later pickup that would. */
  | { status: 'infeasible'; violations: Violation[]; nearestStart: Date | null }
  | { status: 'revision_limit' }
  | { status: 'no_change' }
  | Refused;

const REQUEST_RULES = new Set(['outside_shop_hours', 'in_past', 'bad_duration']);

/**
 * The customer's own terms on an offer, from what they said in chat: other times on their booking, or a different
 * refund. The result is a draft on a card with Send and Discard, which holds nothing and records nothing until they
 * click (invariant 3). The requester's terms never change here, so their approval and hold carry over.
 */
export function affectedCounter(
  db: Db, shopId: string,
  input: { proposalId: string; customerId: string; baseRevisionId?: string; newStartsAt?: Date; newEndsAt?: Date; refundCents?: number },
): Promise<CounterResult> {
  return withShopLock(db, shopId, async (tx): Promise<CounterResult> => {
    const p = await getProposal(tx, shopId, input.proposalId);
    if (!p) return refused('request not found');
    if (p.requesterCustomerId === input.customerId) return refused('this is your own request');
    if (p.state !== 'AWAITING_APPROVALS') return refused(`this request is ${p.state}`);
    const snapshot = await loadSnapshot(tx, shopId, { proposalId: p.id });
    if (p.expiresAt && snapshot.now >= p.expiresAt) return refused('the offer has expired');

    const live = await liveRevisions(tx, p.id);
    const mine = live.length
      ? await tx.select().from(s.approvals).where(and(inArray(s.approvals.revisionId, live.map((r) => r.id)), eq(s.approvals.role, 'affected'), eq(s.approvals.customerId, input.customerId)))
      : [];
    if (!mine.length) return refused('no decision is pending for you on this offer');
    const rows = await changesByRevision(tx, mine.map((a) => a.revisionId));
    const candidates = live.filter((r) => rows.has(r.id));
    const movesTime = !!(input.newStartsAt || input.newEndsAt);
    const base = input.baseRevisionId
      ? candidates.find((r) => r.id === input.baseRevisionId)
      // New times build on the option that already moves their times, not on a switch to another model.
      : (movesTime && candidates.find((r) => rows.get(r.id)!.some((c) => c.partyCustomerId === input.customerId && c.kind === 'time_shift'))) || candidates[0];
    if (!base) return refused('that option is no longer available');
    const baseRows = rows.get(base.id)!;
    const own = baseRows.find((c) => c.partyCustomerId === input.customerId)!;
    const was = afterOf(own);

    const startsAt = input.newStartsAt ?? was.startsAt;
    const endsAt = input.newEndsAt ?? was.endsAt;
    const refund = input.refundCents;
    const sameRefund = refund === undefined || refund === base.quote.compensation.filter((x) => x.customerId === input.customerId && x.kind === 'refund').reduce((sum, x) => sum + x.cents, 0);
    if (startsAt.getTime() === was.startsAt.getTime() && endsAt.getTime() === was.endsAt.getTime() && sameRefund) return { status: 'no_change' };
    if (p.revisionSeq >= snapshot.shop.policy.max_revisions) return { status: 'revision_limit' };

    const first = (c: RevisionChange) => (p.requesterCustomerId ? c.partyCustomerId === p.requesterCustomerId : c.bookingId === p.subjectBookingId);
    const lead = baseRows.find(first)!;
    const requesterCustomerId = lead.partyCustomerId;
    const planFor = (start: Date) =>
      planCounter(snapshot, {
        changes: [lead, ...baseRows.filter((c) => c !== lead)].map((c) => ({
          bookingId: c.bookingId, customerId: c.partyCustomerId,
          after: c === own ? { ...was, startsAt: start, endsAt, bufferEndsAt: new Date(endsAt.getTime() + (was.bufferEndsAt.getTime() - was.endsAt.getTime())) } : afterOf(c),
        })),
        requesterCustomerId, requesterPays: !!p.requesterCustomerId,
        counterRefund: refund === undefined ? undefined : { customerId: input.customerId, cents: refund },
      });

    const counter = planFor(startsAt);
    if ('violations' in counter) {
      if (counter.violations.some((v) => REQUEST_RULES.has(v.rule))) return { status: 'invalid', violations: counter.violations };
      return { status: 'infeasible', violations: counter.violations, nearestStart: input.newStartsAt ? nearestStart(planFor, startsAt, endsAt) : null };
    }

    await dropUnsentCounters(tx, p.id, input.customerId);
    const seq = p.revisionSeq + 1;
    const { revision, changes } = await insertRevision(tx, {
      proposal: p, seq, optionLabel: null, plan: counter.plan, origin: 'counter', at: snapshot.now,
      counter: { customerId: input.customerId, parentRevisionId: base.id },
    });
    await tx.update(s.proposals).set({ revisionSeq: seq, version: sql`${s.proposals.version} + 1` }).where(eq(s.proposals.id, p.id));
    await logActivity(tx, {
      shopId, at: snapshot.now, actor: `customer:${input.customerId}`, kind: 'counter_drafted', proposalId: p.id, revisionId: revision.id,
      payload: { customerId: input.customerId, quote: revision.quote, needsOwner: revision.needsOwner, ownerTriggers: revision.ownerTriggers, envelopeTrips: revision.envelopeTrips },
    });
    return { status: 'drafted', revision, changes };
  });
}

/** The closest later quarter-hour pickup that works ("noon?" → 2pm), if any before they'd have to bring it back. */
function nearestStart(planFor: (start: Date) => { plan: Plan } | { violations: Violation[] }, asked: Date, endsAt: Date) {
  const QUARTER = 15 * 60_000;
  for (let t = asked.getTime() + QUARTER; t < endsAt.getTime(); t += QUARTER) if ('plan' in planFor(new Date(t))) return new Date(t);
  return null;
}

async function dropUnsentCounters(tx: Tx, proposalId: string, customerId: string) {
  await tx.update(s.revisions).set({ status: 'dropped' })
    .where(and(eq(s.revisions.proposalId, proposalId), eq(s.revisions.status, 'draft'), eq(s.revisions.createdByCustomerId, customerId)));
}

/**
 * Send: the click that makes a counter the customer's approval. Other parties' approvals carry over, since their terms
 * didn't change. If it needs the shop, the original options stay open in case the owner declines (judge B8).
 */
export async function counterSend(db: Db, gateway: PaymentGateway, shopId: string, input: { proposalId: string; customerId: string; revisionId: string }): Promise<DecisionResult> {
  const locked = await withShopLock(db, shopId, async (tx): Promise<{ result?: DecisionResult; ops?: string[]; capture?: { captureOpId: string | null } }> => {
    const p = await getProposal(tx, shopId, input.proposalId);
    if (!p) return { result: refused('request not found') };
    const [rev] = await tx.select().from(s.revisions).where(and(eq(s.revisions.id, input.revisionId), eq(s.revisions.proposalId, p.id)));
    if (!rev || rev.createdByCustomerId !== input.customerId) return { result: refused('this counter-offer isn’t yours') };
    if (rev.status !== 'draft') return { result: { status: 'already_decided' } };
    if (p.state !== 'AWAITING_APPROVALS') return { result: refused(`this request is ${p.state}`) };

    const snapshot = await loadSnapshot(tx, shopId, { proposalId: p.id });
    const idx = indexSnapshot(snapshot);
    const now = snapshot.now;
    const expired = await expireIfDue(tx, p, now);
    if (expired) return { result: { status: 'stale', reason: 'the offer expired' }, ops: expired };
    const parent = (await liveRevisions(tx, p.id)).find((r) => r.id === rev.parentRevisionId);
    const rows = (await changesByRevision(tx, [rev.id])).get(rev.id)!;
    if (!parent || !isStillValid(idx, p, rows)) {
      await tx.update(s.revisions).set({ status: 'dropped' }).where(eq(s.revisions.id, rev.id));
      return { result: { status: 'stale', reason: 'the request changed; this counter-offer no longer applies' } };
    }

    const claimed = await tx.transaction(async (sp) => placeClaims(sp, p, rev.id, rows)).then(() => true).catch((e) => {
      if (pgCode(e) !== '23P01') throw e;
      return false;
    });
    if (!claimed) {
      await tx.update(s.revisions).set({ status: 'dropped' }).where(eq(s.revisions.id, rev.id));
      return { result: { status: 'stale', reason: 'another request is holding that time' } };
    }

    const parentApprovals = await tx.select().from(s.approvals).where(eq(s.approvals.revisionId, parent.id));
    await tx.insert(s.approvals).values([
      { shopId, revisionId: rev.id, proposalId: p.id, role: 'affected' as const, customerId: input.customerId, status: 'approved' as const, source: 'counter_author' as const, requestedAt: now, respondedAt: now },
      ...parentApprovals.filter((a) => a.role !== 'owner' && a.customerId !== input.customerId).map((a) => ({
        shopId, revisionId: rev.id, proposalId: p.id, role: a.role, customerId: a.customerId, status: a.status,
        ...(a.status === 'approved' ? { source: 'carried_over' as const, carriedFromId: a.id, respondedAt: now } : {}),
        requestedAt: now,
      })),
    ]);
    await tx.update(s.revisions).set({ status: 'offered' }).where(eq(s.revisions.id, rev.id));
    const sent = { ...rev, status: 'offered' as const };

    // Their counter replaces an earlier pick: it shouldn't go ahead behind it.
    const others = (await liveRevisions(tx, p.id)).filter((r) => r.id !== rev.id);
    if (others.length) {
      await tx.update(s.approvals).set({ status: 'pending', source: null, respondedAt: null })
        .where(and(inArray(s.approvals.revisionId, others.map((r) => r.id)), eq(s.approvals.customerId, input.customerId), eq(s.approvals.status, 'approved')));
      await tx.update(s.escalations).set({ status: 'resolved', resolution: { superseded: true } })
        .where(and(inArray(s.escalations.revisionId, others.map((r) => r.id)), eq(s.escalations.status, 'open')));
    }

    const expiresAt = new Date(now.getTime() + snapshot.shop.policy.approval_timeout_minutes * 60_000);
    await tx.update(s.proposals).set({ expiresAt, version: sql`${s.proposals.version} + 1` }).where(eq(s.proposals.id, p.id));
    await logActivity(tx, {
      shopId, at: now, actor: `customer:${input.customerId}`, kind: 'counter_sent', proposalId: p.id, revisionId: rev.id,
      payload: { customerId: input.customerId, needsOwner: rev.needsOwner },
    });
    if (rev.needsOwner) await ensureOwnerApproval(tx, idx, p, sent, rows, 'approval', now);
    else await selectRevision(tx, p, sent, now);

    if (await allApproved(tx, sent)) return { capture: { captureOpId: await startCapture(tx, p, sent, now) } };
    await reofferPending(tx, p, [sent], now);
    return { result: { status: 'awaiting_approvals', waitingOn: await waitingOn(tx, sent) } };
  });
  await runOps(db, gateway, locked.ops ?? []);
  if (locked.capture) return captureAndCommit(db, gateway, shopId, input.proposalId, locked.capture.captureOpId);
  return locked.result!;
}

/** Discard: their original offer is still open, as if they'd never countered. */
export function counterDiscard(db: Db, shopId: string, input: { proposalId: string; customerId: string; revisionId: string }): Promise<{ status: 'discarded' } | Refused> {
  return withShopLock(db, shopId, async (tx) => {
    const [rev] = await tx.select().from(s.revisions).where(and(eq(s.revisions.id, input.revisionId), eq(s.revisions.proposalId, input.proposalId), eq(s.revisions.shopId, shopId)));
    if (!rev || rev.createdByCustomerId !== input.customerId) return refused('this counter-offer isn’t yours');
    if (rev.status !== 'draft') return refused('this counter-offer has already been sent or replaced');
    await tx.update(s.revisions).set({ status: 'dropped' }).where(eq(s.revisions.id, rev.id));
    await logActivity(tx, {
      shopId, at: (await loadSnapshot(tx, shopId)).now, actor: `customer:${input.customerId}`, kind: 'counter_discarded', proposalId: input.proposalId, revisionId: rev.id,
      payload: { customerId: input.customerId },
    });
    return { status: 'discarded' as const };
  });
}

// ---------------------------------------------------------------------------------------------------------
// 4c. The requester cancels their own request (docs/conflict-model.md §4 withdrawal, §7)

/** Before capture the requester can always back out: `REJECTED`, hold voided, claims released, bookings untouched. */
export async function requesterCancel(db: Db, gateway: PaymentGateway, shopId: string, input: { proposalId: string; customerId: string }): Promise<{ status: 'rejected' } | Refused> {
  const locked = await withShopLock(db, shopId, async (tx) => {
    const p = await getProposal(tx, shopId, input.proposalId);
    if (!p || p.requesterCustomerId !== input.customerId) return { result: refused('request not found'), ops: [] };
    if (p.state === 'CAPTURING') return { result: refused('too late: the request is being confirmed right now'), ops: [] };
    if (p.state !== 'DRAFT' && p.state !== 'AWAITING_APPROVALS') return { result: refused(`this request is ${p.state}`), ops: [] };
    const now = (await loadSnapshot(tx, shopId)).now;
    const ended = await endProposal(tx, p, 'reject', 'The customer cancelled the request', now, `customer:${input.customerId}`);
    return { result: { status: 'rejected' as const }, ops: ended.opIds };
  });
  await runOps(db, gateway, locked.ops);
  return locked.result;
}

// ---------------------------------------------------------------------------------------------------------
// 5. The owner approves or declines

/** A fact the owner just answered on a plan card; the card then offers "Save as fact?" (demo Scenario 2, step 4). */
export type SaveableFact = { factId: string; value: 'yes' | 'no'; label: string };

export async function ownerDecision(
  db: Db,
  gateway: PaymentGateway,
  shopId: string,
  input: {
    proposalId: string;
    revisionId: string;
    decision: 'approve' | 'decline';
    /** Answers to the plan's unknown facts, by fact id. A "no" declines the plan. */
    factAnswers?: Record<string, 'yes' | 'no'>;
  },
): Promise<DecisionResult & { saveableFacts?: SaveableFact[] }> {
  const locked = await withShopLock(db, shopId, async (tx) => {
    const p = await getProposal(tx, shopId, input.proposalId);
    if (!p) return { result: refused('request not found') };
    const [approval] = await tx.select().from(s.approvals).where(and(eq(s.approvals.revisionId, input.revisionId), eq(s.approvals.role, 'owner')));
    if (!approval) return { result: refused('nothing is waiting for the shop on this offer') };
    if (approval.status !== 'pending') return { result: { status: 'already_decided' } as DecisionResult };
    // The owner reviews an owner-resolved plan while it is still a draft, before the requester pays.
    if (p.state !== 'AWAITING_APPROVALS' && p.state !== 'DRAFT') return { result: refused(`this request is ${p.state}`) };

    const snapshot = await loadSnapshot(tx, shopId, { proposalId: p.id });
    const idx = indexSnapshot(snapshot);
    const now = snapshot.now;
    const expired = await expireIfDue(tx, p, now);
    if (expired) return { result: { status: 'stale', reason: 'the offer expired' } as DecisionResult, ops: expired };
    const [rev] = await tx.select().from(s.revisions).where(eq(s.revisions.id, input.revisionId));
    const rows = (await changesByRevision(tx, [rev!.id])).get(rev!.id)!;

    // The plan's unknown facts must be answered to approve it; a "no" means it can't work.
    const unknownFacts = rev!.factDependencies.length
      ? (await tx.select().from(s.facts).where(inArray(s.facts.id, rev!.factDependencies))).filter((f) => f.value !== 'yes')
      : [];
    const answers = input.factAnswers ?? {};
    if (input.decision === 'approve' && unknownFacts.some((f) => !answers[f.id]))
      return { result: refused('answer the fact question on the card first') };
    const saveableFacts: SaveableFact[] = unknownFacts
      .filter((f) => answers[f.id])
      .map((f) => ({ factId: f.id, value: answers[f.id]!, label: f.label ?? f.key }));
    const approve = input.decision === 'approve' && !unknownFacts.some((f) => answers[f.id] === 'no');

    await tx
      .update(s.approvals)
      .set({ status: approve ? 'approved' : 'rejected', source: 'card_click', respondedAt: now })
      .where(eq(s.approvals.id, approval.id));
    await tx
      .update(s.escalations)
      .set({ status: 'resolved', resolution: { decision: approve ? 'approve' : 'decline', factAnswers: answers } })
      .where(and(eq(s.escalations.revisionId, rev!.id), eq(s.escalations.status, 'open')));
    await logActivity(tx, {
      shopId, at: now, actor: 'owner', kind: approve ? 'owner_approved' : 'owner_declined', proposalId: p.id, revisionId: rev!.id,
      payload: { factAnswers: answers },
    });

    if (p.state === 'DRAFT') {
      if (!approve) {
        await tx.update(s.revisions).set({ status: 'dropped' }).where(eq(s.revisions.id, rev!.id));
        if (!(await liveRevisions(tx, p.id)).length) {
          const ended = await endProposal(tx, p, 'reject', 'The shop declined the plan', now, 'owner');
          return { result: { status: 'rejected', saveableFacts } as DecisionResult, ops: ended.opIds };
        }
      }
      await offerToRequesterIfReviewed(tx, p, now);
      return { result: { status: 'awaiting_approvals', waitingOn: ['requester'], saveableFacts } as DecisionResult };
    }

    if (!approve) {
      // Declining one option drops only that option (judge B8); declining the last one rejects the request (B9).
      await tx.update(s.revisions).set({ status: 'dropped' }).where(eq(s.revisions.id, rev!.id));
      await releaseClaims(tx, { proposalId: p.id, revisionIds: [rev!.id] }, now);
      const remaining = await liveRevisions(tx, p.id);
      if (!remaining.length) {
        const ended = await endProposal(tx, p, 'reject', 'The shop declined the request', now, 'owner');
        return { result: { status: 'rejected' } as DecisionResult, ops: ended.opIds };
      }
      await reofferPending(tx, p, remaining, now);
      return { result: { status: 'awaiting_approvals', waitingOn: ['affected'] } as DecisionResult };
    }

    if (!isStillValid(idx, p, rows)) return { result: { status: 'stale', reason: 'the schedule changed; this plan no longer works' } as DecisionResult };
    // A plan the owner had to review first can now go to the customers.
    if (rev!.envelopeTrips.length) await reofferPending(tx, p, [rev!], now);
    if (await allApproved(tx, rev!)) return { capture: { captureOpId: await startCapture(tx, p, rev!, now) }, saveableFacts };
    return { result: { status: 'awaiting_approvals', waitingOn: await waitingOn(tx, rev!), saveableFacts } as DecisionResult };
  });
  await runOps(db, gateway, locked.ops ?? []);
  if (locked.capture) return { ...(await captureAndCommit(db, gateway, shopId, input.proposalId, locked.capture.captureOpId)), saveableFacts: locked.saveableFacts };
  return locked.result!;
}

// ---------------------------------------------------------------------------------------------------------
// 5b. The owner sets the requester's price (docs/conflict-model.md §4: an owner modification is a new revision)

export type SetPriceResult = { status: 'repriced'; revisions: Revision[]; chargeCents: number } | Refused;

/**
 * Lowers what the requester pays, before they have paid: each live option becomes a new revision with the owner's
 * price, the old ones are superseded, and the requester is asked again (their money changed). The owner is the
 * one who may go past the agent's discount band, so the new price needs no further shop approval for itself.
 * Not yet: raising a price, or repricing after the requester authorized (judge C4/C5).
 */
export function ownerSetPrice(db: Db, shopId: string, input: { proposalId: string; priceCents: number }): Promise<SetPriceResult> {
  return withShopLock(db, shopId, async (tx) => {
    const p = await getProposal(tx, shopId, input.proposalId);
    if (!p) return refused('request not found');
    if (p.state !== 'DRAFT') return refused('the customer has already paid; changing the price after that isn’t supported yet');
    const orders = await tx.select().from(s.paypalOrders).where(eq(s.paypalOrders.proposalId, p.id));
    if (orders.some((o) => o.status === 'authorized' || o.status === 'captured')) return refused('the customer has already paid');
    const live = await liveRevisions(tx, p.id);
    if (!live.length) return refused('nothing to reprice');
    const listCents = live[0]!.quote.lines.reduce((sum, l) => sum + l.amountCents, 0);
    if (!Number.isInteger(input.priceCents) || input.priceCents < 0) return refused('the price must be zero or more');
    if (input.priceCents > listCents) return refused(`only lowering the price is supported for now (the rate card says $${(listCents / 100).toFixed(2)})`);
    if (input.priceCents === live[0]!.quote.chargeCents) return refused('that is already the price');

    const snapshot = await loadSnapshot(tx, shopId);
    const now = snapshot.now;
    const seq = p.revisionSeq + 1;
    const rows = await changesByRevision(tx, live.map((r) => r.id));
    const revisions: Revision[] = [];
    for (const base of live) {
      const compensation = base.quote.compensation.reduce((sum, c) => sum + c.cents, 0);
      const quote = { ...base.quote, discountCents: listCents - input.priceCents, chargeCents: input.priceCents, netRevenueCents: input.priceCents - compensation };
      // The owner set this price, so the agent's discount limit doesn't apply; a loss still shows on the card.
      const ownerTriggers = base.ownerTriggers.filter((t) => t !== 'discount_over_band' && t !== 'negative_net');
      if (quote.netRevenueCents < 0) ownerTriggers.push('negative_net');
      const revision = await cloneRevision(tx, { proposal: p, base, rows: rows.get(base.id)!, seq, quote, ownerTriggers, at: now });
      revisions.push(revision);
      // A shop review the owner already gave carries over; they set these terms themselves.
      const [review] = await tx.select().from(s.approvals).where(and(eq(s.approvals.revisionId, base.id), eq(s.approvals.role, 'owner')));
      if (review?.status === 'approved')
        await tx.insert(s.approvals).values({
          shopId, revisionId: revision.id, proposalId: p.id, role: 'owner', status: 'approved', source: 'carried_over', carriedFromId: review.id, requestedAt: now, respondedAt: now,
        });
      // The requester's money changed, so they accept again; agreement by phone (owner-attested) carries over.
      const [requester] = await tx.select().from(s.approvals).where(and(eq(s.approvals.revisionId, base.id), eq(s.approvals.role, 'requester')));
      await tx.insert(s.approvals).values({
        shopId, revisionId: revision.id, proposalId: p.id, role: 'requester', customerId: p.requesterCustomerId,
        ...(requester?.source === 'owner_attested'
          ? { status: 'approved' as const, source: 'carried_over' as const, carriedFromId: requester.id, respondedAt: now }
          : { status: 'pending' as const }),
        requestedAt: now,
      });
    }
    await tx.update(s.revisions).set({ status: 'superseded' }).where(inArray(s.revisions.id, live.map((r) => r.id)));
    await tx.update(s.escalations).set({ status: 'resolved', resolution: { superseded: true } })
      .where(and(inArray(s.escalations.revisionId, live.map((r) => r.id)), eq(s.escalations.status, 'open')));
    // An unpaid order for the old amount must not be paid: one request id means one amount.
    for (const o of orders) if (o.status === 'created' || o.status === 'approved') await tx.update(s.paypalOrders).set({ status: 'voided' }).where(eq(s.paypalOrders.id, o.id));
    await tx
      .update(s.proposals)
      .set({ revisionSeq: seq, expiresAt: new Date(now.getTime() + snapshot.shop.policy.approval_timeout_minutes * 60_000), version: sql`${s.proposals.version} + 1` })
      .where(eq(s.proposals.id, p.id));
    await logActivity(tx, {
      shopId, at: now, actor: 'owner', kind: 'owner_repriced', proposalId: p.id,
      payload: { fromCents: live[0]!.quote.chargeCents, toCents: input.priceCents, revisionIds: revisions.map((r) => r.id) },
    });
    if (p.requesterCustomerId)
      await logActivity(tx, {
        shopId, at: now, actor: 'system', kind: 'offer_ready', proposalId: p.id,
        payload: { customerId: p.requesterCustomerId, revisionIds: revisions.map((r) => r.id), role: 'requester', repriced: true },
      });
    return { status: 'repriced', revisions, chargeCents: input.priceCents };
  });
}

/**
 * Once the owner has reviewed every option of a draft that needed it, the requester gets the card to accept and
 * pay (demo Scenario 2, step 5: "Dana authorizes payment for the extra day through a PayPal link").
 */
async function offerToRequesterIfReviewed(tx: Tx, p: Proposal, now: Date, extra: { fallback?: boolean; holdReleased?: boolean; noAnswerOf?: string } = {}) {
  if (!p.requesterCustomerId) return;
  const live = await liveRevisions(tx, p.id);
  for (const r of live) if (r.needsOwner && !(await ownerApproved(tx, r.id))) return;
  // An alternative after a refusal says so when it reaches the requester, even if the owner reviewed it first.
  const fallback = extra.fallback ?? live.some((r) => r.origin === 'alternative' && r.seq > 1);
  const holdReleased = extra.holdReleased ?? (fallback && (await currentOrder(tx, p.id))?.status !== 'authorized');
  await logActivity(tx, {
    shopId: p.shopId, at: now, actor: 'system', kind: 'offer_ready', proposalId: p.id,
    payload: { customerId: p.requesterCustomerId, revisionIds: live.map((r) => r.id), role: 'requester', ...(fallback ? { fallback: true, holdReleased } : {}), ...(extra.noAnswerOf ? { noAnswerOf: extra.noAnswerOf } : {}) },
  });
}

// ---------------------------------------------------------------------------------------------------------
// 6. Capture, revalidate, commit, refund

/** In the lock: select the revision, enter CAPTURING, record the capture. From here approvals are final. */
async function startCapture(tx: Tx, p: Proposal, rev: Revision, now: Date): Promise<string | null> {
  const t = transition(p.state, 'all_approved');
  if (!t.ok) throw new Error(t.reason);
  await selectRevision(tx, p, rev, now);
  await tx.update(s.proposals).set({ state: t.to, expiresAt: null, version: sql`${s.proposals.version} + 1` }).where(eq(s.proposals.id, p.id));
  await logActivity(tx, { shopId: p.shopId, at: now, actor: 'system', kind: 'all_approved', proposalId: p.id, revisionId: rev.id, payload: {} });
  if (rev.quote.chargeCents <= 0) return null;
  const order = await currentOrder(tx, p.id);
  if (order?.status !== 'authorized') throw new Error(`proposal ${p.id}: no authorized payment to capture`);
  return enqueueOp(tx, {
    order, kind: 'capture', amountCents: rev.quote.chargeCents, proposalId: p.id, revisionId: rev.id, customerId: order.customerId, at: now,
  });
}

async function captureAndCommit(db: Db, gateway: PaymentGateway, shopId: string, proposalId: string, captureOpId: string | null): Promise<Settled> {
  // Outside the lock: the capture is an external call.
  if (captureOpId) {
    const op = await runPaymentOp(db, gateway, captureOpId);
    if (op.status !== 'succeeded') {
      const ops = await withShopLock(db, shopId, async (tx) => {
        const p = (await getProposal(tx, shopId, proposalId))!;
        return (await endProposal(tx, p, 'capture_failed', `Payment capture failed: ${op.lastError}`, (await loadSnapshot(tx, shopId)).now)).opIds;
      });
      await runOps(db, gateway, ops);
      return { status: 'failed', proposalId, reason: 'the payment could not be captured; nothing changed and the hold was released' };
    }
  }

  let outcome: { settled: Settled; ops: string[] };
  try {
    outcome = await withShopLock(db, shopId, (tx) => commitLocked(tx, shopId, proposalId));
  } catch (e) {
    // The deferred double-booking constraint fires at commit time: a last-line revalidation failure.
    if (pgCode(e) !== '23P01') throw e;
    outcome = await withShopLock(db, shopId, async (tx) => {
      const p = (await getProposal(tx, shopId, proposalId))!;
      const ended = await endProposal(tx, p, 'revalidation_failed', 'The schedule changed during payment; the charge was refunded', (await loadSnapshot(tx, shopId)).now);
      return { settled: { status: 'failed', proposalId, reason: 'the schedule changed during payment; the charge was refunded' } as Settled, ops: ended.opIds };
    });
  }

  const results = await runOps(db, gateway, outcome.ops);
  if (outcome.settled.status === 'committed') return { ...outcome.settled, refundOps: results };
  return outcome.settled;
}

async function commitLocked(tx: Tx, shopId: string, proposalId: string): Promise<{ settled: Settled; ops: string[] }> {
  const p = (await getProposal(tx, shopId, proposalId))!;
  if (p.state !== 'CAPTURING') throw new Error(`proposal ${p.id} is ${p.state}, not CAPTURING`);
  const snapshot = await loadSnapshot(tx, shopId, { proposalId: p.id });
  const idx = indexSnapshot(snapshot);
  const now = snapshot.now;
  const [rev] = await tx.select().from(s.revisions).where(and(eq(s.revisions.proposalId, p.id), eq(s.revisions.status, 'selected')));
  const rows = (await changesByRevision(tx, [rev!.id])).get(rev!.id)!;

  // Revalidate against current state and time, and check nothing changed under the plan.
  const v = validate(idx, { changes: proposedChanges(rows), requesterCustomerId: p.requesterCustomerId });
  const moved = rows.filter((c) => c.bookingId && idx.bookings.get(c.bookingId)?.version !== c.before?.version);
  if (v.violations.length || moved.length) {
    const ended = await endProposal(tx, p, 'revalidation_failed', 'The schedule changed during payment; the charge was refunded', now);
    return {
      settled: { status: 'failed', proposalId: p.id, reason: 'the schedule changed during payment; the charge was refunded', violations: v.violations },
      ops: ended.opIds,
    };
  }

  // Apply every change in this one transaction.
  const refundsByBooking = new Map<string, number>();
  for (const c of rev!.quote.compensation)
    if (c.kind === 'refund' && c.bookingId) refundsByBooking.set(c.bookingId, (refundsByBooking.get(c.bookingId) ?? 0) + c.cents);
  for (const c of rows) {
    const after = { unitId: c.newUnitId, modelId: c.newModelId!, startsAt: c.newStartsAt!, endsAt: c.newEndsAt!, bufferEndsAt: c.newBufferEndsAt! };
    if (!c.bookingId) {
      const order = await currentOrder(tx, p.id);
      await tx.insert(s.bookings).values({
        shopId, customerId: c.partyCustomerId, ...after, status: 'confirmed', priceCents: rev!.quote.chargeCents, prepaidOrderId: order?.id ?? null,
      });
      continue;
    }
    const b = idx.bookings.get(c.bookingId)!;
    const isRequester = c.partyCustomerId === p.requesterCustomerId && c.bookingId === p.subjectBookingId;
    const priceCents = isRequester ? b.priceCents + rev!.quote.chargeCents : b.priceCents - (refundsByBooking.get(c.bookingId) ?? 0);
    await tx.update(s.bookings).set({ ...after, priceCents, version: b.version + 1 }).where(eq(s.bookings.id, b.id));
  }

  const t = transition(p.state, 'captured_and_revalidated');
  if (!t.ok) throw new Error(t.reason);
  await tx.update(s.proposals).set({ state: t.to, version: sql`${s.proposals.version} + 1` }).where(eq(s.proposals.id, p.id));
  await releaseClaims(tx, { proposalId: p.id }, now);
  await tx.update(s.escalations).set({ status: 'resolved', resolution: { committed: true } })
    .where(and(eq(s.escalations.proposalId, p.id), eq(s.escalations.status, 'open')));

  // Compensation refunds go back on each customer's original capture.
  const ops: string[] = [];
  for (const [bookingId, cents] of refundsByBooking) {
    const b = idx.bookings.get(bookingId)!;
    const [order] = b.prepaidOrderId ? await tx.select().from(s.paypalOrders).where(eq(s.paypalOrders.id, b.prepaidOrderId)) : [];
    if (!order || order.status !== 'captured' || order.capturedCents - order.refundedCents < cents) {
      await tx.insert(s.escalations).values({
        shopId, kind: 'payment_failure', proposalId: p.id, revisionId: rev!.id, bookingId, reasons: ['refund_not_possible'],
        summary: `${idx.customerName(b.customerId)} is owed a $${(cents / 100).toFixed(2)} refund, but there is no prepayment on file to refund it to.`,
        at: now,
      });
      continue;
    }
    ops.push(await enqueueOp(tx, { order, kind: 'refund', amountCents: cents, proposalId: p.id, revisionId: rev!.id, customerId: b.customerId, at: now }));
  }

  await logActivity(tx, {
    shopId, at: now, actor: 'system', kind: 'proposal_committed', proposalId: p.id, revisionId: rev!.id,
    payload: { changes: rows.map((c) => ({ bookingId: c.bookingId, kind: c.kind, unitId: c.newUnitId, startsAt: c.newStartsAt, endsAt: c.newEndsAt })) },
  });
  for (const customerId of new Set(rows.map((c) => c.partyCustomerId)))
    await logActivity(tx, { shopId, at: now, actor: 'system', kind: 'proposal_update', proposalId: p.id, revisionId: rev!.id, payload: { customerId, update: 'committed' } });

  return { settled: { status: 'committed', proposalId: p.id, refundOps: [] }, ops };
}

// ---------------------------------------------------------------------------------------------------------
// 7. Timeouts

/** Ends every DRAFT or AWAITING_APPROVALS proposal past its expiry on the shop clock, voiding its hold. */
export async function expireDue(db: Db, gateway: PaymentGateway, shopId: string) {
  const { expired, ops } = await withShopLock(db, shopId, async (tx) => {
    const now = (await loadSnapshot(tx, shopId)).now;
    const due = (await tx
      .select()
      .from(s.proposals)
      .where(and(eq(s.proposals.shopId, shopId), inArray(s.proposals.state, ['DRAFT', 'AWAITING_APPROVALS']))))
      .filter((p) => p.expiresAt && p.expiresAt <= now);
    const ops: string[] = [];
    for (const p of due) ops.push(...(await expire(tx, p, now)));
    return { expired: due.map((p) => p.id), ops };
  });
  await runOps(db, gateway, ops);
  return expired;
}

// ---------------------------------------------------------------------------------------------------------
// Helpers

async function getProposal(tx: Tx, shopId: string, id: string) {
  const [p] = await tx.select().from(s.proposals).where(and(eq(s.proposals.id, id), eq(s.proposals.shopId, shopId)));
  return p;
}

async function liveRevisions(tx: Tx, proposalId: string) {
  return tx
    .select()
    .from(s.revisions)
    .where(and(eq(s.revisions.proposalId, proposalId), inArray(s.revisions.status, [...LIVE_REVISION_STATUSES])))
    .orderBy(desc(s.revisions.seq), s.revisions.optionLabel);
}

async function changesByRevision(tx: Tx, revisionIds: string[]) {
  const rows = revisionIds.length ? await tx.select().from(s.revisionChanges).where(inArray(s.revisionChanges.revisionId, revisionIds)) : [];
  const map = new Map<string, RevisionChange[]>(revisionIds.map((id) => [id, []]));
  for (const r of rows) map.get(r.revisionId)!.push(r);
  return map;
}

/** The requester's newest order that can still hold money. */
async function currentOrder(tx: Tx, proposalId: string) {
  const orders = await tx.select().from(s.paypalOrders).where(and(eq(s.paypalOrders.proposalId, proposalId), ne(s.paypalOrders.status, 'failed')));
  return orders.find((o) => o.status === 'authorized' || o.status === 'captured') ?? orders.find((o) => o.status === 'created' || o.status === 'approved');
}

async function requesterApproved(tx: Tx, proposalId: string) {
  const rows = await tx.select().from(s.approvals).where(and(eq(s.approvals.proposalId, proposalId), eq(s.approvals.role, 'requester')));
  return rows.some((a) => a.status === 'approved');
}

async function ownerApproved(tx: Tx, revisionId: string) {
  const [a] = await tx.select().from(s.approvals).where(and(eq(s.approvals.revisionId, revisionId), eq(s.approvals.role, 'owner')));
  return a?.status === 'approved';
}

/** The plan still passes the validator, and nothing it changes moved since it was made. */
function isStillValid(idx: Index, p: Proposal, rows: RevisionChange[]) {
  const v = validate(idx, { changes: proposedChanges(rows), requesterCustomerId: p.requesterCustomerId });
  return !v.violations.length && rows.every((c) => !c.bookingId || idx.bookings.get(c.bookingId)?.version === c.before?.version);
}

const placementKey = (a: Placement) => [a.unitId, a.modelId, a.startsAt.toISOString(), a.endsAt.toISOString()].join('|');

/** Drops revisions with their claims and open owner cards (claims follow revisions). */
async function dropRevisions(tx: Tx, p: Proposal, revisionIds: string[], now: Date) {
  if (!revisionIds.length) return;
  await tx.update(s.revisions).set({ status: 'dropped' }).where(inArray(s.revisions.id, revisionIds));
  await releaseClaims(tx, { proposalId: p.id, revisionIds }, now);
  await tx.update(s.escalations).set({ status: 'resolved', resolution: { dropped: true } })
    .where(and(inArray(s.escalations.revisionId, revisionIds), eq(s.escalations.status, 'open')));
}

/** A pick supersedes the other options; their claims go with them (claims follow revisions). */
async function selectRevision(tx: Tx, p: Proposal, rev: Revision, now: Date) {
  const siblings = (await liveRevisions(tx, p.id)).filter((r) => r.id !== rev.id);
  if (siblings.length) {
    await tx.update(s.revisions).set({ status: 'superseded' }).where(inArray(s.revisions.id, siblings.map((r) => r.id)));
    await releaseClaims(tx, { proposalId: p.id, revisionIds: siblings.map((r) => r.id) }, now);
    await tx.update(s.escalations).set({ status: 'resolved', resolution: { superseded: true } })
      .where(and(inArray(s.escalations.revisionId, siblings.map((r) => r.id)), eq(s.escalations.status, 'open')));
  }
  if (rev.status !== 'selected') await tx.update(s.revisions).set({ status: 'selected' }).where(eq(s.revisions.id, rev.id));
}

async function waitingOn(tx: Tx, rev: Revision): Promise<('owner' | 'affected')[]> {
  const rows = await tx.select().from(s.approvals).where(eq(s.approvals.revisionId, rev.id));
  const out = new Set<'owner' | 'affected'>();
  for (const a of rows) if (a.status === 'pending' && a.role !== 'requester') out.add(a.role);
  if (rev.needsOwner && !rows.some((a) => a.role === 'owner')) out.add('owner');
  return [...out];
}

/**
 * Asks each affected party about the revisions that change their booking, once claims are held. A revision outside
 * the envelope goes to the owner first (invariant 6); an owner-resolved one was reviewed while it was a draft.
 */
async function openOffers(tx: Tx, idx: Index, p: Proposal, revs: Revision[], rows: Map<string, RevisionChange[]>, now: Date, expiresAt: Date) {
  const offers = new Map<string, string[]>();
  for (const r of revs) {
    const parties = [...new Set(rows.get(r.id)!.filter((c) => c.requiresApproval && c.partyCustomerId !== p.requesterCustomerId).map((c) => c.partyCustomerId))];
    if (parties.length)
      await tx.insert(s.approvals).values(parties.map((customerId) => ({
        shopId: p.shopId, revisionId: r.id, proposalId: p.id, role: 'affected' as const, customerId, requestedAt: now, expiresAt,
      })));
    if (r.envelopeTrips.length && !(await ownerApproved(tx, r.id))) await ensureOwnerApproval(tx, idx, p, r, rows.get(r.id)!, 'plan_review', now);
    else for (const c of parties) offers.set(c, [...(offers.get(c) ?? []), r.id]);
  }
  for (const [customerId, revisionIds] of offers)
    await logActivity(tx, { shopId: p.shopId, at: now, actor: 'system', kind: 'offer_ready', proposalId: p.id, payload: { customerId, revisionIds, role: 'affected' } });
  return offers;
}

/** Tells affected parties still pending which options they can pick now. */
async function reofferPending(tx: Tx, p: Proposal, revs: Revision[], now: Date) {
  const pending = await tx
    .select()
    .from(s.approvals)
    .where(and(inArray(s.approvals.revisionId, revs.map((r) => r.id)), eq(s.approvals.role, 'affected'), eq(s.approvals.status, 'pending')));
  const byCustomer = new Map<string, string[]>();
  for (const a of pending) byCustomer.set(a.customerId!, [...(byCustomer.get(a.customerId!) ?? []), a.revisionId]);
  for (const [customerId, revisionIds] of byCustomer)
    await logActivity(tx, { shopId: p.shopId, at: now, actor: 'system', kind: 'offer_ready', proposalId: p.id, payload: { customerId, revisionIds, role: 'affected' } });
}

async function expireIfDue(tx: Tx, p: Proposal, now: Date) {
  if (!p.expiresAt || now < p.expiresAt) return null;
  return expire(tx, p, now);
}

async function expire(tx: Tx, p: Proposal, now: Date) {
  const { opIds } = await endProposal(tx, p, 'expire', 'No answer before the offer expired', now);
  await offerClosestAfterNoAnswer(tx, p, opIds.length > 0, now);
  return opIds;
}

/**
 * Another customer never answered, so the request ended. As after a refusal, the requester still gets the closest the
 * schedule allows, as a new request: the expired one stays EXPIRED. Their hold is gone, so if it costs anything they
 * pay on the new card. Not when the requester was the one who didn't answer: they've been offered what there is.
 */
async function offerClosestAfterNoAnswer(tx: Tx, p: Proposal, holdReleased: boolean, now: Date) {
  if (p.state !== 'AWAITING_APPROVALS' || p.source !== 'customer_request' || !p.requesterCustomerId) return;
  const snapshot = await loadSnapshot(tx, p.shopId);
  const nearest = nearestAlternative(snapshot, loadRequest(p.request as StoredRequest));
  if (!nearest) return;
  const expiresAt = new Date(now.getTime() + snapshot.shop.policy.approval_timeout_minutes * 60_000);
  const [next] = await tx
    .insert(s.proposals)
    .values({
      shopId: p.shopId, source: 'customer_request', requesterCustomerId: p.requesterCustomerId, subjectBookingId: p.subjectBookingId,
      request: p.request, state: 'DRAFT', revisionSeq: 1, expiresAt, createdAt: now,
    })
    .returning();
  const { revision } = await insertRevision(tx, { proposal: next!, seq: 1, optionLabel: null, plan: nearest, origin: 'alternative', at: now });
  await tx.insert(s.approvals).values({
    shopId: p.shopId, revisionId: revision.id, proposalId: next!.id, role: 'requester', customerId: p.requesterCustomerId, requestedAt: now, expiresAt,
  });
  if (revision.needsOwner) {
    const rows = (await changesByRevision(tx, [revision.id])).get(revision.id)!;
    await ensureOwnerApproval(tx, indexSnapshot(snapshot), next!, revision, rows, 'plan_review', now);
  }
  await logActivity(tx, {
    shopId: p.shopId, at: now, actor: 'system', kind: 'alternative_offered', proposalId: next!.id, revisionId: revision.id,
    payload: { quote: revision.quote, holdReleased, noAnswerOf: p.id },
  });
  await offerToRequesterIfReviewed(tx, next!, now, { fallback: true, holdReleased, noAnswerOf: p.id });
}

async function runOps(db: Db, gateway: PaymentGateway, ids: string[]) {
  const done = [];
  for (const id of ids) done.push(await runPaymentOp(db, gateway, id));
  return done;
}

function pgCode(e: unknown): string | undefined {
  const err = e as { code?: string; cause?: { code?: string } };
  return err.code ?? err.cause?.code;
}
