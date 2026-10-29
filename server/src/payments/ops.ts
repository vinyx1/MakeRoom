// Payment operations: recorded in `payment_ops` inside the state change's transaction, run right after it
// commits, retried with the same PayPal-Request-Id (invariant 9). In the PoC they run inline; the same table
// becomes the outbox later.

import { eq, sql } from 'drizzle-orm';
import { logActivity } from '../activity.ts';
import { shopNow } from '../clock.ts';
import type { Db, Tx } from '../db/client.ts';
import { withShopLock } from '../db/lock.ts';
import { Policy } from '../db/policy.ts';
import { escalations, paymentOps, paypalOrders, shops } from '../db/schema.ts';
import type { GatewayResult, PaymentGateway } from './gateway.ts';

type Order = typeof paypalOrders.$inferSelect;
type OpKind = (typeof paymentOps.$inferSelect)['kind'];

/** `{proposal}:{revision}:{kind}:{customer}`. Revisions are immutable, so the amount behind an id never changes. */
export const requestId = (proposalId: string | null, revisionId: string | null, kind: OpKind, customerId: string) =>
  `${proposalId ?? 'none'}:${revisionId ?? 'none'}:${kind}:${customerId}`;

/** Records an op; returns its id. Recording the same request id twice returns the existing op. */
export async function enqueueOp(
  tx: Tx,
  input: { order: Order; kind: OpKind; amountCents: number; proposalId: string | null; revisionId: string | null; customerId: string; at: Date },
): Promise<string> {
  const id = requestId(input.proposalId, input.revisionId, input.kind, input.customerId);
  const [op] = await tx
    .insert(paymentOps)
    .values({ shopId: input.order.shopId, kind: input.kind, paypalOrderRef: input.order.id, amountCents: input.amountCents, requestId: id, createdAt: input.at })
    .onConflictDoNothing({ target: paymentOps.requestId })
    .returning();
  if (op) return op.id;
  const [existing] = await tx.select().from(paymentOps).where(eq(paymentOps.requestId, id));
  return existing!.id;
}

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
  return enqueueOp(tx, {
    order, kind: 'void', amountCents: order.amountCents, proposalId: order.proposalId, revisionId: order.revisionId, customerId: order.customerId, at,
  });
}

export type RunOptions = { sleep?: (ms: number) => Promise<void> };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const PAST = { authorize: 'authorized', capture: 'captured', refund: 'refunded', void: 'voided' } as const;

function call(gateway: PaymentGateway, op: typeof paymentOps.$inferSelect, order: Order): Promise<GatewayResult> {
  const missing = (what: string) => Promise.resolve({ ok: false as const, error: `order has no ${what}`, retryable: false });
  switch (op.kind) {
    case 'authorize':
      return gateway.authorizeOrder(order.paypalOrderId, op.requestId);
    case 'capture':
      return order.authorizationId ? gateway.captureAuthorization(order.authorizationId, op.amountCents, op.requestId) : missing('authorization');
    case 'refund':
      return order.captureId ? gateway.refundCapture(order.captureId, op.amountCents, op.requestId) : missing('capture');
    case 'void':
      return order.authorizationId ? gateway.voidAuthorization(order.authorizationId, op.requestId) : missing('authorization');
  }
}

/** Runs one recorded op to success or to `policy.payment_retry_limit` attempts; a final failure alerts the owner. */
export async function runPaymentOp(db: Db, gateway: PaymentGateway, opId: string, { sleep = defaultSleep }: RunOptions = {}) {
  const [op] = await db.select().from(paymentOps).where(eq(paymentOps.id, opId));
  if (!op || op.status !== 'pending') return op!;
  const [order] = await db.select().from(paypalOrders).where(eq(paypalOrders.id, op.paypalOrderRef));
  const [shop] = await db.select().from(shops).where(eq(shops.id, op.shopId));
  if (!order || !shop) throw new Error(`payment op ${opId}: order or shop missing`);
  const limit = Policy.parse(shop.policy).payment_retry_limit;

  let attempts = op.attempts;
  let lastError = op.lastError;
  while (attempts < limit) {
    attempts++;
    const result = await call(gateway, op, order);

    if (result.ok) {
      return withShopLock(db, op.shopId, async (tx) => {
        const at = shopNow(shop);
        const [done] = await tx
          .update(paymentOps)
          .set({ status: 'succeeded', attempts, paypalRef: result.ref, lastError: null })
          .where(eq(paymentOps.id, op.id))
          .returning();
        const orderUpdate =
          op.kind === 'authorize' ? { status: 'authorized' as const, authorizationId: result.ref }
          : op.kind === 'capture' ? { status: 'captured' as const, captureId: result.ref, capturedCents: op.amountCents }
          : op.kind === 'refund' ? { refundedCents: sql`${paypalOrders.refundedCents} + ${op.amountCents}` }
          : { status: 'voided' as const };
        await tx.update(paypalOrders).set(orderUpdate).where(eq(paypalOrders.id, order.id));
        await logActivity(tx, {
          shopId: op.shopId, at, actor: 'system', kind: `payment_${PAST[op.kind]}`,
          proposalId: proposalOf(op.requestId), revisionId: revisionOf(op.requestId),
          payload: { orderId: order.paypalOrderId, customerId: order.customerId, amountCents: op.amountCents, paypalRef: result.ref, requestId: op.requestId, attempts },
        });
        return done!;
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
    // A failed authorization leaves the order unusable; the next attempt starts a new order.
    if (op.kind === 'authorize') await tx.update(paypalOrders).set({ status: 'failed' }).where(eq(paypalOrders.id, order.id));
    await tx.insert(escalations).values({
      shopId: op.shopId, kind: 'payment_failure', proposalId: proposalOf(op.requestId), revisionId: revisionOf(op.requestId),
      reasons: ['payment_failure'],
      summary: `PayPal ${op.kind} of $${(op.amountCents / 100).toFixed(2)} failed after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${lastError}`,
      at,
    });
    await logActivity(tx, {
      shopId: op.shopId, at, actor: 'system', kind: 'payment_failed', proposalId: proposalOf(op.requestId), revisionId: revisionOf(op.requestId),
      payload: { kind: op.kind, requestId: op.requestId, attempts, lastError },
    });
    return failed!;
  });
}

const UUID = /^[0-9a-f-]{36}$/;
const proposalOf = (id: string) => (UUID.test(id.split(':')[0]!) ? id.split(':')[0]! : null);
const revisionOf = (id: string) => (UUID.test(id.split(':')[1]!) ? id.split(':')[1]! : null);
