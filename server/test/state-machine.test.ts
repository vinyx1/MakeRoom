import { describe, expect, it } from 'vitest';
import { type ProposalEvent, type ProposalState, transition } from '../src/proposals/state-machine.ts';

const legal: [ProposalState, ProposalEvent, ProposalState, string[]][] = [
  ['DRAFT', 'offer', 'AWAITING_APPROVALS', []],
  ['DRAFT', 'new_revision', 'DRAFT', []],
  ['DRAFT', 'reject', 'REJECTED', ['void_authorization', 'release_claims']],
  ['DRAFT', 'expire', 'EXPIRED', ['void_authorization', 'release_claims']],
  ['DRAFT', 'owner_override', 'CANCELLED', ['void_authorization', 'release_claims']],
  ['AWAITING_APPROVALS', 'new_revision', 'DRAFT', []],
  ['AWAITING_APPROVALS', 'all_approved', 'CAPTURING', []],
  ['AWAITING_APPROVALS', 'reject', 'REJECTED', ['void_authorization', 'release_claims']],
  ['AWAITING_APPROVALS', 'expire', 'EXPIRED', ['void_authorization', 'release_claims']],
  ['AWAITING_APPROVALS', 'owner_override', 'CANCELLED', ['void_authorization', 'release_claims']],
  ['CAPTURING', 'captured_and_revalidated', 'COMMITTED', ['release_claims']],
  ['CAPTURING', 'capture_failed', 'FAILED', ['void_authorization', 'release_claims']],
  ['CAPTURING', 'revalidation_failed', 'FAILED', ['refund_capture', 'release_claims']],
];

describe('proposal transitions', () => {
  it.each(legal)('%s --%s--> %s', (from, event, to, effects) => {
    expect(transition(from, event)).toEqual({ ok: true, to, effects });
  });

  it('refuses the owner override and withdrawals during CAPTURING', () => {
    expect(transition('CAPTURING', 'owner_override').ok).toBe(false);
    expect(transition('CAPTURING', 'reject').ok).toBe(false);
  });

  it('ends: no event leaves a final state', () => {
    const events: ProposalEvent[] = ['offer', 'new_revision', 'all_approved', 'captured_and_revalidated', 'capture_failed', 'revalidation_failed', 'reject', 'expire', 'owner_override'];
    for (const from of ['COMMITTED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'FAILED'] as const)
      for (const e of events) expect(transition(from, e).ok).toBe(false);
  });

  it('only listed transitions are legal', () => {
    expect(transition('DRAFT', 'all_approved').ok).toBe(false);
    expect(transition('DRAFT', 'captured_and_revalidated').ok).toBe(false);
    expect(transition('AWAITING_APPROVALS', 'offer').ok).toBe(false);
  });
});
