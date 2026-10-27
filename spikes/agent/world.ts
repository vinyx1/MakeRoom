// Stand-in for the backend: demo seed in memory, plus the decisions the real backend makes.
// The optimizer's Scenario 1 result is hard-coded; this spike tests the agent, not the optimizer.

// Shop-local times as naive ISO strings ("2026-10-29T10:00"). The real build stores UTC and converts.
export const NOW = '2026-10-28T14:00';
export const SHOP_OPEN = 9;
export const SHOP_CLOSE = 21;
export const BUFFER_HOURS = 4;
export const DISCOUNT_BAND_PCT = 10;
export const COMP_CAP_CENTS = 5000;

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const parse = (t: string) => new Date(`${t}:00Z`); // treat naive times as UTC for arithmetic only
const fmt = (d: Date) => d.toISOString().slice(0, 16);
export const addHours = (t: string, h: number) => fmt(new Date(parse(t).getTime() + h * 3600_000));
export const hoursBetween = (a: string, b: string) => (parse(b).getTime() - parse(a).getTime()) / 3600_000;
export function display(t: string) {
  const d = parse(t);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  const hh = h % 12 === 0 ? 12 : h % 12;
  const month = ['Oct', 'Nov'][d.getUTCMonth() - 9];
  return `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${month}, ${hh}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
}
export const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
export const time = (t: string) => ({ iso: t, display: display(t) });

export type Booking = {
  id: string; customer: string; model: string; unit: string;
  start: string; end: string; status: 'confirmed' | 'picked_up'; priceCents: number; note?: string;
};

export const MODELS = [
  { id: 'm_a7iv', name: 'Sony A7 IV', category: 'camera_body', rateCents: 4500, substitutes: ['m_a7rv'] },
  { id: 'm_a7rv', name: 'Sony A7R V', category: 'camera_body', rateCents: 6500, substitutes: ['m_a7iv'] },
  { id: 'm_rs3', name: 'DJI RS3 gimbal', category: 'gimbal', rateCents: 2500, substitutes: ['m_crane4'] },
  { id: 'm_crane4', name: 'Zhiyun Crane 4 gimbal', category: 'gimbal', rateCents: 2000, substitutes: ['m_rs3'] },
];

export type Revision = {
  id: string; proposalId: string; option: 'A' | 'B' | null; status: 'offered' | 'needs_owner' | 'selected' | 'superseded';
  summary: string; requesterPriceCents: number; affected?: { customer: string; change: string; compensationCents: number; compensationKind: string };
  needsOwner: string[];
};
export type Proposal = {
  id: string; requester: string; bookingId: string; state: 'DRAFT' | 'AWAITING_APPROVALS';
  newEnd: string; revisions: Revision[]; pendingFrom: string[];
};
export type Event =
  | { kind: 'message_sent'; to: string; text: string }
  | { kind: 'message_blocked'; to: string; text: string; amounts: string[] }
  | { kind: 'card_posted'; to: string; revisionIds: string[]; role: string }
  | { kind: 'escalation'; reason: string; summary: string; from: string }
  | { kind: 'fact_question'; subject: string; key: string; question: string; from: string }
  | { kind: 'proposal_created'; id: string }
  | { kind: 'revision_created'; id: string; needsOwner: string[] }
  | { kind: 'constraint'; customer: string; constraint: string };

export class World {
  bookings: Booking[] = [
    { id: 'bk_alice', customer: 'alice', model: 'm_a7iv', unit: 'A7IV-1', start: '2026-10-26T09:00', end: '2026-10-28T18:00', status: 'picked_up', priceCents: 13500 },
    { id: 'bk_bob', customer: 'bob', model: 'm_a7iv', unit: 'A7IV-1', start: '2026-10-29T09:00', end: '2026-10-30T18:00', status: 'confirmed', priceCents: 9000 },
    { id: 'bk_charlie', customer: 'charlie', model: 'm_a7iv', unit: 'A7IV-2', start: '2026-10-29T09:00', end: '2026-10-30T18:00', status: 'confirmed', priceCents: 9000 },
    { id: 'bk_eve', customer: 'eve', model: 'm_rs3', unit: 'RS3-1', start: '2026-10-29T14:00', end: '2026-10-31T18:00', status: 'confirmed', priceCents: 7500, note: 'for Canon R5 + RF 24-70' },
  ];
  facts: { subject: string; key: string; value: 'yes' | 'no' | 'unknown'; source: string }[] = [
    { subject: 'CRANE4-1', key: 'balances_r5_rf2470', value: 'unknown', source: 'seed' },
  ];
  proposals: Proposal[] = [];
  events: Event[] = [];
  private seq = 0;
  id = (p: string) => `${p}_${(++this.seq).toString(16).padStart(4, '0')}`;

  bookingsOf = (customer: string) => this.bookings.filter(b => b.customer === customer);
  activeProposalFor = (bookingId: string) => this.proposals.find(p => p.bookingId === bookingId);

  /** Validator: shop hours and the past. Returns a refusal code or null. */
  checkTime(t: string): null | { code: 'OUTSIDE_SHOP_HOURS' | 'IN_PAST'; nearest: string } {
    const d = parse(t), h = d.getUTCHours() + d.getUTCMinutes() / 60;
    if (t <= NOW) return { code: 'IN_PAST', nearest: addHours(NOW, 1) };
    if (h < SHOP_OPEN || h > SHOP_CLOSE) {
      const day = t.slice(0, 10);
      const nearest = h < SHOP_OPEN ? `${day}T${String(SHOP_OPEN).padStart(2, '0')}:00` : `${day}T${SHOP_CLOSE}:00`;
      return { code: 'OUTSIDE_SHOP_HOURS', nearest };
    }
    return null;
  }

  /** Quote for extending a booking: per started 24h at the model's rate (rate card, not the agent). */
  extensionPrice(b: Booking, newEnd: string) {
    const rate = MODELS.find(m => m.id === b.model)!.rateCents;
    return Math.ceil(hoursBetween(b.end, newEnd) / 24) * rate;
  }

  /** request_change for an extension. Hard-coded optimizer for the demo seed. */
  extend(customer: string, bookingId: string, newEnd: string) {
    const b = this.bookings.find(x => x.id === bookingId && x.customer === customer);
    if (!b) return { ok: false, code: 'NOT_FOUND', message: 'No such booking for this customer.' } as const;
    const bad = this.checkTime(newEnd);
    if (bad) return { ok: false, code: bad.code, message: bad.code === 'IN_PAST' ? 'That time has already passed.' : `Returns happen ${SHOP_OPEN}am–${SHOP_CLOSE - 12}pm.`, hint: `Offer the nearest valid time: ${display(bad.nearest)}.`, nearest: time(bad.nearest) } as const;
    if (newEnd <= b.end) return { ok: false, code: 'UNSUPPORTED', message: 'Shortening a rental is done by the shop, not through an extension.', hint: 'Escalate to the owner if the customer wants to return early.' } as const;
    const existing = this.activeProposalFor(b.id);
    if (existing) return { ok: false, code: 'INVALID_STATE', message: 'This booking already has an active request.', hint: 'Use get_my_proposals and revise_terms instead of a new request.' } as const;

    const price = this.extensionPrice(b, newEnd);
    const next = this.bookings.find(x => x.unit === b.unit && x.id !== b.id && x.start > b.start);
    const p: Proposal = { id: this.id('pr'), requester: customer, bookingId: b.id, state: 'DRAFT', newEnd, revisions: [], pendingFrom: [customer] };
    const freeAt = addHours(newEnd, BUFFER_HOURS);
    if (!next || freeAt <= next.start) {
      p.revisions.push({ id: this.id('rv'), proposalId: p.id, option: null, status: 'offered', summary: `Extend to ${display(newEnd)}`, requesterPriceCents: price, needsOwner: [] });
    } else {
      // Scenario 1 neighbourhood: Plan A upgrades the next renter; Plan B shifts their pickup to when the unit is free.
      const shift = hoursBetween(next.start, freeAt);
      p.revisions.push({ id: this.id('rv'), proposalId: p.id, option: 'A', status: 'offered', summary: `Extend to ${display(newEnd)}; another customer is upgraded to a Sony A7R V`, requesterPriceCents: price,
        affected: { customer: next.customer, change: `Upgrade to Sony A7R V (A7RV-1), same times`, compensationCents: 4000, compensationKind: 'upgrade_value' }, needsOwner: [] });
      if (shift <= 6) p.revisions.push({ id: this.id('rv'), proposalId: p.id, option: 'B', status: 'offered', summary: `Extend to ${display(newEnd)}; another customer's pickup moves to ${display(freeAt)}`, requesterPriceCents: price,
        affected: { customer: next.customer, change: `Pickup moves from ${display(next.start)} to ${display(freeAt)}`, compensationCents: Math.round(shift * 300), compensationKind: 'refund' }, needsOwner: ['booking_shortened'] });
    }
    this.proposals.push(p);
    this.events.push({ kind: 'proposal_created', id: p.id });
    const kind = p.revisions.length === 1 && !p.revisions[0].affected ? 'fits' : 'needs_other_changes';
    // Options differ only for the other customer, so the requester gets one offer; the backend attaches the siblings to the card.
    return { ok: true, proposal_id: p.id, result: kind, state: 'DRAFT', offer: this.view(p.revisions[0], customer), hint: 'Call present_offer with this revision id so the customer can accept and authorize payment, then explain it with send_message.' } as const;
  }

  /** A revision as one customer may see it: no other customer's identity. */
  view(r: Revision, customer: string) {
    const p = this.proposals.find(x => x.id === r.proposalId)!;
    const mine = p.requester === customer;
    const status = r.status === 'needs_owner' ? 'offered (needs shop confirmation)' : 'offered';
    if (mine) {
      // Options differ only in how another customer is accommodated; the requester sees one set of terms.
      return {
        revision_id: r.id, status, your_change: r.summary.split(';')[0],
        your_price: { cents: r.requesterPriceCents, display: usd(r.requesterPriceCents), status: 'offered' },
        needs_shop_confirmation: r.needsOwner.length > 0,
        note: r.affected ? 'Another booking has to change to make room; that is arranged with the other customer, not chosen by you.' : undefined,
      };
    }
    const a = r.affected!;
    return {
      revision_id: r.id, option: r.option, status, context: "Another customer's rental extension needs your booking's unit.",
      your_change: a.change,
      ...(a.compensationKind === 'refund'
        ? { your_refund: { cents: a.compensationCents, display: usd(a.compensationCents), status: 'offered', note: 'Partial refund on what you already paid' } }
        : { your_benefit: 'Free upgrade at no extra charge. No money changes hands; do not describe it as a dollar amount.' }),
      needs_shop_confirmation: r.needsOwner.length > 0,
    };
  }

  /** Simulate the requester clicking Accept + authorizing: the backend moves the proposal on and asks the affected party. */
  requesterAuthorizes(proposalId: string) {
    const p = this.proposals.find(x => x.id === proposalId)!;
    p.state = 'AWAITING_APPROVALS';
    p.pendingFrom = [...new Set(p.revisions.map(r => r.affected?.customer).filter(Boolean) as string[])];
  }
}
