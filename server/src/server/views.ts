// Read models for the browser. The owner sees everything in their shop; a customer sees their own bookings and
// cards, with other customers anonymous (docs/agent-tools.md §1).

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Tx } from '../db/client.ts';
import { loadSnapshot } from '../db/load-snapshot.ts';
import * as s from '../db/schema.ts';
import { indexSnapshot } from '../optimizer/snapshot.ts';
import { lastUndoableEdit } from '../owner/edit-booking.ts';
import { formatShopTime } from '../optimizer/time.ts';
import { type CardOption, type CardRole, renderOption } from '../proposals/cards.ts';
import { ACTIVE_STATES } from '../proposals/state-machine.ts';
import { LIVE_REVISION_STATUSES } from '../proposals/store.ts';

/** Everything the owner dashboard and Bryntum need (docs/data-model.md §10). */
export async function ownerView(tx: Tx, shopId: string) {
  const snapshot = await loadSnapshot(tx, shopId);
  const [shop] = await tx.select().from(s.shops).where(eq(s.shops.id, shopId));
  const proposals = await tx
    .select()
    .from(s.proposals)
    .where(and(eq(s.proposals.shopId, shopId), inArray(s.proposals.state, [...ACTIVE_STATES])));
  const proposalIds = proposals.map((p) => p.id);
  const revisions = proposalIds.length
    ? await tx.select().from(s.revisions).where(and(inArray(s.revisions.proposalId, proposalIds), inArray(s.revisions.status, [...LIVE_REVISION_STATUSES])))
    : [];
  const revisionIds = revisions.map((r) => r.id);
  const [changes, approvals, claims] = revisionIds.length
    ? await Promise.all([
        tx.select().from(s.revisionChanges).where(inArray(s.revisionChanges.revisionId, revisionIds)),
        tx.select().from(s.approvals).where(inArray(s.approvals.revisionId, revisionIds)),
        tx.select().from(s.claims).where(and(inArray(s.claims.proposalId, proposalIds), isNull(s.claims.releasedAt))),
      ])
    : [[], [], []];
  const [drafts, escalations, activity, conversations, messages] = await Promise.all([
    tx.select().from(s.ownerDrafts).where(eq(s.ownerDrafts.shopId, shopId)),
    tx.select().from(s.escalations).where(and(eq(s.escalations.shopId, shopId), eq(s.escalations.status, 'open'))).orderBy(s.escalations.at),
    tx.select().from(s.activityLog).where(eq(s.activityLog.shopId, shopId)).orderBy(desc(s.activityLog.seq)).limit(100),
    tx.select().from(s.conversations).where(eq(s.conversations.shopId, shopId)),
    tx.select().from(s.messages).where(eq(s.messages.shopId, shopId)).orderBy(s.messages.at),
  ]);

  return {
    shop: {
      name: shop!.name,
      now: snapshot.now,
      timezone: snapshot.shop.timezone,
      opensAt: snapshot.shop.opensAt,
      closesAt: snapshot.shop.closesAt,
      policy: snapshot.shop.policy,
      agentTurnsUsed: shop!.agentTurnsUsed,
      autoReplyCustomers: shop!.autoReplyCustomers,
    },
    models: snapshot.models,
    units: snapshot.units,
    customers: snapshot.customers,
    bookings: snapshot.bookings.filter((b) => b.status === 'confirmed' || b.status === 'picked_up'),
    unavailability: snapshot.unavailability,
    conditionNotes: snapshot.conditionNotes.filter((n) => !n.resolvedAt),
    facts: snapshot.facts,
    proposals: proposals.map((p) => ({
      ...p,
      revisions: revisions
        .filter((r) => r.proposalId === p.id)
        .map((r) => ({
          ...r,
          changes: changes.filter((c) => c.revisionId === r.id),
          approvals: approvals.filter((a) => a.revisionId === r.id),
        })),
      claims: claims.filter((c) => c.proposalId === p.id),
    })),
    drafts,
    /** The owner's latest edit, while Undo can still put it back. */
    lastEdit: await lastUndoableEdit(tx, shopId),
    escalations,
    /** Every chat thread, including the agent's drafts during a handoff. */
    conversations: conversations.map((c) => ({ ...c, messages: messages.filter((m) => m.conversationId === c.id) })),
    /** Newest first; the SSE stream continues from `activity[0].seq`. */
    activity,
  };
}

export type CustomerCard = {
  proposalId: string;
  role: CardRole;
  /** What the customer can do: requesters accept (and pay when `chargeCents` > 0); affected parties pick an option. */
  chargeCents: number;
  /** Already authorized for this request (a fallback alternative keeps the hold when it costs no more): accept
   * without paying again. */
  heldCents: number;
  options: CardOption[];
  expiresAt: Date | null;
};

