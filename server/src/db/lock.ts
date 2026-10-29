import { sql } from 'drizzle-orm';
import type { Db, Tx } from './client.ts';

/**
 * Invariant 5: every write for a shop runs here. Takes the per-shop advisory lock first, so the
 * read → validate → write inside `fn` can't interleave with another write to the same shop.
 * The lock releases when the transaction commits or rolls back.
 */
export function withShopLock<T>(db: Db, shopId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${shopId}::text, 0))`);
    return fn(tx);
  });
}

/**
 * Lets this transaction shorten a picked-up rental. Only the owner may (invariant 3); the
 * `bookings_picked_up_guard` trigger rejects it otherwise.
 */
export async function allowOwnerShorten(tx: Tx) {
  await tx.execute(sql`SELECT set_config('rentflow.owner_shorten', 'on', true)`);
}
