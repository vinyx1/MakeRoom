// The shared seed from `demo script.md`. Every visitor's shop starts here.
// Days are relative to the demo week (the current Mon–Sun in the shop's time zone), and the shop clock
// is offset so that "now" is Wednesday 5:30pm, 30 minutes before Vincent's rental is due back.
//
// `demoShopData` builds the rows as plain data (the optimizer tests use it without a database);
// `seedShop` inserts them.
//
// Not yet seeded: the PayPal prepayments. Those are real sandbox captures, made when the payments
// module exists; until then `bookings.prepaid_order_id` is null.

import { randomUUID } from 'node:crypto';
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

export type DemoShop = ReturnType<typeof demoShopData>;

export function demoShopData({ sessionKey, realNow = new Date(), creatorIpHash = null }: { sessionKey: string; realNow?: Date; creatorIpHash?: string | null }) {
  const monday = demoWeekStart(realNow);
  const t = ({ week = 0, day, hour }: DemoTime) =>
    monday.plus({ weeks: week, days: WEEKDAY[day] - 1 }).set({ hour }).toJSDate();
  // 30 minutes before Vincent's return (her booking below ends Wed 6pm).
  const now = new Date(t({ day: 'Wed', hour: 18 }).getTime() - 30 * 60_000);
  const policy = defaultPolicy();
  const bufferMs = policy.default_buffer_minutes * 60_000;

  const shop: typeof s.shops.$inferSelect = {
    id: randomUUID(),
    name: 'Lens & Light Rentals',
    timezone: DEMO_TIMEZONE,
    opensAt: '09:00:00',
    closesAt: '21:00:00',
    clockOffsetMs: now.getTime() - realNow.getTime(),
    policy,
    agentTurnsUsed: 0,
    autoReplyCustomers: false,
    sessionKey,
    creatorIpHash,
    lastSeenAt: realNow,
    createdAt: realNow,
  };
  const shopId = shop.id;

  const models: (typeof s.equipmentModels.$inferSelect)[] = [
    { name: 'Sony A7 IV', category: 'camera_body', tier: 1, dailyRateCents: 4500 },
    { name: 'Sony A7R V', category: 'camera_body', tier: 2, dailyRateCents: 6500 },
    { name: 'DJI RS3 gimbal', category: 'gimbal', tier: 2, dailyRateCents: 2500 },
    { name: 'Zhiyun Crane 4 gimbal', category: 'gimbal', tier: 1, dailyRateCents: 2000 },
  ].map((m) => ({
    ...m,
    id: randomUUID(),
    shopId,
    rateMinCents: m.dailyRateCents / 2,
    rateMaxCents: m.dailyRateCents * 2,
  }));
  const model = (name: string) => models.find((m) => m.name === name)!;
  const a7iv = model('Sony A7 IV'), a7rv = model('Sony A7R V');
  const rs3 = model('DJI RS3 gimbal'), crane4 = model('Zhiyun Crane 4 gimbal');

  const substitutes: (typeof s.modelSubstitutes.$inferSelect)[] = [
    [a7iv, a7rv], [a7rv, a7iv], [rs3, crane4], [crane4, rs3],
  ].map(([m, sub]) => ({ id: randomUUID(), shopId, modelId: m!.id, substituteModelId: sub!.id }));

  const units: (typeof s.units.$inferSelect)[] = (
    [
      ['A7IV-1', a7iv], ['A7IV-2', a7iv], ['A7IV-3', a7iv],
      ['A7RV-1', a7rv], ['RS3-1', rs3], ['CRANE4-1', crane4],
    ] as const
  ).map(([label, m]) => ({ id: randomUUID(), shopId, label, modelId: m.id, active: true }));
  const unit = (label: string) => units.find((u) => u.label === label)!;

  const unavailability: (typeof s.unitUnavailability.$inferSelect)[] = [
    {
      id: randomUUID(),
      shopId,
      unitId: unit('A7IV-3').id,
      period: { start: t({ day: 'Wed', hour: 9 }), end: t({ day: 'Fri', hour: 21 }) },
      reason: 'maintenance',
      version: 1,
    },
  ];

  const facts: (typeof s.facts.$inferSelect)[] = [
    {
      id: randomUUID(),
      shopId,
      unitId: unit('CRANE4-1').id,
      modelId: null,
      key: 'balances_r5_rf2470',
      label: 'Balances a Canon R5 + RF 24-70',
      value: 'unknown',
      source: 'seed',
      setAt: now,
      escalationId: null,
      version: 1,
    },
  ];

  const customers: (typeof s.customers.$inferSelect)[] = ['Vincent', 'Bob', 'Charlie', 'Dana', 'Eve', 'Gina', 'Hank'].map(
    (name) => ({ id: randomUUID(), shopId, name, email: `${name.toLowerCase()}@example.com`, flagged: false }),
  );
  const customer = (name: string) => customers.find((c) => c.name === name)!;

  const booking = (
    name: string,
    label: string,
    start: DemoTime,
    end: DemoTime,
    status: 'confirmed' | 'picked_up',
    extra: { note?: string; requiredFacts?: string[] } = {},
  ): typeof s.bookings.$inferSelect => {
    const u = unit(label);
    const m = models.find((x) => x.id === u.modelId)!;
    const startsAt = t(start), endsAt = t(end);
    return {
      id: randomUUID(),
      shopId,
      customerId: customer(name).id,
      modelId: m.id,
      unitId: u.id,
      startsAt,
      endsAt,
      bufferEndsAt: new Date(endsAt.getTime() + bufferMs),
      status,
      overdueMarkedAt: null,
      noShowMarkedAt: null,
      priceCents: rentalPriceCents(m.dailyRateCents, startsAt, endsAt),
      prepaidOrderId: null,
      note: extra.note ?? null,
      requiredFacts: extra.requiredFacts ?? [],
      version: 1,
    };
  };
  const bookings = [
    booking('Vincent', 'A7IV-1', { day: 'Mon', hour: 9 }, { day: 'Wed', hour: 18 }, 'picked_up'),
    booking('Bob', 'A7IV-1', { day: 'Thu', hour: 9 }, { day: 'Fri', hour: 18 }, 'confirmed'),
    booking('Charlie', 'A7IV-2', { day: 'Thu', hour: 9 }, { day: 'Fri', hour: 18 }, 'confirmed'),
    booking('Gina', 'A7IV-2', { day: 'Sat', hour: 9 }, { day: 'Sun', hour: 18 }, 'confirmed'),
    booking('Hank', 'A7IV-2', { week: 1, day: 'Mon', hour: 9 }, { week: 1, day: 'Tue', hour: 18 }, 'confirmed'),
    booking('Dana', 'RS3-1', { day: 'Tue', hour: 9 }, { day: 'Thu', hour: 9 }, 'picked_up'),
    booking('Eve', 'RS3-1', { day: 'Thu', hour: 14 }, { day: 'Sat', hour: 18 }, 'confirmed', {
      note: 'for Canon R5 + RF 24-70',
      requiredFacts: ['balances_r5_rf2470'],
    }),
  ];

  const conversations: (typeof s.conversations.$inferSelect)[] = customers.map((c) => ({
    id: randomUUID(),
    shopId,
    customerId: c.id,
    handedOffAt: null,
    handoffReason: null,
    handedBackAt: null,
  }));

  return {
    shop,
    now,
    models,
    substitutes,
    units,
    unavailability,
    conditionNotes: [] as (typeof s.conditionNotes.$inferSelect)[],
    facts,
    customers,
    bookings,
    conversations,
    // Lookups for tests and scripts.
    modelsByName: { a7iv, a7rv, rs3, crane4 },
    unit,
    customer,
    bookingOf: (name: string) => bookings.find((b) => b.customerId === customer(name).id)!,
  };
}

type SeedOptions = { sessionKey: string; realNow?: Date; creatorIpHash?: string | null };

export function seedShop(db: Db, opts: SeedOptions) {
  return db.transaction((tx) => seedShopTx(tx, opts));
}

export async function seedShopTx(tx: Tx, opts: SeedOptions) {
  const d = demoShopData(opts);
  await tx.insert(s.shops).values(d.shop);
  await tx.insert(s.equipmentModels).values(d.models);
  await tx.insert(s.modelSubstitutes).values(d.substitutes);
  await tx.insert(s.units).values(d.units);
  await tx.insert(s.unitUnavailability).values(d.unavailability);
  await tx.insert(s.facts).values(d.facts);
  await tx.insert(s.customers).values(d.customers);
  await tx.insert(s.bookings).values(d.bookings);
  await tx.insert(s.conversations).values(d.conversations);
  return d;
}
