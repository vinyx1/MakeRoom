// The shared seed from `demo script.md`. Every visitor's shop starts here.
// Days are relative to the demo week (the current Mon–Sat in the shop's time zone), and the shop clock
// is offset so that "now" is Wednesday 2pm.
//
// Not yet seeded: the PayPal prepayments. Those are real sandbox captures, made when the payments
// module exists; until then `bookings.prepaid_order_id` is null.

import { DateTime } from 'luxon';
import { rentalPriceCents } from '../pricing.ts';
import type { Db, Tx } from './client.ts';
import { defaultPolicy } from './policy.ts';
import * as s from './schema.ts';

export const DEMO_TIMEZONE = 'America/Los_Angeles';

type DemoTime = { week?: 0 | 1; day: 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun'; hour: number };
const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Monday 00:00 of the demo week, in the shop's zone. */
export const demoWeekStart = (realNow: Date, tz = DEMO_TIMEZONE) =>
  DateTime.fromJSDate(realNow, { zone: tz }).startOf('week');

export function seedShop(db: Db, opts: { sessionKey: string; realNow?: Date }) {
  return db.transaction((tx) => seedShopTx(tx, opts));
}

export async function seedShopTx(tx: Tx, { sessionKey, realNow = new Date() }: { sessionKey: string; realNow?: Date }) {
  const monday = demoWeekStart(realNow);
  const t = ({ week = 0, day, hour }: DemoTime) =>
    monday.plus({ weeks: week, days: WEEKDAY[day] - 1 }).set({ hour }).toJSDate();
  const now = t({ day: 'Wed', hour: 14 });
  const policy = defaultPolicy();
  const bufferMs = policy.default_buffer_minutes * 60_000;

  const [shop] = await tx
    .insert(s.shops)
    .values({
      name: 'Lens & Light Rentals',
      timezone: DEMO_TIMEZONE,
      opensAt: '09:00',
      closesAt: '21:00',
      clockOffsetMs: now.getTime() - realNow.getTime(),
      policy,
      sessionKey,
    })
    .returning();
  const shopId = shop!.id;

  const modelRows = await tx
    .insert(s.equipmentModels)
    .values(
      [
        { name: 'Sony A7 IV', category: 'camera_body', tier: 1, dailyRateCents: 4500 },
        { name: 'Sony A7R V', category: 'camera_body', tier: 2, dailyRateCents: 6500 },
        { name: 'DJI RS3 gimbal', category: 'gimbal', tier: 2, dailyRateCents: 2500 },
        { name: 'Zhiyun Crane 4 gimbal', category: 'gimbal', tier: 1, dailyRateCents: 2000 },
      ].map((m) => ({ ...m, shopId, rateMinCents: m.dailyRateCents / 2, rateMaxCents: m.dailyRateCents * 2 })),
    )
    .returning();
  const model = (name: string) => modelRows.find((m) => m.name === name)!;
  const a7iv = model('Sony A7 IV'), a7rv = model('Sony A7R V');
  const rs3 = model('DJI RS3 gimbal'), crane4 = model('Zhiyun Crane 4 gimbal');

  await tx.insert(s.modelSubstitutes).values(
    [[a7iv, a7rv], [a7rv, a7iv], [rs3, crane4], [crane4, rs3]].map(([m, sub]) => ({
      shopId,
      modelId: m!.id,
      substituteModelId: sub!.id,
    })),
  );

  const unitRows = await tx
    .insert(s.units)
    .values(
      [
        ['A7IV-1', a7iv], ['A7IV-2', a7iv], ['A7IV-3', a7iv],
        ['A7RV-1', a7rv], ['RS3-1', rs3], ['CRANE4-1', crane4],
      ].map(([label, m]) => ({ shopId, label: label as string, modelId: (m as typeof a7iv).id })),
    )
    .returning();
  const unit = (label: string) => unitRows.find((u) => u.label === label)!;

  await tx.insert(s.unitUnavailability).values({
    shopId,
    unitId: unit('A7IV-3').id,
    period: { start: t({ day: 'Wed', hour: 9 }), end: t({ day: 'Fri', hour: 21 }) },
    reason: 'maintenance',
  });

  await tx.insert(s.facts).values({
    shopId,
    unitId: unit('CRANE4-1').id,
    key: 'balances_r5_rf2470',
    value: 'unknown',
    source: 'seed',
    setAt: now,
  });

  const customerRows = await tx
    .insert(s.customers)
    .values(
      ['Alice', 'Bob', 'Charlie', 'Dana', 'Eve', 'Gina', 'Hank'].map((name) => ({
        shopId,
        name,
        email: `${name.toLowerCase()}@example.com`,
      })),
    )
    .returning();
  const customer = (name: string) => customerRows.find((c) => c.name === name)!;

  const booking = (
    name: string, label: string, start: DemoTime, end: DemoTime,
    status: 'confirmed' | 'picked_up', note?: string,
  ) => {
    const u = unit(label);
    const m = modelRows.find((x) => x.id === u.modelId)!;
    const startsAt = t(start), endsAt = t(end);
    return {
      shopId,
      customerId: customer(name).id,
      modelId: m.id,
      unitId: u.id,
      startsAt,
      endsAt,
      bufferEndsAt: new Date(endsAt.getTime() + bufferMs),
      status,
      priceCents: rentalPriceCents(m.dailyRateCents, startsAt, endsAt),
      note,
    };
  };
  const bookingRows = await tx
    .insert(s.bookings)
    .values([
      booking('Alice', 'A7IV-1', { day: 'Mon', hour: 9 }, { day: 'Wed', hour: 18 }, 'picked_up'),
      booking('Bob', 'A7IV-1', { day: 'Thu', hour: 9 }, { day: 'Fri', hour: 18 }, 'confirmed'),
      booking('Charlie', 'A7IV-2', { day: 'Thu', hour: 9 }, { day: 'Fri', hour: 18 }, 'confirmed'),
      booking('Gina', 'A7IV-2', { day: 'Sat', hour: 9 }, { day: 'Sun', hour: 18 }, 'confirmed'),
      booking('Hank', 'A7IV-2', { week: 1, day: 'Mon', hour: 9 }, { week: 1, day: 'Tue', hour: 18 }, 'confirmed'),
      booking('Dana', 'RS3-1', { day: 'Tue', hour: 9 }, { day: 'Thu', hour: 9 }, 'picked_up'),
      booking('Eve', 'RS3-1', { day: 'Thu', hour: 14 }, { day: 'Sat', hour: 18 }, 'confirmed', 'for Canon R5 + RF 24-70'),
    ])
    .returning();

  await tx.insert(s.conversations).values(customerRows.map((c) => ({ shopId, customerId: c.id })));

  return {
    shop: shop!,
    now,
    models: { a7iv, a7rv, rs3, crane4 },
    unit,
    customer,
    bookingOf: (name: string) => bookingRows.find((b) => b.customerId === customer(name).id)!,
  };
}
