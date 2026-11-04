// Whether an offer on a card still asks this customer anything. The card is on screen while the agent's turn runs,
// so the customer or the owner can act before the turn finishes.

import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import * as s from '../db/schema.ts';
import { LIVE_REVISION_STATUSES } from '../proposals/store.ts';

export type OfferRef = { proposalId: string; revisionIds: string[]; role: 'affected' | 'requester' };

export async function offerStillOpen(db: Db, customerId: string, offer: OfferRef) {
  const [p] = await db.select().from(s.proposals).where(eq(s.proposals.id, offer.proposalId));
  if (!p) return false;
  const live = (await db.select().from(s.revisions).where(and(eq(s.revisions.proposalId, p.id), inArray(s.revisions.status, [...LIVE_REVISION_STATUSES]))))
    .filter((r) => offer.revisionIds.includes(r.id));
  if (!live.length) return false;
  if (offer.role === 'requester') return p.state === 'DRAFT' && p.requesterCustomerId === customerId;
  if (p.state !== 'AWAITING_APPROVALS') return false;
  const mine = await db
    .select()
    .from(s.approvals)
    .where(and(inArray(s.approvals.revisionId, live.map((r) => r.id)), eq(s.approvals.customerId, customerId)));
  // A pick leaves its sibling option pending, so one answered option closes the offer for this customer.
  return mine.some((a) => a.status === 'pending') && !mine.some((a) => a.status === 'approved');
}
