// "Save as fact" (demo Scenario 2, step 4): the owner's answer becomes a stored fact, so the question isn't asked
// again. Facts are only ever set here, by the owner; no agent tool can set one (docs/agent-tools.md §5).

import { and, eq, sql } from 'drizzle-orm';
import { logActivity } from '../activity.ts';
import type { Db } from '../db/client.ts';
import { loadSnapshot } from '../db/load-snapshot.ts';
import { withShopLock } from '../db/lock.ts';
import * as s from '../db/schema.ts';

export function saveFact(db: Db, shopId: string, input: { factId: string; value: 'yes' | 'no' }) {
  return withShopLock(db, shopId, async (tx) => {
    const [fact] = await tx.select().from(s.facts).where(and(eq(s.facts.id, input.factId), eq(s.facts.shopId, shopId)));
    if (!fact) return { status: 'refused' as const, reason: 'fact not found' };
    const now = (await loadSnapshot(tx, shopId)).now;
    const questions = await tx.select().from(s.escalations).where(and(eq(s.escalations.factId, fact.id), eq(s.escalations.status, 'open')));
    const [saved] = await tx
      .update(s.facts)
      .set({ value: input.value, source: 'owner', setAt: now, escalationId: questions[0]?.id ?? fact.escalationId, version: sql`${s.facts.version} + 1` })
      .where(eq(s.facts.id, fact.id))
      .returning();
    await logActivity(tx, { shopId, at: now, actor: 'owner', kind: 'fact_saved', payload: { factId: fact.id, key: fact.key, label: fact.label, value: input.value } });

    // A customer who asked about it hears the answer (the agent's owner_answered turn).
    for (const q of questions) {
      await tx.update(s.escalations).set({ status: 'resolved', resolution: { value: input.value } }).where(eq(s.escalations.id, q.id));
      const [conversation] = q.conversationId ? await tx.select().from(s.conversations).where(eq(s.conversations.id, q.conversationId)) : [];
      if (conversation)
        await logActivity(tx, { shopId, at: now, actor: 'owner', kind: 'fact_answered', payload: { customerId: conversation.customerId, factId: fact.id, value: input.value } });
    }
    return { status: 'saved' as const, fact: saved! };
  });
}
