// One shop per visitor (CLAUDE.md "Judge mode"): the session cookie maps to a freshly seeded shop. The shop is
// found by a hash of the cookie, never by anything in the URL.

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { withShopLock } from '../db/lock.ts';
import * as s from '../db/schema.ts';
import { seedShop } from '../db/seed.ts';
import type { PaymentGateway } from '../payments/gateway.ts';
import { enqueueVoid, runPaymentOp } from '../payments/ops.ts';
import { seedPrepayments } from '../payments/prepay.ts';

export const newSessionToken = () => randomBytes(32).toString('base64url');
export const sessionKeyOf = (token: string) => createHash('sha256').update(token).digest('hex');

/** The visitor's shop, seeded (with real sandbox prepayments) on first visit. */
export async function shopForSession(db: Db, gateway: PaymentGateway, token: string) {
  const sessionKey = sessionKeyOf(token);
  const [existing] = await db.select().from(s.shops).where(eq(s.shops.sessionKey, sessionKey));
  if (existing) return existing;
  try {
    const seeded = await seedShop(db, { sessionKey });
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

  const [shop] = await db.select().from(s.shops).where(eq(s.shops.id, shopId));
  await db.delete(s.shops).where(eq(s.shops.id, shopId));
  const seeded = await seedShop(db, { sessionKey: shop!.sessionKey });
  await seedPrepayments(db, gateway, seeded.shop.id);
  return seeded.shop;
}
