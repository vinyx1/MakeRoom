// The equipment yard: 18 machines, 13 contractors, 25 bookings. "Now" is Monday 6:30am after a rainy weekend, so jobs
// have slipped and their machines are due back into bookings that are already paid for. The opening problems themselves
// are started through the real proposal flow (src/demo/yard-morning.ts); this file is only the schedule they land on.
//
// The schedule is arranged so each problem has one honest answer, listed on the booking that causes it. Changing a time
// here can change which plans the optimizer finds; test/yard.test.ts pins them.

import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { rentalPriceCents } from '../pricing.ts';
import { defaultPolicy } from './policy.ts';
import * as s from './schema.ts';

const TIMEZONE = 'America/Los_Angeles';
const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
type Day = keyof typeof WEEKDAY;
export type YardTime = { week?: -1 | 0 | 1; day: Day; hour: number };

export function yardShopData({ sessionKey, realNow = new Date(), creatorIpHash = null }: { sessionKey: string; realNow?: Date; creatorIpHash?: string | null }) {
  const monday = DateTime.fromJSDate(realNow, { zone: TIMEZONE }).startOf('week');
  const t = ({ week = 0, day, hour }: YardTime) => monday.plus({ weeks: week, days: WEEKDAY[day] - 1 }).set({ hour }).toJSDate();
  const now = new Date(t({ day: 'Mon', hour: 6 }).getTime() + 30 * 60_000);
  const policy = {
    ...defaultPolicy(),
    default_buffer_minutes: 180, // haul back and a service check
    approval_timeout_minutes: 240, // contractors are on site, not at a screen
    compensation_cap_cents: 30_000,
    shift_compensation_cents_per_hour: 2_500,
    downgrade_goodwill_cents: 5_000,
    max_shift_hours: 8,
  };

  const shop: typeof s.shops.$inferSelect = {
    id: randomUUID(),
    name: 'Ridgeline Equipment Rental',
    scenario: 'yard',
    timezone: TIMEZONE,
    opensAt: '06:00:00',
    closesAt: '18:00:00',
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
    { name: 'Kubota U35 mini excavator', category: 'excavator', tier: 1, dailyRateCents: 34_000 },
    { name: 'Kubota U55 excavator', category: 'excavator', tier: 2, dailyRateCents: 48_000 },
    { name: 'Cat 308 excavator', category: 'excavator', tier: 3, dailyRateCents: 72_000 },
    { name: 'Bobcat S66 skid steer', category: 'loader', tier: 1, dailyRateCents: 32_000 },
    { name: 'Bobcat T66 track loader', category: 'loader', tier: 2, dailyRateCents: 38_000 },
    { name: 'JCB 507 telehandler', category: 'telehandler', tier: 1, dailyRateCents: 52_000 },
    { name: 'Genie GTH-1056 telehandler', category: 'telehandler', tier: 2, dailyRateCents: 64_000 },
    { name: 'JLG 1930 scissor lift', category: 'aerial_lift', tier: 1, dailyRateCents: 13_000 },
    { name: 'JLG 2646 scissor lift', category: 'aerial_lift', tier: 2, dailyRateCents: 19_000 },
    { name: 'Wacker RD12 roller', category: 'compaction', tier: 1, dailyRateCents: 26_000 },
  ].map((m) => ({ ...m, id: randomUUID(), shopId, rateMinCents: m.dailyRateCents / 2, rateMaxCents: m.dailyRateCents * 2 }));
  const model = (prefix: string) => models.find((m) => m.name.startsWith(prefix))!;

  const substitutes: (typeof s.modelSubstitutes.$inferSelect)[] = (
    [
      ['Kubota U35', 'Kubota U55'], ['Kubota U55', 'Kubota U35'], ['Kubota U55', 'Cat 308'], ['Cat 308', 'Kubota U55'],
      ['Bobcat S66', 'Bobcat T66'], ['Bobcat T66', 'Bobcat S66'],
      ['JCB 507', 'Genie GTH'], ['Genie GTH', 'JCB 507'],
      ['JLG 1930', 'JLG 2646'], ['JLG 2646', 'JLG 1930'],
    ] as const
  ).map(([a, b]) => ({ id: randomUUID(), shopId, modelId: model(a).id, substituteModelId: model(b).id }));

  const units: (typeof s.units.$inferSelect)[] = (
    [
      ['U35-1', 'Kubota U35'], ['U35-2', 'Kubota U35'], ['U35-3', 'Kubota U35'],
      ['U55-1', 'Kubota U55'], ['U55-2', 'Kubota U55'], ['CAT308-1', 'Cat 308'],
      ['S66-1', 'Bobcat S66'], ['S66-2', 'Bobcat S66'], ['S66-3', 'Bobcat S66'],
      ['T66-1', 'Bobcat T66'], ['T66-2', 'Bobcat T66'],
      ['JCB507-1', 'JCB 507'], ['GTH1056-1', 'Genie GTH'],
      ['SL1930-1', 'JLG 1930'], ['SL1930-2', 'JLG 1930'], ['SL2646-1', 'JLG 2646'],
      ['RD12-1', 'Wacker RD12'], ['RD12-2', 'Wacker RD12'],
    ] as const
  ).map(([label, m]) => ({ id: randomUUID(), shopId, label, modelId: model(m).id, active: true }));
  const unit = (label: string) => units.find((u) => u.label === label)!;

  const gate = { key: 'fits_8ft_gate', label: 'Fits through an 8 ft site gate' };
  const fact = (label: string, value: 'yes' | 'unknown'): typeof s.facts.$inferSelect => ({
    id: randomUUID(), shopId, unitId: unit(label).id, modelId: null, ...gate, value, source: 'seed', setAt: now, escalationId: null, version: 1,
  });
  const facts = [fact('U55-1', 'yes'), fact('U55-2', 'yes'), fact('CAT308-1', 'unknown')];

  const customers: (typeof s.customers.$inferSelect)[] = [
    'Harbor Concrete', 'Northside Landscaping', 'Delgado Paving', 'Greenline Landscape', 'Redwood Utilities', 'Mesa Septic', 'Bayview',
    'Summit Grading', 'Alder Homes', 'Cascade Demolition', 'Pacific Steel', 'Coastline Roofing', 'Dune Framing',
  ].map((name) => ({ id: randomUUID(), shopId, name, email: `${name.toLowerCase().replaceAll(' ', '.')}@example.com`, flagged: false }));
  const customer = (name: string) => customers.find((c) => c.name === name)!;

  const booking = (
    name: string, label: string, start: YardTime, end: YardTime, status: 'confirmed' | 'picked_up',
    extra: { note?: string; requiredFacts?: string[]; bufferHours?: number } = {},
  ): typeof s.bookings.$inferSelect => {
    const u = unit(label);
    const m = models.find((x) => x.id === u.modelId)!;
    const startsAt = t(start), endsAt = t(end);
    return {
      id: randomUUID(), shopId, customerId: customer(name).id, modelId: m.id, unitId: u.id, startsAt, endsAt,
      bufferEndsAt: new Date(endsAt.getTime() + (extra.bufferHours !== undefined ? extra.bufferHours * 3_600_000 : policy.default_buffer_minutes * 60_000)),
      status, overdueMarkedAt: null, noShowMarkedAt: null, priceCents: rentalPriceCents(m.dailyRateCents, startsAt, endsAt),
      prepaidOrderId: null, note: extra.note ?? null, requiredFacts: extra.requiredFacts ?? [], version: 1,
    };
  };
  const last = (day: Day, hour: number): YardTime => ({ week: -1, day, hour });
  const on = (day: Day, hour: number): YardTime => ({ day, hour });

  const bookings = [
    // Problem 1, the rain delay: Harbor's skid steer runs into Northside. Northside can take S66-2 (same model, a notice
    // only) if Delgado takes the free T66-1 for Tuesday: a chain of two moves.
    booking('Harbor Concrete', 'S66-1', last('Thu', 7), on('Mon', 16), 'picked_up'),
    booking('Northside Landscaping', 'S66-1', on('Tue', 7), on('Thu', 17), 'confirmed'),
    booking('Delgado Paving', 'S66-2', on('Tue', 7), on('Tue', 17), 'confirmed'),
    booking('Bayview', 'S66-2', on('Fri', 8), on('Sat', 17), 'confirmed'),
    booking('Greenline Landscape', 'S66-3', on('Mon', 8), on('Thu', 17), 'confirmed'),
    booking('Dune Framing', 'T66-1', on('Wed', 7), on('Fri', 17), 'confirmed'),
    booking('Redwood Utilities', 'T66-2', on('Mon', 7), on('Fri', 17), 'confirmed'),

    // Problem 2, over the agent's limit: Redwood's U35 runs into Mesa, and the only fix is a four-day upgrade to the U55,
    // worth more than the cap and more than Redwood's extra day brings in.
    booking('Redwood Utilities', 'U35-1', last('Wed', 7), on('Mon', 17), 'picked_up'),
    booking('Mesa Septic', 'U35-1', on('Tue', 7), on('Fri', 17), 'confirmed'),
    booking('Bayview', 'U35-2', last('Fri', 7), on('Thu', 17), 'picked_up', { bufferHours: 4 }),
    booking('Greenline Landscape', 'U35-3', on('Mon', 8), on('Fri', 17), 'confirmed'),
    booking('Cascade Demolition', 'U55-1', { week: 1, day: 'Mon', hour: 7 }, { week: 1, day: 'Wed', hour: 17 }, 'confirmed'),

    // Problem 3, site fit: Summit's U55 runs into Alder's backyard job. The only machine left is the larger Cat 308, and
    // nobody has recorded whether it fits through Alder's gate.
    booking('Summit Grading', 'U55-2', last('Thu', 7), on('Mon', 16), 'picked_up'),
    booking('Alder Homes', 'U55-2', on('Tue', 8), on('Wed', 8), 'confirmed', { note: 'Backyard job, 8 ft side gate', requiredFacts: [gate.key] }),
    booking('Cascade Demolition', 'CAT308-1', last('Fri', 7), on('Mon', 15), 'picked_up', { bufferHours: 5 }),
    booking('Alder Homes', 'CAT308-1', on('Thu', 7), on('Fri', 17), 'confirmed'),

    // Problem 4, the last telehandler: Pacific's JCB runs into Coastline, whose only option is the Genie. While that
    // request holds the Genie, Dune has nothing to book.
    booking('Pacific Steel', 'JCB507-1', last('Fri', 7), on('Mon', 15), 'picked_up'),
    booking('Coastline Roofing', 'JCB507-1', on('Tue', 8), on('Thu', 8), 'confirmed'),
    booking('Summit Grading', 'GTH1056-1', on('Fri', 7), on('Sat', 17), 'confirmed'),

    // The rest of a working week.
    booking('Bayview', 'SL1930-1', on('Mon', 8), on('Wed', 17), 'confirmed'),
    booking('Dune Framing', 'SL1930-2', on('Tue', 7), on('Fri', 17), 'confirmed'),
    booking('Coastline Roofing', 'SL2646-1', on('Tue', 8), on('Thu', 17), 'confirmed'),
    booking('Harbor Concrete', 'SL2646-1', { day: 'Sat', hour: 7 }, { day: 'Sat', hour: 16 }, 'confirmed'),
    booking('Delgado Paving', 'RD12-1', last('Fri', 7), on('Mon', 17), 'picked_up'),
    booking('Northside Landscaping', 'RD12-2', on('Wed', 7), on('Thu', 17), 'confirmed'),
  ];

  const conversations: (typeof s.conversations.$inferSelect)[] = customers.map((c) => ({
    id: randomUUID(), shopId, customerId: c.id, handedOffAt: null, handoffReason: null, handedBackAt: null,
  }));

  return {
    shop, now, models, substitutes, units,
    unavailability: [] as (typeof s.unitUnavailability.$inferSelect)[],
    conditionNotes: [] as (typeof s.conditionNotes.$inferSelect)[],
    facts, customers, bookings, conversations,
    unit, customer, t,
    bookingOn: (name: string, label: string) => bookings.find((b) => b.customerId === customer(name).id && b.unitId === unit(label).id)!,
  };
}

export type YardShop = ReturnType<typeof yardShopData>;
