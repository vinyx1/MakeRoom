// Payment operations: recorded in `payment_ops` inside the state change's transaction, run right after it
// commits, retried with the same PayPal-Request-Id (invariant 9). Only voids so far; capture and refund
// follow the same shape.

import { eq } from 'drizzle-orm';
import { logActivity } from '../activity.ts';
import { shopNow } from '../clock.ts';
import type { Db, Tx } from '../db/client.ts';
import { withShopLock } from '../db/lock.ts';
import { Policy } from '../db/policy.ts';
import { escalations, paymentOps, paypalOrders, shops } from '../db/schema.ts';
import type { PaymentGateway } from './gateway.ts';

type Order = typeof paypalOrders.$inferSelect;

/** `{proposal}:{revision}:{kind}:{customer}`. Revisions are immutable, so the amount behind an id never changes. */
export const requestIdFor = (o: Pick<Order, 'proposalId' | 'revisionId' | 'customerId'>, kind: 'void' | 'capture' | 'refund') =>
  `${o.proposalId ?? 'none'}:${o.revisionId ?? 'none'}:${kind}:${o.customerId}`;

/**
 * Records a void for an order's authorization. Call inside the locked transaction that ends the proposal;
 * run the returned op with `runPaymentOp` after it commits. An order with no authorization yet holds no money,
 * so it is marked voided directly and no op is needed.
 */
export async function enqueueVoid(tx: Tx, order: Order, at: Date): Promise<string | null> {
  if (order.status === 'created' || order.status === 'approved') {
    await tx.update(paypalOrders).set({ status: 'voided' }).where(eq(paypalOrders.id, order.id));
    return null;
  }
  if (order.status !== 'authorized') return null;
  const [op] = await tx
    .insert(paymentOps)
    .values({
      shopId: order.shopId,
      kind: 'void',
      paypalOrderRef: order.id,
      amountCents: order.amountCents,
      requestId: requestIdFor(order, 'void'),
      createdAt: at,
    })
    .onConflictDoNothing({ target: paymentOps.requestId })
    .returning();
  return op?.id ?? null;
}

export type RunOptions = { sleep?: (ms: number) => Promise<void> };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Runs one recorded op to success or to `policy.payment_retry_limit` attempts; a final failure alerts the owner. */
export async function runPaymentOp(db: Db, gateway: PaymentGateway, opId: string, { sleep = defaultSleep }: RunOptions = {}) {
  const [op] = await db.select().from(paymentOps).where(eq(paymentOps.id, opId));
  if (!op || op.status !== 'pending') return op;
  const [order] = await db.select().from(paypalOrders).where(eq(paypalOrders.id, op.paypalOrderRef));
  const [shop] = await db.select().from(shops).where(eq(shops.id, op.shopId));
  if (!order || !shop) throw new Error(`payment op ${opId}: order or shop missing`);
  const limit = Policy.parse(shop.policy).payment_retry_limit;

  let attempts = op.attempts;
  let lastError = op.lastError;
  while (attempts < limit) {
    attempts++;
    const result = order.authorizationId
      ? await gateway.voidAuthorization(order.authorizationId, op.requestId)
      : ({ ok: false, error: 'order has no authorization id', retryable: false } as const);

    if (result.ok) {
      return withShopLock(db, op.shopId, async (tx) => {
        const at = shopNow(shop);
        const [done] = await tx
          .update(paymentOps)
          .set({ status: 'succeeded', attempts, paypalRef: result.ref, lastError: null })
          .where(eq(paymentOps.id, op.id))
          .returning();
        await tx.update(paypalOrders).set({ status: 'voided' }).where(eq(paypalOrders.id, order.id));
        await logActivity(tx, {
          shopId: op.shopId, at, actor: 'system', kind: 'payment_voided', proposalId: order.proposalId, revisionId: order.revisionId,
          payload: { authorizationId: order.authorizationId, amountCents: order.amountCents, requestId: op.requestId, attempts },
        });
        return done;
      });
    }

    lastError = result.error;
    await db.update(paymentOps).set({ attempts, lastError }).where(eq(paymentOps.id, op.id));
    if (!result.retryable) break;
    if (attempts < limit) await sleep(500 * attempts);
  }

  return withShopLock(db, op.shopId, async (tx) => {
    const at = shopNow(shop);
    const [failed] = await tx.update(paymentOps).set({ status: 'failed', attempts, lastError }).where(eq(paymentOps.id, op.id)).returning();
    await tx.insert(escalations).values({
      shopId: op.shopId, kind: 'payment_failure', proposalId: order.proposalId, revisionId: order.revisionId,
      reasons: ['payment_failure'], summary: `Voiding the $${(order.amountCents / 100).toFixed(2)} authorization failed after ${attempts} attempts: ${lastError}`,
      at,
    });
    await logActivity(tx, {
      shopId: op.shopId, at, actor: 'system', kind: 'payment_failed', proposalId: order.proposalId, revisionId: order.revisionId,
      payload: { kind: op.kind, requestId: op.requestId, attempts, lastError },
    });
    return failed;
  });
}
