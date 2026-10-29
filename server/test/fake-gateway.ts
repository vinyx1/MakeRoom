// A PayPal stand-in that keeps real money state (holds, captures, refunds) and records every call.
// Script failures with `failNext`. Replays a request id the way PayPal does: same id → first result.

import { randomUUID } from 'node:crypto';
import type { CreatedOrder, GatewayResult, PaymentGateway } from '../src/payments/gateway.ts';

type Call = { method: string; id: string; amountCents?: number; requestId: string };

export function fakeGateway() {
  const calls: Call[] = [];
  const replies = new Map<string, GatewayResult | CreatedOrder>();
  const failures: Record<string, GatewayResult[]> = {};
  const auths = new Map<string, { amountCents: number; status: 'CREATED' | 'CAPTURED' | 'VOIDED' }>();
  const captures = new Map<string, { amountCents: number; refundedCents: number }>();
  const orders = new Map<string, { amountCents: number; authorizationId: string | null }>();

  function once<T extends GatewayResult | CreatedOrder>(method: string, requestId: string, run: () => T): T {
    const scripted = failures[method]?.shift();
    if (scripted) return scripted as T;
    const key = `${method}:${requestId}`;
    if (!replies.has(key)) replies.set(key, run());
    return replies.get(key) as T;
  }
  const refuse = (error: string): GatewayResult => ({ ok: false, error, retryable: false });

  const gateway: PaymentGateway = {
    async createOrder({ intent, amountCents, requestId, testCard }) {
      calls.push({ method: 'createOrder', id: intent, amountCents, requestId });
      return once('createOrder', requestId, (): CreatedOrder => {
        const orderId = `ORDER-${randomUUID()}`;
        let authorizationId: string | null = null, captureId: string | null = null;
        if (testCard && intent === 'AUTHORIZE') auths.set((authorizationId = `AUTH-${randomUUID()}`), { amountCents, status: 'CREATED' });
        if (testCard && intent === 'CAPTURE') captures.set((captureId = `CAP-${randomUUID()}`), { amountCents, refundedCents: 0 });
        orders.set(orderId, { amountCents, authorizationId });
        return { ok: true, orderId, authorizationId, captureId };
      });
    },
    async authorizeOrder(orderId, requestId) {
      calls.push({ method: 'authorizeOrder', id: orderId, requestId });
      return once('authorizeOrder', requestId, () => {
        const o = orders.get(orderId);
        if (!o) return refuse('404 RESOURCE_NOT_FOUND');
        const id = `AUTH-${randomUUID()}`;
        auths.set(id, { amountCents: o.amountCents, status: 'CREATED' });
        return { ok: true, ref: id };
      });
    },
    async captureAuthorization(authorizationId, amountCents, requestId) {
      calls.push({ method: 'captureAuthorization', id: authorizationId, amountCents, requestId });
      return once('captureAuthorization', requestId, () => {
        const a = auths.get(authorizationId);
        if (!a || a.status !== 'CREATED') return refuse('422 AUTHORIZATION_VOIDED');
        if (amountCents > Math.round(a.amountCents * 1.15)) return refuse('422 MAX_CAPTURE_AMOUNT_EXCEEDED');
        a.status = 'CAPTURED';
        const id = `CAP-${randomUUID()}`;
        captures.set(id, { amountCents, refundedCents: 0 });
        return { ok: true, ref: id };
      });
    },
    async refundCapture(captureId, amountCents, requestId) {
      calls.push({ method: 'refundCapture', id: captureId, amountCents, requestId });
      return once('refundCapture', requestId, () => {
        const c = captures.get(captureId);
        if (!c) return refuse('404 RESOURCE_NOT_FOUND');
        if (c.refundedCents + amountCents > c.amountCents) return refuse('422 REFUND_AMOUNT_EXCEEDED');
        c.refundedCents += amountCents;
        return { ok: true, ref: `REF-${randomUUID()}` };
      });
    },
    async voidAuthorization(authorizationId, requestId) {
      calls.push({ method: 'voidAuthorization', id: authorizationId, requestId });
      return once('voidAuthorization', requestId, () => {
        const a = auths.get(authorizationId);
        if (a?.status === 'CAPTURED') return refuse('422 AUTHORIZATION_ALREADY_CAPTURED');
        if (a) a.status = 'VOIDED';
        return { ok: true, ref: authorizationId };
      });
    },
  };

  return {
    ...gateway,
    calls,
    auths,
    captures,
    /** The next calls of `method` return these, in order. */
    failNext: (method: keyof PaymentGateway, ...results: GatewayResult[]) => (failures[method] = [...(failures[method] ?? []), ...results]),
  };
}
