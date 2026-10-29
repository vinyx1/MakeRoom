// Seeded prepayments: every demo booking is paid in full up front with a real sandbox card capture, so a later
// refund (Bob's $15) is a real refund on a real capture (spikes/paypal/FINDINGS.md, check 6).
//
// Card orders don't replay under a request id (gotcha 2), so each gets a fresh id and its order id is stored
// the moment it returns.

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { logActivity } from '../activity.ts';
import { shopNow } from '../clock.ts';
import type { Db } from '../db/client.ts';
import { withShopLock } from '../db/lock.ts';
import * as s from '../db/schema.ts';
import type { PaymentGateway } from './gateway.ts';

export async function seedPrepayments(db: Db, gateway: PaymentGateway, shopId: string) {
  const [shop] = await db.select().from(s.shops).where(eq(s.shops.id, shopId));
  const bookings = await db
    .select()
    .from(s.bookings)
    .where(and(eq(s.bookings.shopId, shopId), isNull(s.bookings.prepaidOrderId), inArray(s.bookings.status, ['confirmed', 'picked_up'])));

  const results = await Promise.all(
    bookings.map(async (b) => ({
      booking: b,
      result: await gateway.createOrder({ intent: 'CAPTURE', amountCents: b.priceCents, requestId: randomUUID(), description: 'RentFlow demo prepayment', testCard: true }),
    })),
  );

  return withShopLock(db, shopId, async (tx) => {
    const failed: string[] = [];
    for (const { booking, result } of results) {
      if (!result.ok || !result.captureId) {
        failed.push(booking.id);
        continue;
      }
      const [order] = await tx
        .insert(s.paypalOrders)
        .values({
          shopId, bookingId: booking.id, customerId: booking.customerId, paypalOrderId: result.orderId, intent: 'CAPTURE',
          amountCents: booking.priceCents, captureId: result.captureId, capturedCents: booking.priceCents, status: 'captured',
        })
        .returning();
      await tx.update(s.bookings).set({ prepaidOrderId: order!.id }).where(eq(s.bookings.id, booking.id));
    }
    await logActivity(tx, {
      shopId, at: shopNow(shop!), actor: 'system', kind: 'prepayments_seeded',
      payload: { paid: results.length - failed.length, failed },
    });
    return { paid: results.length - failed.length, failed };
  });
}
