// Judge mode (CLAUDE.md "Judge mode"): a scripted affected customer answers their offer, so a judge alone still sees
// the negotiation play out. Normally a button on their card asks for it; a shop with auto-reply on (the terminal
// tester) gets it by itself after the offer. The customer follows the demo script: they say which option they take,
// then click it, picking Plan B when there are two (Bob's "2pm is fine, I'll take the refund"), else the only option.

import { and, eq, inArray } from 'drizzle-orm';
import { logActivity } from '../activity.ts';
import { conversationOf } from '../agent/turn.ts';
import type { Db } from '../db/client.ts';
import * as s from '../db/schema.ts';
import type { PaymentGateway } from '../payments/gateway.ts';
import { affectedAccept } from '../proposals/flow.ts';
import { LIVE_REVISION_STATUSES } from '../proposals/store.ts';

export type AutoReplyOffer = { shopId: string; customerId: string; proposalId: string; revisionIds: string[] };

/** Answers as this customer, the way a click on their card would. Null when they have no decision to make. */
export async function scriptedAnswer(db: Db, gateway: PaymentGateway, offer: { shopId: string; customerId: string; proposalId: string }) {
  const [shop] = await db.select().from(s.shops).where(eq(s.shops.id, offer.shopId));
  if (!shop) return null;
  const mine = await db
    .select({ approval: s.approvals, revision: s.revisions })
    .from(s.approvals)
    .innerJoin(s.revisions, eq(s.approvals.revisionId, s.revisions.id))
    .where(and(
      eq(s.approvals.proposalId, offer.proposalId), eq(s.approvals.customerId, offer.customerId), eq(s.approvals.role, 'affected'),
      inArray(s.revisions.status, [...LIVE_REVISION_STATUSES]),
    ));
  // A pick leaves its sibling option pending, so without this the script would pick that one too.
  if (mine.some((m) => m.approval.status === 'approved')) return null;
  // Only options on their card: a plan outside the envelope reaches a customer once the owner has approved it.
  const ownerOk = new Set((await db
    .select({ id: s.approvals.revisionId })
    .from(s.approvals)
    .where(and(eq(s.approvals.proposalId, offer.proposalId), eq(s.approvals.role, 'owner'), eq(s.approvals.status, 'approved')))).map((a) => a.id));
  const options = mine
    .filter((m) => m.approval.status === 'pending' && (!m.revision.envelopeTrips.length || ownerOk.has(m.revision.id)))
    .map((m) => m.revision)
    .sort((a, b) => (a.optionLabel ?? '').localeCompare(b.optionLabel ?? ''));
  const choice = options.find((r) => r.optionLabel === 'B') ?? options[0];
  if (!choice) return null;

  const at = new Date(Date.now() + shop.clockOffsetMs);
  const conversation = await conversationOf(db, offer.shopId, offer.customerId, at);
  const text = choice.optionLabel ? `Option ${choice.optionLabel} works for me, thanks.` : 'That works for me, thanks.';
  await db.insert(s.messages).values({ shopId: offer.shopId, conversationId: conversation.id, author: 'customer', body: text, at });
  await logActivity(db, {
    shopId: offer.shopId, at, actor: `customer:${offer.customerId}`, kind: 'auto_reply', proposalId: offer.proposalId, revisionId: choice.id,
    payload: { customerId: offer.customerId, option: choice.optionLabel, text },
  });
  return affectedAccept(db, gateway, offer.shopId, { proposalId: offer.proposalId, customerId: offer.customerId, revisionId: choice.id });
}

export function createAutoReply(db: Db, gateway: PaymentGateway, { delayMs = 4000 }: { delayMs?: number } = {}) {
  return async function autoReply(offer: AutoReplyOffer) {
    const [shop] = await db.select().from(s.shops).where(eq(s.shops.id, offer.shopId));
    if (!shop?.autoReplyCustomers) return null;
    await new Promise((r) => setTimeout(r, delayMs)); // let the agent's message land first, as a person would read it
    return scriptedAnswer(db, gateway, offer);
  };
}