/** One customer's chat-side view: their bookings, their pending cards, and what's in progress. */
export async function customerView(tx: Tx, shopId: string, customerId: string) {
  const snapshot = await loadSnapshot(tx, shopId);
  const idx = indexSnapshot(snapshot);
  const customer = idx.customers.get(customerId);
  if (!customer) return null;
  const t = (d: Date) => formatShopTime(d, snapshot.shop);

  const bookings = snapshot.bookings
    .filter((b) => b.customerId === customerId && b.status !== 'cancelled')
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .map((b) => ({
      id: b.id,
      model: idx.models.get(b.modelId)?.name ?? '',
      unit: idx.unitLabel(b.unitId),
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      display: `${t(b.startsAt)} → ${t(b.endsAt)}`,
      status: b.status,
      priceCents: b.priceCents,
    }));

  const ownerOk = new Set(
    (await tx.select().from(s.approvals).where(and(eq(s.approvals.shopId, shopId), eq(s.approvals.role, 'owner'), eq(s.approvals.status, 'approved')))).map((a) => a.revisionId),
  );
  const pending = await tx
    .select({ approval: s.approvals, revision: s.revisions, proposal: s.proposals })
    .from(s.approvals)
    .innerJoin(s.revisions, eq(s.approvals.revisionId, s.revisions.id))
    .innerJoin(s.proposals, eq(s.approvals.proposalId, s.proposals.id))
    .where(
      and(
        eq(s.approvals.shopId, shopId),
        eq(s.approvals.customerId, customerId),
        inArray(s.approvals.status, ['pending', 'approved']),
        inArray(s.revisions.status, [...LIVE_REVISION_STATUSES]),
        inArray(s.proposals.state, ['DRAFT', 'AWAITING_APPROVALS']),
      ),
    );
  // A requester's card is open while the proposal is DRAFT; an affected party's once offers are out.
  // A requester agreed by phone still has a card to pay on (owner-attested approval, demo Scenario 2).
  const visible = pending.filter(({ approval, proposal, revision }) =>
    approval.role === 'requester'
      ? proposal.state === 'DRAFT' && (approval.status === 'pending' || approval.source === 'owner_attested')
      : approval.status === 'pending' && proposal.state === 'AWAITING_APPROVALS' && (!revision.envelopeTrips.length || ownerOk.has(revision.id)),
  );

  const revisionIds = visible.map((v) => v.revision.id);
  const [rows, ownerRows] = revisionIds.length
    ? await Promise.all([
        tx.select().from(s.revisionChanges).where(inArray(s.revisionChanges.revisionId, revisionIds)),
        tx.select().from(s.approvals).where(and(inArray(s.approvals.revisionId, revisionIds), eq(s.approvals.role, 'owner'))),
      ])
    : [[], []];

  const proposalIds = [...new Set(visible.map((v) => v.proposal.id))];
  const held = proposalIds.length
    ? await tx.select().from(s.paypalOrders).where(and(inArray(s.paypalOrders.proposalId, proposalIds), eq(s.paypalOrders.status, 'authorized')))
    : [];
  const cards = new Map<string, CustomerCard>();
  for (const { approval, revision, proposal } of visible) {
    const role = approval.role as CardRole;
    const key = `${proposal.id}:${role}`;
    const heldCents = role === 'requester' ? (held.find((o) => o.proposalId === proposal.id)?.amountCents ?? 0) : 0;
    const card = cards.get(key) ?? {
      proposalId: proposal.id, role, chargeCents: role === 'requester' ? revision.quote.chargeCents : 0, heldCents, options: [], expiresAt: proposal.expiresAt,
    };
    const ownerApproved = ownerRows.some((o) => o.revisionId === revision.id && o.status === 'approved');
    card.options.push(renderOption(idx, revision, rows.filter((r) => r.revisionId === revision.id), customerId, role, ownerApproved));
    cards.set(key, card);
  }
  // A requester sees one offer: their terms are identical across options (docs/agent-tools.md request_change).
  for (const card of cards.values()) {
    card.options.sort((a, b) => (a.option ?? '').localeCompare(b.option ?? ''));
    if (card.role === 'requester') card.options = card.options.slice(0, 1).map((o) => ({ ...o, option: null, needsShop: card.options.every((x) => x.needsShop) }));
  }

  const [conversation] = await tx.select().from(s.conversations).where(eq(s.conversations.customerId, customerId));
  const messages = conversation
    ? await tx
        .select({ id: s.messages.id, author: s.messages.author, body: s.messages.body, cardRevisionIds: s.messages.cardRevisionIds, at: s.messages.at })
        .from(s.messages)
        .where(and(eq(s.messages.conversationId, conversation.id), eq(s.messages.isOwnerDraft, false)))
        .orderBy(s.messages.at)
    : [];

  return {
    customer: { id: customer.id, name: customer.name },
    now: snapshot.now,
    /** Oldest first. A message with `cardRevisionIds` is where a card sits in the chat; its buttons come from `cards`. */
    messages,
    handedOff: !!conversation?.handedOffAt,
    bookings,
    cards: [...cards.values()],
  };
}
