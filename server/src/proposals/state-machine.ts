// The proposal state machine (docs/conflict-model.md §3) as a plain transition table. Pure.
// Agent tools and owner actions fire events; this table decides whether the transition is legal and which
// side effects it implies. The caller performs the effects in the same locked transaction (payments run after).

export type ProposalState =
  | 'DRAFT'
  | 'AWAITING_APPROVALS'
  | 'CAPTURING'
  | 'COMMITTED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'FAILED';

export type ProposalEvent =
  /** Requester authorized (or owes nothing) and claims are held: offers can go out. */
  | 'offer'
  /** A counter, owner modification or fallback plan: a new revision starts over at DRAFT. */
  | 'new_revision'
  | 'all_approved'
  | 'captured_and_revalidated'
  /** Capture call failed: nothing was taken, so the authorization is voided. */
  | 'capture_failed'
  /** Captured, but the plan no longer validates: refund the capture. */
  | 'revalidation_failed'
  /** Requester declined, requester withdrew, or the owner declined. */
  | 'reject'
  | 'expire'
  /** The owner overrode a claimed booking (owner wins, §6). */
  | 'owner_override';

export type Effect = 'void_authorization' | 'refund_capture' | 'release_claims';

const END_WITHOUT_CHANGE: Effect[] = ['void_authorization', 'release_claims'];

const TABLE: Record<ProposalState, Partial<Record<ProposalEvent, { to: ProposalState; effects: Effect[] }>>> = {
  DRAFT: {
    offer: { to: 'AWAITING_APPROVALS', effects: [] },
    new_revision: { to: 'DRAFT', effects: [] },
    reject: { to: 'REJECTED', effects: END_WITHOUT_CHANGE },
    expire: { to: 'EXPIRED', effects: END_WITHOUT_CHANGE },
    owner_override: { to: 'CANCELLED', effects: END_WITHOUT_CHANGE },
  },
  AWAITING_APPROVALS: {
    new_revision: { to: 'DRAFT', effects: [] },
    all_approved: { to: 'CAPTURING', effects: [] },
    reject: { to: 'REJECTED', effects: END_WITHOUT_CHANGE },
    expire: { to: 'EXPIRED', effects: END_WITHOUT_CHANGE },
    owner_override: { to: 'CANCELLED', effects: END_WITHOUT_CHANGE },
  },
  // From CAPTURING on, approvals are final and owner overrides on claimed bookings are refused (§3a).
  CAPTURING: {
    captured_and_revalidated: { to: 'COMMITTED', effects: ['release_claims'] },
    capture_failed: { to: 'FAILED', effects: END_WITHOUT_CHANGE },
    revalidation_failed: { to: 'FAILED', effects: ['refund_capture', 'release_claims'] },
  },
  COMMITTED: {},
  REJECTED: {},
  EXPIRED: {},
  CANCELLED: {},
  FAILED: {},
};

export const ACTIVE_STATES: readonly ProposalState[] = ['DRAFT', 'AWAITING_APPROVALS', 'CAPTURING'];

export type Transition = { ok: true; to: ProposalState; effects: Effect[] } | { ok: false; reason: string };

export function transition(from: ProposalState, event: ProposalEvent): Transition {
  const t = TABLE[from][event];
  if (!t) return { ok: false, reason: `can't ${event.replaceAll('_', ' ')} a proposal in ${from}` };
  return { ok: true, ...t };
}
