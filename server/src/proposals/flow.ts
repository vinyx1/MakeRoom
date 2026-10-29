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
// Not yet: refusals and fallback plans (Scenario 3), counters and re-approval, withdrawal, telling customers
// (the agent reads the `offer_ready` / `proposal_update` activity events).

import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { logActivity } from '../activity.ts';
import type { Db, Tx } from '../db/client.ts';
import { loadSnapshot } from '../db/load-snapshot.ts';
import { withShopLock } from '../db/lock.ts';
import * as s from '../db/schema.ts';
import { type Plan, type Pruned, type Request, optimize } from '../optimizer/optimizer.ts';
import { type Index, indexSnapshot } from '../optimizer/snapshot.ts';
import { type Violation, validate } from '../optimizer/validator.ts';
import type { PaymentGateway } from '../payments/gateway.ts';
import { enqueueOp, runPaymentOp } from '../payments/ops.ts';
import { storeRequest } from './request.ts';
import { ACTIVE_STATES, transition } from './state-machine.ts';
import {
  LIVE_REVISION_STATUSES,
  type Proposal,
  type Revision,
  type RevisionChange,
  allApproved,
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
      if (active) return refused('this booking already has a request in progress');
    }

    const result = optimize(snapshot, request);
    await logActivity(tx, {
      shopId, at: now, actor: 'system', kind: 'optimizer_run',
      payload: {
        request: storeRequest(request),
        status: result.status,
        plans: result.status === 'fits' || result.status === 'needs_other_changes' ? result.plans.map(planSummary) : [],
        pruned: result.status === 'invalid_request' ? [] : result.pruned.map((p) => ({ message: p.message, rules: p.rules, bookingId: p.bookingId })),
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
    requestId: `${proposal.id}:${revision.id}:order:${input.customerId}:${prep.attempt}`,
    description: `RentFlow: ${revision.quote.lines.map((l) => l.label).join(', ')}`,
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
      payload: { orderId: created.orderId, amountCents: revision.quote.chargeCents, authorizedOnCreate: !!created.authorizationId },
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
      .where(and(eq(s.approvals.proposalId, p.id), eq(s.approvals.role, 'requester'), inArray(s.approvals.revisionId, valid.map((r) => r.id))));

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

    const offers = new Map<string, string[]>();
    for (const r of valid) {
      const parties = [...new Set(rows.get(r.id)!.filter((c) => c.requiresApproval && c.partyCustomerId !== p.requesterCustomerId).map((c) => c.partyCustomerId))];
      if (parties.length)
        await tx.insert(s.approvals).values(parties.map((customerId) => ({
          shopId, revisionId: r.id, proposalId: p.id, role: 'affected' as const, customerId, requestedAt: now, expiresAt,
        })));
      // Outside the envelope: the owner reviews before any customer sees it (invariant 6).
      if (r.envelopeTrips.length) await ensureOwnerApproval(tx, idx, p, r, rows.get(r.id)!, 'plan_review', now);
      else for (const c of parties) offers.set(c, [...(offers.get(c) ?? []), r.id]);
    }
    await logActivity(tx, { shopId, at: now, actor: `customer:${input.customerId}`, kind: 'requester_accepted', proposalId: p.id, payload: { revisionIds: valid.map((r) => r.id) } });
    for (const [customerId, revisionIds] of offers)
      await logActivity(tx, { shopId, at: now, actor: 'system', kind: 'offer_ready', proposalId: p.id, payload: { customerId, revisionIds, role: 'affected' } });

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
  | { status: 'awaiting_approvals'; waitingOn: ('owner' | 'affected')[] }
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
    await selectRevision(tx, p, rev, now);
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
// 5. The owner approves or declines

export async function ownerDecision(
  db: Db, gateway: PaymentGateway, shopId: string, input: { proposalId: string; revisionId: string; decision: 'approve' | 'decline' },
): Promise<DecisionResult> {
  const locked = await withShopLock(db, shopId, async (tx) => {
    const p = await getProposal(tx, shopId, input.proposalId);
    if (!p) return { result: refused('request not found') };
    const [approval] = await tx.select().from(s.approvals).where(and(eq(s.approvals.revisionId, input.revisionId), eq(s.approvals.role, 'owner')));
    if (!approval) return { result: refused('nothing is waiting for the shop on this offer') };
    if (approval.status !== 'pending') return { result: { status: 'already_decided' } as DecisionResult };
    if (p.state !== 'AWAITING_APPROVALS') return { result: refused(`this request is ${p.state}`) };

    const snapshot = await loadSnapshot(tx, shopId, { proposalId: p.id });
    const idx = indexSnapshot(snapshot);
    const now = snapshot.now;
    const expired = await expireIfDue(tx, p, now);
    if (expired) return { result: { status: 'stale', reason: 'the offer expired' } as DecisionResult, ops: expired };
    const [rev] = await tx.select().from(s.revisions).where(eq(s.revisions.id, input.revisionId));
    const rows = (await changesByRevision(tx, [rev!.id])).get(rev!.id)!;

    const approve = input.decision === 'approve';
    await tx
      .update(s.approvals)
      .set({ status: approve ? 'approved' : 'rejected', source: 'card_click', respondedAt: now })
      .where(eq(s.approvals.id, approval.id));
    await tx
      .update(s.escalations)
      .set({ status: 'resolved', resolution: { decision: input.decision } })
      .where(and(eq(s.escalations.revisionId, rev!.id), eq(s.escalations.status, 'open')));
    await logActivity(tx, { shopId, at: now, actor: 'owner', kind: approve ? 'owner_approved' : 'owner_declined', proposalId: p.id, revisionId: rev!.id, payload: {} });

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
    if (await allApproved(tx, rev!)) return { capture: { captureOpId: await startCapture(tx, p, rev!, now) } };
    return { result: { status: 'awaiting_approvals', waitingOn: await waitingOn(tx, rev!) } as DecisionResult };
  });
  await runOps(db, gateway, locked.ops ?? []);
  if (locked.capture) return captureAndCommit(db, gateway, shopId, input.proposalId, locked.capture.captureOpId);
  return locked.result!;
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
    for (const p of due) ops.push(...(await endProposal(tx, p, 'expire', 'No answer before the offer expired', now)).opIds);
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
  return (await endProposal(tx, p, 'expire', 'No answer before the offer expired', now)).opIds;
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
