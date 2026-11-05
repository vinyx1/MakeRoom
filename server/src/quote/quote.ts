// The quote: what a plan costs and pays, from the rate card and the shop's policy, never from the agent
// (invariant 10). Pure. Each revision stores its quote, so agreed terms never change afterwards.
//
//   requester    pays the rate-card difference of their change, less any discount (≤ the discount band)
//   upgrade      the price difference is value the shop gives up (Bob to the A7R V: $40)
//   downgrade    the price difference back, plus goodwill (Eve to the Crane 4: $15 + $5)
//   time shift   goodwill per hour moved, plus any rate-card saving (Bob 5h later: 5 × $3 = $15)
//   unit swap    nothing; notice only
//
// Money checks: compensation over the per-customer cap, a discount beyond the band, a cash refund above
// what the customer paid, or negative net revenue → owner; total compensation above what the requester's
// change brings in → outside the envelope.

import type { Quote } from '../db/schema.ts';
import type { PlanChange } from '../optimizer/optimizer.ts';
import type { Index } from '../optimizer/snapshot.ts';
import { formatShopTime } from '../optimizer/time.ts';

export type MoneyTrigger = 'over_cap' | 'discount_over_band' | 'refund_over_paid' | 'negative_net';
export type MoneyTrip = 'compensation_over_revenue';

export type QuoteOptions = {
  /** Discount on the requester's charge, in percent. Above `policy.discount_band_pct` it needs the owner. */
  requesterDiscountPct?: number;
  /** false for an overdue return: the late customer's extra time isn't charged (no late fees in the PoC). */
  chargeRequester?: boolean;
  /** A customer's counter: the cash refund they asked for, in place of the computed one. */
  counterRefund?: { customerId: string; cents: number };
};

export type QuoteResult = {
  quote: Quote;
  ownerTriggers: MoneyTrigger[];
  envelopeTrips: MoneyTrip[];
  /** Total compensation (cash and value given up), for ranking. */
  compensationCents: number;
};

export function quotePlan(idx: Index, changes: PlanChange[], { requesterDiscountPct = 0, chargeRequester = true, counterRefund }: QuoteOptions = {}): QuoteResult {
  const { policy } = idx;
  const triggers = new Set<MoneyTrigger>();
  const trips = new Set<MoneyTrip>();
  const t = (d: Date) => formatShopTime(d, idx.snap.shop);

  const lines: Quote['lines'] = changes
    .filter((c) => chargeRequester && c.isRequester && c.priceDeltaCents !== 0)
    .map((c) => ({ customerId: c.customerId, label: requesterLabel(idx, c, t), amountCents: c.priceDeltaCents }));
  const linesTotal = lines.reduce((sum, l) => sum + l.amountCents, 0);

  if (requesterDiscountPct > policy.discount_band_pct) triggers.add('discount_over_band');
  const discountCents = linesTotal > 0 ? Math.round((linesTotal * Math.max(0, requesterDiscountPct)) / 100) : 0;
  const chargeCents = linesTotal - discountCents;

  let compensation: Quote['compensation'] = [];
  for (const c of changes) {
    if (c.isRequester || c.kind === 'same_model_swap') continue;
    const add = (cents: number, kind: 'refund' | 'upgrade_value', reason: string) => {
      if (cents > 0) compensation.push({ customerId: c.customerId, bookingId: c.bookingId, cents, kind, reason });
    };
    if (c.priceDeltaCents > 0) add(c.priceDeltaCents, 'upgrade_value', upgradeReason(idx, c));
    if (c.priceDeltaCents < 0) add(-c.priceDeltaCents, 'refund', 'price difference');
    if (c.kind === 'model_change' && isDowngrade(idx, c)) add(policy.downgrade_goodwill_cents, 'refund', 'goodwill for the downgrade');
    if (c.kind === 'time_shift')
      add(Math.round(c.hoursShifted * policy.shift_compensation_cents_per_hour), 'refund', `goodwill for moving ${fmtHours(c.hoursShifted)}`);
  }

  if (counterRefund) {
    const booking = changes.find((c) => c.customerId === counterRefund.customerId)?.bookingId ?? null;
    compensation = compensation.filter((x) => !(x.customerId === counterRefund.customerId && x.kind === 'refund'));
    if (counterRefund.cents > 0) compensation.push({ customerId: counterRefund.customerId, bookingId: booking, cents: counterRefund.cents, kind: 'refund', reason: 'asked for in their counter-offer' });
  }

  const perCustomer = new Map<string, { total: number; cash: number }>();
  for (const comp of compensation) {
    const p = perCustomer.get(comp.customerId) ?? { total: 0, cash: 0 };
    p.total += comp.cents;
    if (comp.kind === 'refund') p.cash += comp.cents;
    perCustomer.set(comp.customerId, p);
  }
  for (const [customerId, p] of perCustomer) {
    if (p.total > policy.compensation_cap_cents) triggers.add('over_cap');
    // A refund goes back on their original capture, so it can't exceed what they paid for the booking.
    const paid = changes
      .filter((c) => c.customerId === customerId && c.bookingId)
      .reduce((sum, c) => sum + (idx.bookings.get(c.bookingId!)?.priceCents ?? 0), 0);
    if (p.cash > paid) triggers.add('refund_over_paid');
  }

  const compensationCents = compensation.reduce((sum, c) => sum + c.cents, 0);
  if (compensationCents > Math.max(0, chargeCents)) trips.add('compensation_over_revenue');
  const netRevenueCents = chargeCents - compensationCents;
  if (netRevenueCents < 0) triggers.add('negative_net');

  return {
    quote: { lines, discountCents, chargeCents, compensation, netRevenueCents },
    ownerTriggers: [...triggers],
    envelopeTrips: [...trips],
    compensationCents,
  };
}

const isDowngrade = (idx: Index, c: PlanChange) => {
  const from = c.before && idx.models.get(c.before.modelId), to = idx.models.get(c.after.modelId);
  return !!from && !!to && to.tier < from.tier;
};

function upgradeReason(idx: Index, c: PlanChange) {
  if (c.kind === 'model_change') {
    const to = idx.models.get(c.after.modelId);
    return `${to?.sizeTier ? 'larger machine at no extra charge:' : 'free upgrade to'} the ${to?.name ?? 'other model'}`;
  }
  return 'extra time at no charge';
}

function requesterLabel(idx: Index, c: PlanChange, t: (d: Date) => string) {
  const model = idx.models.get(c.after.modelId)?.name ?? 'Rental';
  if (c.kind === 'new_booking') return `${model}, ${t(c.after.startsAt)} → ${t(c.after.endsAt)}`;
  if (c.kind === 'extension') return `Extension to ${t(c.after.endsAt)}`;
  return `Change to ${t(c.after.startsAt)} → ${t(c.after.endsAt)}`;
}

const fmtHours = (h: number) => `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
