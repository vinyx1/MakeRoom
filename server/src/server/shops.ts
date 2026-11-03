// One shop per visitor (CLAUDE.md "Judge mode"): the session cookie maps to a freshly seeded shop. The shop is
// found by a hash of the cookie, never by anything in the URL.

import { createHash, randomBytes } from 'node:crypto';
import { and, count, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { withShopLock } from '../db/lock.ts';
import * as s from '../db/schema.ts';
import { seedShop, seedShopTx } from '../db/seed.ts';
import type { PaymentGateway } from '../payments/gateway.ts';
import { enqueueVoid, runPaymentOp } from '../payments/ops.ts';
import { seedPrepayments } from '../payments/prepay.ts';

export const newSessionToken = () => randomBytes(32).toString('base64url');
export const sessionKeyOf = (token: string) => createHash('sha256').update(token).digest('hex');

/** A 429: a visitor's network has made too many new shops. Existing shops aren't affected. */
export class ShopLimitReached extends Error {
  statusCode = 429;
  constructor() {
    super('Too many new demo shops from your network. Please try again in a while.');
  }
}

export type NewShopLimit = { ip: string; perHour: number };

/** Seeds a shop, unless this IP has made too many in the last hour. The lock makes a burst of requests count one by one. */
function seedWithinLimit(db: Db, sessionKey: string, limit?: NewShopLimit) {
  if (!limit) return seedShop(db, { sessionKey });
  const creatorIpHash = createHash('sha256').update(limit.ip).digest('hex');
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${creatorIpHash}, 0))`);
    const [row] = await tx
      .select({ n: count() })
      .from(s.shops)
      .where(and(eq(s.shops.creatorIpHash, creatorIpHash), gt(s.shops.createdAt, new Date(Date.now() - 3600_000))));
    if (row!.n >= limit.perHour) throw new ShopLimitReached();
    return seedShopTx(tx, { sessionKey, creatorIpHash });
  });
}

/** The visitor's shop, seeded (with real sandbox prepayments) on first visit. */
export async function shopForSession(db: Db, gateway: PaymentGateway, token: string, limit?: NewShopLimit) {
  const sessionKey = sessionKeyOf(token);
  const [existing] = await db.select().from(s.shops).where(eq(s.shops.sessionKey, sessionKey));
  if (existing) return existing;
  try {
    const seeded = await seedWithinLimit(db, sessionKey, limit);
    await seedPrepayments(db, gateway, seeded.shop.id);
    return seeded.shop;
  } catch (e) {
    // Two first requests from one browser raced to seed; the other one won.
    const [winner] = await db.select().from(s.shops).where(eq(s.shops.sessionKey, sessionKey));
    if (winner) return winner;
    throw e;
  }
}

/**
 * Reset demo: void the shop's open authorizations, then delete the shop (every row cascades) and seed it again
 * under the same session.
 */
export async function resetShop(db: Db, gateway: PaymentGateway, shopId: string) {
  await voidOpenHolds(db, gateway, shopId);
  const [shop] = await db.select().from(s.shops).where(eq(s.shops.id, shopId));
  await db.delete(s.shops).where(eq(s.shops.id, shopId));
  const seeded = await seedShop(db, { sessionKey: shop!.sessionKey });
  await seedPrepayments(db, gateway, seeded.shop.id);
  return seeded.shop;
}

async function voidOpenHolds(db: Db, gateway: PaymentGateway, shopId: string) {
  const opIds = await withShopLock(db, shopId, async (tx) => {
    const [shop] = await tx.select().from(s.shops).where(eq(s.shops.id, shopId));
    const orders = await tx
      .select()
      .from(s.paypalOrders)
      .where(and(eq(s.paypalOrders.shopId, shopId), inArray(s.paypalOrders.status, ['created', 'approved', 'authorized'])));
    const ids: string[] = [];
    for (const o of orders) {
      const id = await enqueueVoid(tx, o, new Date(Date.now() + shop!.clockOffsetMs));
      if (id) ids.push(id);
    }
    return ids;
  });
  for (const id of opIds) await runPaymentOp(db, gateway, id);
}

/** Deletes shops no one has opened for `olderThanHours`, releasing their holds first. A visitor who comes back gets a new shop. */
export async function cleanupStaleShops(db: Db, gateway: PaymentGateway, olderThanHours = 48) {
  const cutoff = new Date(Date.now() - olderThanHours * 3600_000);
  const stale = await db.select({ id: s.shops.id }).from(s.shops).where(lt(s.shops.lastSeenAt, cutoff));
  for (const { id } of stale) {
    await voidOpenHolds(db, gateway, id);
    await db.delete(s.shops).where(and(eq(s.shops.id, id), lt(s.shops.lastSeenAt, cutoff)));
  }
  return stale.length;
}
