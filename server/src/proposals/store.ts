// Proposal persistence: plans become immutable revisions, revisions take claims, proposals end cleanly.
// Everything here runs inside a `withShopLock` transaction; callers run any returned payment ops after commit.

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { logActivity } from '../activity.ts';
import type { Tx } from '../db/client.ts';
import * as s from '../db/schema.ts';
import type { Plan } from '../optimizer/optimizer.ts';
import type { Index, Placement } from '../optimizer/snapshot.ts';
import { formatShopTime } from '../optimizer/time.ts';
import type { ProposedChange } from '../optimizer/validator.ts';
import { enqueueOp, enqueueVoid } from '../payments/ops.ts';
import { type ProposalEvent, transition } from './state-machine.ts';

export type Proposal = typeof s.proposals.$inferSelect;
export type Revision = typeof s.revisions.$inferSelect;
export type RevisionChange = typeof s.revisionChanges.$inferSelect;

export const LIVE_REVISION_STATUSES = ['draft', 'offered', 'selected'] as const;

/** Saves a plan as a revision with its changes. `revision_changes.new_*` always hold the full after state. */
export async function insertRevision(
  tx: Tx,
  input: { proposal: Proposal; seq: number; optionLabel: 'A' | 'B' | null; plan: Plan; origin: Revision['origin']; at: Date },
): Promise<{ revision: Revision; changes: RevisionChange[] }> {
  const { proposal, plan } = input;
  const [revision] = await tx
    .insert(s.revisions)
    .values({
      shopId: proposal.shopId,
      proposalId: proposal.id,
      seq: input.seq,
      optionLabel: input.optionLabel,
      status: 'offered',
      origin: input.origin,
      createdBy: 'agent',
      isAlternative: plan.isAlternative,
      quote: plan.quote,
      netRevenueCents: plan.quote.netRevenueCents,
      ownerTriggers: plan.ownerTriggers,
      envelopeTrips: plan.envelopeTrips,
      needsOwner: plan.needsOwner,
      // Dependencies on facts with no row yet aren't stored here; the demo's fact rows are seeded.
      factDependencies: plan.factDependencies.flatMap((f) => (f.factId ? [f.factId] : [])),
      validatedAt: input.at,
      createdAt: input.at,
    })
    .returning();

  const bookingIds = plan.changes.flatMap((c) => (c.bookingId ? [c.bookingId] : []));
  const bookings = new Map(
    (bookingIds.length ? await tx.select().from(s.bookings).where(inArray(s.bookings.id, bookingIds)) : []).map((b) => [b.id, b]),
  );
  const changes = await tx
    .insert(s.revisionChanges)
    .values(
      plan.changes.map((c) => {
        const b = c.bookingId ? bookings.get(c.bookingId)! : null;
        const compensation = plan.quote.compensation.filter((x) => x.bookingId === c.bookingId && c.bookingId);
        return {
          shopId: proposal.shopId,
          revisionId: revision!.id,
          bookingId: c.bookingId,
          action: c.bookingId ? ('update' as const) : ('create' as const),
          before: b
            ? {
                unitId: b.unitId, modelId: b.modelId, startsAt: b.startsAt.toISOString(), endsAt: b.endsAt.toISOString(),
                bufferEndsAt: b.bufferEndsAt.toISOString(), status: b.status, version: b.version,
              }
            : null,
          newUnitId: c.after.unitId,
          newModelId: c.after.modelId,
          newStartsAt: c.after.startsAt,
          newEndsAt: c.after.endsAt,
          newBufferEndsAt: c.after.bufferEndsAt,
          kind: c.kind,
          requiresApproval: c.requiresApproval,
          hoursShifted: c.hoursShifted,
          partyCustomerId: c.customerId,
          priceDeltaCents: c.priceDeltaCents,
          compensationCents: compensation.reduce((sum, x) => sum + x.cents, 0),
          compensationKind: compensation.find((x) => x.kind === 'refund')?.kind ?? compensation[0]?.kind ?? null,
        };
      }),
    )
    .returning();
  return { revision: revision!, changes };
}

