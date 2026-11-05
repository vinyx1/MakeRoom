// One shop per visitor (CLAUDE.md "Judge mode"): the session cookie maps to a freshly seeded shop. The shop is
// found by a hash of the cookie, never by anything in the URL.

import { createHash, randomBytes } from 'node:crypto';
import { and, count, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { withShopLock } from '../db/lock.ts';
import * as s from '../db/schema.ts';
import type { Scenario } from '../db/scenarios.ts';
import { type SeededScenario, seedScenarioTx } from '../db/seed.ts';
import { openYardMorning } from '../demo/yard-morning.ts';
import type { PaymentGateway } from '../payments/gateway.ts';
import { enqueueVoid, runPaymentOp } from '../payments/ops.ts';
import { seedPrepayments } from '../payments/prepay.ts';

export const newSessionToken = () => randomBytes(32).toString('base64url');
export const sessionKeyOf = (token: string) => createHash('sha256').update(token).digest('hex');
/** One visitor has one shop per scenario, each kept as they left it. */
const shopKeyOf = (token: string, scenario: Scenario) => sessionKeyOf(scenario === 'camera' ? token : `${token}:${scenario}`);

/** A 429: a visitor's network has made too many new shops. Existing shops aren't affected. */
export class ShopLimitReached extends Error {
  statusCode = 429;
  constructor() {
    super('Too many new demo shops from your network. Please try again in a while.');
  }
}

export type NewShopLimit = { ip: string; perHour: number };

/** Seeds a shop, unless this IP has made too many in the last hour. The lock makes a burst of requests count one by one. */
function seedWithinLimit(db: Db, scenario: Scenario, sessionKey: string, limit?: NewShopLimit): Promise<SeededScenario> {
  if (!limit) return db.transaction((tx) => seedScenarioTx(tx, scenario, { sessionKey }));
  const creatorIpHash = createHash('sha256').update(limit.ip).digest('hex');
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${creatorIpHash}, 0))`);
    const [row] = await tx
      .select({ n: count() })
      .from(s.shops)
      .where(and(eq(s.shops.creatorIpHash, creatorIpHash), gt(s.shops.createdAt, new Date(Date.now() - 3600_000))));
    if (row!.n >= limit.perHour) throw new ShopLimitReached();
    return seedScenarioTx(tx, scenario, { sessionKey, creatorIpHash });
  });
}

/** What a seeded shop still needs from PayPal, and for the yard, the problems already open when the visitor arrives. */
async function prepareShop(db: Db, gateway: PaymentGateway, seeded: SeededScenario) {
  await seedPrepayments(db, gateway, seeded.data.shop.id);
  if (seeded.scenario === 'yard') await openYardMorning(db, gateway, seeded.data);
}

/** The visitor's shop for this scenario, seeded (with real sandbox prepayments) on first visit. */
export async function shopForSession(db: Db, gateway: PaymentGateway, token: string, limit?: NewShopLimit, scenario: Scenario = 'camera') {
  const sessionKey = shopKeyOf(token, scenario);
  const [existing] = await db.select().from(s.shops).where(eq(s.shops.sessionKey, sessionKey));
  if (existing) return existing;
  try {
    const seeded = await seedWithinLimit(db, scenario, sessionKey, limit);
    await prepareShop(db, gateway, seeded);
    return seeded.data.shop;
  } catch (e) {
    // Two first requests from one browser raced to seed; the other one won.
    const [winner] = await db.select().from(s.shops).where(eq(s.shops.sessionKey, sessionKey));
    if (winner) return winner;
    throw e;
  }
}

/**
 * Reset demo: void the shop's open authorizations, then delete the shop (every row cascades) and seed the same
 * scenario again under the same session.
 */
export async function resetShop(db: Db, gateway: PaymentGateway, shopId: string) {
  await voidOpenHolds(db, gateway, shopId);
  const [shop] = await db.select().from(s.shops).where(eq(s.shops.id, shopId));
  await db.delete(s.shops).where(eq(s.shops.id, shopId));
  const scenario: Scenario = shop!.scenario === 'yard' ? 'yard' : 'camera';
  const seeded = await db.transaction((tx) => seedScenarioTx(tx, scenario, { sessionKey: shop!.sessionKey }));
  await prepareShop(db, gateway, seeded);
  return seeded.data.shop;
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
