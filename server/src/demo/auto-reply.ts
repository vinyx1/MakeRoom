// Judge mode, auto-reply customers (CLAUDE.md "Judge mode"): when a shop has it on, an affected customer answers
// their offer by themselves, so a judge playing only the requester still sees the negotiation play out.
// The scripted customer follows the demo script: it says which option it takes, then clicks it, picking Plan B
// when there are two (Bob's "2pm is fine, I'll take the refund"), else the only option.

import { and, eq, inArray } from 'drizzle-orm';
import { logActivity } from '../activity.ts';
import { conversationOf } from '../agent/turn.ts';
import type { Db } from '../db/client.ts';
import * as s from '../db/schema.ts';
import type { PaymentGateway } from '../payments/gateway.ts';
import { affectedAccept } from '../proposals/flow.ts';

export type AutoReplyOffer = { shopId: string; customerId: string; proposalId: string; revisionIds: string[] };

export function createAutoReply(db: Db, gateway: PaymentGateway, { delayMs = 4000 }: { delayMs?: number } = {}) {
  return async function autoReply(offer: AutoReplyOffer) {
    const [shop] = await db.select().from(s.shops).where(eq(s.shops.id, offer.shopId));
    if (!shop?.autoReplyCustomers) return null;
    await new Promise((r) => setTimeout(r, delayMs)); // let the agent's message land first, as a person would read it

    // A person may have answered for this customer while we waited. A pick leaves its sibling option pending, so
    // without this the script would pick that one too.
    const answered = await db
      .select({ id: s.approvals.id })
      .from(s.approvals)
      .where(and(eq(s.approvals.customerId, offer.customerId), eq(s.approvals.status, 'approved'), inArray(s.approvals.revisionId, offer.revisionIds)));
    if (answered.length) return null;

    // Only options this customer can still pick (the offer may have moved on while we waited).
    const pending = await db
      .select({ revision: s.revisions })
      .from(s.approvals)
      .innerJoin(s.revisions, eq(s.approvals.revisionId, s.revisions.id))
      .where(and(
        eq(s.approvals.customerId, offer.customerId), eq(s.approvals.role, 'affected'), eq(s.approvals.status, 'pending'),
        inArray(s.approvals.revisionId, offer.revisionIds),
      ));
    const options = pending.map((p) => p.revision).sort((a, b) => (a.optionLabel ?? '').localeCompare(b.optionLabel ?? ''));
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
  };
}
