import type { Tx } from './db/client.ts';
import { activityLog } from './db/schema.ts';

export type Actor = 'agent' | 'owner' | 'system' | `customer:${string}`;

/** Invariant 12: everything goes to the owner's activity feed. */
export function logActivity(
  tx: Tx,
  entry: { shopId: string; at: Date; actor: Actor; kind: string; proposalId?: string | null; revisionId?: string | null; payload?: Record<string, unknown> },
) {
  return tx.insert(activityLog).values({ ...entry, payload: entry.payload ?? {} });
}