export const afterOf = (c: RevisionChange): Placement => ({
  unitId: c.newUnitId,
  modelId: c.newModelId!,
  startsAt: c.newStartsAt!,
  endsAt: c.newEndsAt!,
  bufferEndsAt: c.newBufferEndsAt!,
});

export const proposedChanges = (rows: RevisionChange[]): ProposedChange[] =>
  rows.map((c) => ({ bookingId: c.bookingId, customerId: c.partyCustomerId, after: afterOf(c) }));

/**
 * Claims for one revision: every existing booking it changes, plus the unit capacity it moves into that the
 * booking doesn't already occupy (Alice's extension claims A7IV-1 from her current buffer end to her new one).
 * Throws on a conflict with another proposal's claim (exclusion constraint); call inside a savepoint.
 */
export async function placeClaims(tx: Tx, proposal: Proposal, revisionId: string, rows: RevisionChange[]) {
  const values: (typeof s.claims.$inferInsert)[] = [];
  for (const c of rows) {
    if (c.bookingId) values.push({ shopId: proposal.shopId, proposalId: proposal.id, revisionId, bookingId: c.bookingId });
    const after = afterOf(c);
    if (!after.unitId) continue;
    const claim = (start: Date, end: Date) =>
      values.push({ shopId: proposal.shopId, proposalId: proposal.id, revisionId, unitId: after.unitId, period: { start, end } });
    const before = c.before;
    if (!before || before.unitId !== after.unitId) {
      claim(after.startsAt, after.bufferEndsAt);
      continue;
    }
    const [bStart, bEnd] = [new Date(before.startsAt), new Date(before.bufferEndsAt)];
    if (after.startsAt < bStart) claim(after.startsAt, bStart < after.bufferEndsAt ? bStart : after.bufferEndsAt);
    if (after.bufferEndsAt > bEnd) claim(bEnd > after.startsAt ? bEnd : after.startsAt, after.bufferEndsAt);
  }
  if (values.length) await tx.insert(s.claims).values(values);
}

export async function releaseClaims(tx: Tx, where: { proposalId: string; revisionIds?: string[] }, at: Date) {
  if (where.revisionIds && !where.revisionIds.length) return;
  await tx
    .update(s.claims)
    .set({ releasedAt: at })
    .where(
      and(
        eq(s.claims.proposalId, where.proposalId),
        isNull(s.claims.releasedAt),
        ...(where.revisionIds ? [inArray(s.claims.revisionId, where.revisionIds)] : []),
      ),
    );
}

/**
 * Ends a proposal through the state machine and performs the transition's effects: claims released now,
 * voids and refunds recorded as payment ops. Returns the op ids to run after commit.
 */
export async function endProposal(tx: Tx, proposal: Proposal, event: ProposalEvent, reason: string, at: Date, actor: 'owner' | 'system' | `customer:${string}` = 'system') {
  const t = transition(proposal.state, event);
  if (!t.ok) throw new Error(`proposal ${proposal.id}: ${t.reason}`);
  await tx
    .update(s.proposals)
    .set({ state: t.to, endedReason: reason, expiresAt: null, version: sql`${s.proposals.version} + 1` })
    .where(eq(s.proposals.id, proposal.id));

  const opIds: string[] = [];
  if (t.effects.includes('release_claims')) await releaseClaims(tx, { proposalId: proposal.id }, at);
  const orders = await tx.select().from(s.paypalOrders).where(eq(s.paypalOrders.proposalId, proposal.id));
  for (const o of orders) {
    if (t.effects.includes('void_authorization')) {
      const id = await enqueueVoid(tx, o, at);
      if (id) opIds.push(id);
    }
    if (t.effects.includes('refund_capture') && o.status === 'captured' && o.capturedCents > o.refundedCents)
      opIds.push(await enqueueOp(tx, {
        order: o, kind: 'refund', amountCents: o.capturedCents - o.refundedCents, proposalId: proposal.id, revisionId: o.revisionId, customerId: o.customerId, at,
      }));
  }
  await tx.update(s.escalations).set({ status: 'resolved', resolution: { proposalEnded: t.to } })
    .where(and(eq(s.escalations.proposalId, proposal.id), eq(s.escalations.status, 'open')));
  await logActivity(tx, {
    shopId: proposal.shopId, at, actor, kind: 'proposal_ended', proposalId: proposal.id,
    payload: { event, from: proposal.state, to: t.to, reason },
  });
  return { to: t.to, opIds };
}

/** Creates the owner's pending approval on a revision, with its escalation card, once. */
export async function ensureOwnerApproval(
  tx: Tx, idx: Index, proposal: Proposal, revision: Revision, rows: RevisionChange[], kind: 'approval' | 'plan_review', at: Date,
) {
  const inserted = await tx
    .insert(s.approvals)
    .values({ shopId: revision.shopId, revisionId: revision.id, proposalId: revision.proposalId, role: 'owner', requestedAt: at })
    .onConflictDoNothing()
    .returning();
  if (!inserted.length) return;
  await tx.insert(s.escalations).values({
    shopId: revision.shopId, kind, proposalId: revision.proposalId, revisionId: revision.id,
    reasons: [...revision.ownerTriggers, ...revision.envelopeTrips], summary: ownerSummary(idx, proposal, revision, rows), at,
  });
}

/** "Bob's booking shortened by 5h, $15 refund. Net +$30." Rendered from the revision, never from agent text. */
export function ownerSummary(idx: Index, proposal: Proposal, revision: Revision, rows: RevisionChange[]) {
  const usd = (cents: number) => `$${(Math.abs(cents) / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
  const t = (d: Date) => formatShopTime(d, idx.snap.shop);
  const parts = rows
    .filter((c) => c.before && c.partyCustomerId !== proposal.requesterCustomerId)
    .flatMap((c) => {
      const name = idx.customerName(c.partyCustomerId);
      const before = c.before!;
      const after = afterOf(c);
      const out: string[] = [];
      const lostMs = new Date(before.endsAt).getTime() - new Date(before.startsAt).getTime() - (after.endsAt.getTime() - after.startsAt.getTime());
      if (c.kind === 'model_change') out.push(`${name} moved to the ${idx.models.get(after.modelId)?.name ?? 'other model'}`);
      else if (c.kind === 'same_model_swap') out.push(`${name} moved to ${idx.unitLabel(after.unitId)} (notice only)`);
      else if (lostMs > 0) out.push(`${name}'s booking shortened by ${lostMs / 3600_000}h (now ${t(after.startsAt)} → ${t(after.endsAt)})`);
      else if (c.kind === 'time_shift') out.push(`${name} moved to ${t(after.startsAt)} → ${t(after.endsAt)}`);
      const comp = revision.quote.compensation.filter((x) => x.bookingId === c.bookingId);
      for (const x of comp) out.push(x.kind === 'refund' ? `${usd(x.cents)} refund` : `${usd(x.cents)} upgrade value`);
      return out.length ? [out.join(', ')] : [];
    });
  const net = revision.quote.netRevenueCents;
  return `${parts.join('; ') || 'No other bookings change'}. Net ${net < 0 ? '−' : '+'}${usd(net)}.`;
}

/** Every approval this revision needs is in: the requester's, each affected party's, and the owner's if needed. */
export async function allApproved(tx: Tx, revision: Revision) {
  const rows = await tx.select().from(s.approvals).where(eq(s.approvals.revisionId, revision.id));
  if (!rows.length || rows.some((a) => a.status !== 'approved')) return false;
  return !revision.needsOwner || rows.some((a) => a.role === 'owner');
}
