// The owner's column: what needs a decision (cards rendered by the backend), red drafts, and the live activity feed.

import { useState } from 'react';
import { type Activity, type Escalation, type Fact, type Outcome, type OwnerView, api } from '../api';
import { pointsAtRequest } from '../highlight';
import { shopTime, usd } from '../live';

type Props = {
  owner: OwnerView;
  activity: Activity[];
  onOutcome: (o: Outcome) => void;
  onOpenChat: (customerId: string) => void;
  onResolveDraft: (draftId: string) => void;
  onMarkOverdue: (bookingId: string) => void;
};

type SaveOffer = { factId: string; value: 'yes' | 'no'; label: string };

export function OwnerPanel({ owner, activity, onOutcome, onOpenChat, onResolveDraft, onMarkOverdue }: Props) {
  const [saveOffers, setSaveOffers] = useState<SaveOffer[]>([]);
  const nameOf = (id: string | null | undefined) => owner.customers.find((c) => c.id === id)?.name ?? 'A customer';
  const zone = owner.shop.timezone;
  const unitOf = (id: string | null) => owner.units.find((u) => u.id === id)?.label ?? 'Unassigned';
  // Rentals still out past their return time: the owner marks them returned, or overdue with a new expected time.
  const dueBack = owner.bookings.filter((b) => b.status === 'picked_up' && new Date(b.endsAt) <= new Date(owner.shop.now));
  const waiting = owner.escalations.length + owner.drafts.length + saveOffers.length + dueBack.length;

  return (
    <section className="pane owner">
      <header className="pane-head">
        <h2 className="pane-title">Needs you</h2>
        <span className={`count ${waiting ? 'hot' : ''}`}>{waiting || 'Nothing'}</span>
      </header>
      <div className="owner-body">
        <div className="inbox">
          {saveOffers.map((f) => (
            <div className="ocard" key={f.factId}>
              <div>
                Save <b>{f.label}: {f.value}</b> as a fact, so the assistant doesn't ask again?
              </div>
              <div className="row">
                <button
                  className="primary"
                  onClick={async () => {
                    onOutcome(await api.saveFact(f.factId, f.value));
                    setSaveOffers((s) => s.filter((x) => x.factId !== f.factId));
                  }}
                >
                  Save as fact
                </button>
                <button className="link muted" onClick={() => setSaveOffers((s) => s.filter((x) => x.factId !== f.factId))}>
                  Not now
                </button>
              </div>
            </div>
          ))}
          {owner.escalations.map((e) => (
            <OwnerCard
              key={e.id}
              escalation={e}
              owner={owner}
              onOutcome={(o) => {
                onOutcome(o);
                if (o.saveableFacts?.length) setSaveOffers((s) => [...s, ...o.saveableFacts.filter((f: SaveOffer) => !s.some((x) => x.factId === f.factId))]);
              }}
              onOpenChat={onOpenChat}
            />
          ))}
          {dueBack.map((b) => (
            <div className="ocard" key={`due-${b.id}`}>
              <div className="ocard-kind"><span className={`tag ${b.overdueMarkedAt ? 'held' : ''}`}>{b.overdueMarkedAt ? 'Overdue' : 'Due back'}</span></div>
              <div>
                {nameOf(b.customerId)}'s {owner.models.find((m) => m.id === b.modelId)?.name} ({unitOf(b.unitId)}) was due back {shopTime(b.endsAt, zone)}.
              </div>
              <div className="row">
                <button className="primary" onClick={async () => onOutcome(await api.markReturned(b.id))}>
                  Mark returned
                </button>
                <button onClick={() => onMarkOverdue(b.id)}>{b.overdueMarkedAt ? 'Update expected return…' : 'Mark overdue…'}</button>
              </div>
            </div>
          ))}
          {owner.drafts.map((d) => {
            const b = owner.bookings.find((x) => x.id === d.bookingId);
            return (
              <div className="ocard" key={d.id}>
                <div className="ocard-kind"><span className="tag conflict">Your draft, in conflict</span></div>
                <div>
                  {nameOf(b?.customerId)}'s booking → {d.proposed.startsAt && shopTime(d.proposed.startsAt, zone)} – {d.proposed.endsAt && shopTime(d.proposed.endsAt, zone)} conflicts with another booking.
                </div>
                <div className="row">
                  <button className="primary" onClick={() => onResolveDraft(d.id)}>
                    Resolve with agent
                  </button>
                  <button onClick={async () => onOutcome(await api.discardDraft(d.id))}>Discard</button>
                </div>
              </div>
            );
          })}
          {owner.lastEdit && (
            <div className="ocard" key={`undo-${owner.lastEdit.bookingId}`}>
              <div>
                <b>Last change:</b> {nameOf(owner.lastEdit.customerId)}'s booking {shopTime(owner.lastEdit.before.startsAt, zone)} – {shopTime(owner.lastEdit.before.endsAt, zone)}
                {' → '}
                {shopTime(owner.lastEdit.after.startsAt, zone)} – {shopTime(owner.lastEdit.after.endsAt, zone)}
                {owner.lastEdit.before.unitId !== owner.lastEdit.after.unitId && ` (${unitOf(owner.lastEdit.before.unitId)} → ${unitOf(owner.lastEdit.after.unitId)})`}
              </div>
              <div className="row">
                <button onClick={async () => onOutcome(await api.undoEdit(owner.lastEdit!.bookingId))}>Undo</button>
              </div>
            </div>
          )}
          {!waiting && <div className="empty-line">Nothing is waiting on you. Drag a booking on the schedule to change it.</div>}
          {owner.proposals.length > 0 && (
            <div className="pending">
              <h3 className="feed-title">Pending requests</h3>
              {owner.proposals.map((p) => (
                <PendingRequest key={p.id} proposal={p} owner={owner} onOutcome={onOutcome} />
              ))}
            </div>
          )}
          <Payments activity={activity} owner={owner} />
        </div>

        <div className="feed">
          <h3 className="feed-title">Activity</h3>
          {activity.map((a) => (
            <FeedLine key={a.seq} a={a} owner={owner} />
          ))}
        </div>
      </div>
    </section>
  );
}

const PAYMENT_STATE: Record<string, { label: string; tag: string }> = {
  payment_authorized: { label: 'Held', tag: 'held' },
  payment_captured: { label: 'Captured', tag: 'ok' },
  payment_voided: { label: 'Hold released', tag: '' },
  payment_refunded: { label: 'Refunded', tag: 'refund' },
};

/** Where each PayPal payment for a change stands now, newest first, from the same events as the feed. */
function Payments({ activity, owner }: { activity: Activity[]; owner: OwnerView }) {
  const name = (id: string) => owner.customers.find((c) => c.id === id)?.name ?? 'A customer';
  const rows = new Map<string, Activity>();
  for (const a of activity) {
    // A refund is its own line; a hold's later states replace it. Seeded prepayments aren't part of any request.
    if (!PAYMENT_STATE[a.kind] || (a.kind !== 'payment_refunded' && !a.proposalId)) continue;
    const key = a.kind === 'payment_refunded' ? `refund-${a.seq}` : a.payload.orderId;
    if (!rows.has(key)) rows.set(key, a);
  }
  if (rows.size === 0) return null;
  return (
    <div className="pending">
      <h3 className="feed-title">Payments</h3>
      {[...rows.values()].slice(0, 5).map((a) => (
        <div className="pay-row" key={a.seq}>
          <span>{name(a.payload.customerId)}</span>
          <span className={`tag ${PAYMENT_STATE[a.kind]!.tag}`}>{PAYMENT_STATE[a.kind]!.label}</span>
          <b>{usd(a.payload.amountCents)}</b>
        </div>
      ))}
    </div>
  );
}

const STATE: Record<string, string> = {
  DRAFT: 'waiting for the customer to accept and pay',
  AWAITING_APPROVALS: 'waiting for approvals',
  CAPTURING: 'being confirmed',
};

/** One active request, with "Adjust price" while the customer hasn't paid yet. */
function PendingRequest({ proposal: p, owner, onOutcome }: { proposal: OwnerView['proposals'][number]; owner: OwnerView; onOutcome: (o: Outcome) => void }) {
  const [editing, setEditing] = useState(false);
  const [dollars, setDollars] = useState('');
  const [busy, setBusy] = useState(false);
  const rev = p.revisions[0];
  if (!rev) return null;
  const late = p.source === 'overdue' ? owner.bookings.find((b) => b.id === p.subjectBookingId) : undefined;
  const name = late
    ? `${owner.customers.find((c) => c.id === late.customerId)?.name ?? 'A customer'}'s late return`
    : (owner.customers.find((c) => c.id === p.requesterCustomerId)?.name ?? 'The shop');
  const what = late ? 'next booking re-planned' : rev.isAlternative ? 'closest alternative' : rev.quote.lines.map((l) => l.label).join(', ') || 'change';
  const free = rev.quote.chargeCents === 0;
  const save = async () => {
    const cents = Math.round(Number(dollars) * 100);
    if (!Number.isFinite(cents) || cents < 0) return onOutcome({ status: 'refused', reason: 'Enter a price in dollars, like 40 or 40.00.' });
    setBusy(true);
    try {
      const r = await api.setPrice(p.id, cents);
      onOutcome(r);
      if (r.status === 'repriced') setEditing(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="preq" {...pointsAtRequest(p.id)}>
      <div className="preq-line">
        <span><b>{name}</b>: {what}</span>
        {!late && <b>{usd(rev.quote.chargeCents)}</b>}
      </div>
      {rev.quote.discountCents > 0 && <div className="muted small">{usd(rev.quote.discountCents)} off</div>}
      {!late && !free && p.state !== 'DRAFT' && <div style={{ margin: '3px 0' }}><span className="tag held">{p.state === 'CAPTURING' ? 'Capturing' : 'PayPal hold'}</span></div>}
      <div className="muted small">
        {late ? (p.state === 'CAPTURING' ? 'being confirmed' : 'waiting on you or the next customer') : p.state === 'DRAFT' && free ? 'waiting for the customer to accept' : (STATE[p.state] ?? p.state.toLowerCase())}
      </div>
      {p.state === 'DRAFT' && p.requesterCustomerId && !free && !editing && (
        <button className="link" onClick={() => { setDollars((rev.quote.chargeCents / 100).toFixed(2)); setEditing(true); }}>
          Adjust price
        </button>
      )}
      {editing && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <span>$</span>
          <input className="price-input" value={dollars} onChange={(e) => setDollars(e.target.value)} inputMode="decimal" aria-label="New price in dollars" autoFocus />
          <button className="primary" disabled={busy}>Send new price</button>
          <button type="button" className="link muted" onClick={() => setEditing(false)}>Cancel</button>
        </form>
      )}
    </div>
  );
}

function OwnerCard({ escalation: e, owner, onOutcome, onOpenChat }: { escalation: Escalation; owner: OwnerView; onOutcome: (o: Outcome) => void; onOpenChat: (id: string) => void }) {
  const [answers, setAnswers] = useState<Record<string, 'yes' | 'no'>>({});
  const [busy, setBusy] = useState(false);
  const revision = owner.proposals.flatMap((p) => p.revisions).find((r) => r.id === e.revisionId);
  const questions: Fact[] = (revision?.factDependencies ?? []).map((id) => owner.facts.find((f) => f.id === id)!).filter((f) => f && f.value !== 'yes');
  const customerOfThread = owner.conversations.find((c) => c.id === e.conversationId)?.customerId;
  const act = async (fn: () => Promise<Outcome>) => {
    setBusy(true);
    try {
      onOutcome(await fn());
    } catch (err) {
      onOutcome({ status: 'error', reason: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  // The backend's summary ends with the fact question ("Needs a fact: …?"); it gets Yes/No buttons of its own.
  const [summary, question] = e.summary.split(' Needs a fact: ');

  return (
    <div className="ocard" {...pointsAtRequest(e.proposalId)}>
      <div className="ocard-kind"><span className={`tag ${TAG[e.kind] ?? ''}`}>{LABEL[e.kind] ?? e.kind}</span></div>
      <div>{summary}</div>
      {questions.length > 0 && (
        <div className="fact-q">
          <div className="fact-q-text">Needs a fact: {question ?? questions.map((f) => `${f.label ?? f.key}?`).join(' ')}</div>
          {questions.map((f) => (
            <div className="row" key={f.id}>
              {questions.length > 1 && <span className="small">{f.label ?? f.key}?</span>}
              {(['yes', 'no'] as const).map((v) => (
                <button key={v} className={answers[f.id] === v ? 'chip on' : 'chip'} onClick={() => setAnswers((a) => ({ ...a, [f.id]: v }))}>
                  {v === 'yes' ? 'Yes' : 'No'}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="row">
        {e.revisionId && e.proposalId && (
          <>
            <button
              className="primary"
              disabled={busy || questions.some((f) => !answers[f.id])}
              onClick={() => act(() => api.ownerDecision(e.proposalId!, e.revisionId!, 'approve', questions.length ? answers : undefined))}
            >
              Approve
            </button>
            <button disabled={busy} onClick={() => act(() => api.ownerDecision(e.proposalId!, e.revisionId!, 'decline'))}>
              Decline
            </button>
          </>
        )}
        {e.kind === 'fact_question' && e.factId && (
          <>
            <button className="primary" disabled={busy} onClick={() => act(() => api.saveFact(e.factId!, 'yes'))}>
              Yes
            </button>
            <button disabled={busy} onClick={() => act(() => api.saveFact(e.factId!, 'no'))}>
              No
            </button>
            <span className="muted small">Saved as a fact; the customer is told.</span>
          </>
        )}
        {customerOfThread && (e.kind === 'handoff' || e.kind === 'customer_issue' || e.kind === 'overdue') && (
          <button onClick={() => onOpenChat(customerOfThread)}>Open the chat</button>
        )}
      </div>
    </div>
  );
}

// Persimmon is the assistant proposing something; red and amber are problems.
const TAG: Record<string, string> = { approval: 'proposal', plan_review: 'proposal', handoff: 'conflict', customer_issue: 'conflict', payment_failure: 'conflict', overdue: 'held' };

const LABEL: Record<string, string> = {
  approval: 'Approval needed',
  plan_review: 'Review this plan',
  fact_question: 'Customer question',
  handoff: 'Handed to you',
  customer_issue: 'Needs a person',
  payment_failure: 'Payment problem',
  overdue: 'Late return: needs you',
};

function FeedLine({ a, owner }: { a: Activity; owner: OwnerView }) {
  const p = a.payload ?? {};
  const name = (id: string | undefined) => owner.customers.find((c) => c.id === id)?.name ?? 'A customer';
  const at = shopTime(a.at, owner.shop.timezone, 'h:mm');
  const line = (cls: string, text: React.ReactNode, sub?: string[]) => (
    <div className={`fl ${cls}`}>
      <span className="fl-at">{at}</span>
      <div>
        {text}
        {sub && sub.length > 0 && (
          <ul>
            {sub.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
  switch (a.kind) {
    case 'customer_message':
      return line('cust', <>{name(p.customerId)}: “{p.text}”</>);
    case 'agent_step':
      return line('agent', <>Assistant ({name(p.customerId)}) → {p.tool}{p.ok ? '' : ` failed: ${p.code}`}</>);
    case 'agent_turn':
      return line('dim', <>Turn for {name(p.customerId)}: {(p.ms / 1000).toFixed(1)}s, ${Number(p.costUsd).toFixed(3)}{p.fallback ? ` · ${p.fallback}` : ''}</>);
    case 'agent_message_blocked':
      return line('warn', <>Blocked a message to {name(p.customerId)}: {p.amounts.join(', ')} didn't come from a tool</>);
    case 'optimizer_run':
      return line('opt', <>Optimizer: {p.plans.length} plan{p.plans.length === 1 ? "" : "s"}{p.pruned.length ? `, ruled out ${p.pruned.length}:` : ""}</>, p.pruned.map((x: { message: string }) => x.message));
    case 'proposal_created':
      return line('', <>Request created{p.source === 'owner_resolve' ? ' by Resolve with agent' : ''}</>);
    case 'offer_ready':
      return line('', <>Offer sent to {name(p.customerId)}</>);
    case 'requester_accepted':
      return line('ok', <>{name(a.actor.replace('customer:', ''))} accepted</>);
    case 'affected_accepted':
      return line('ok', <>{name(a.actor.replace('customer:', ''))} chose {p.option ? `option ${p.option}` : 'the offer'}</>);
    case 'auto_reply':
      return line('dim', <>{name(p.customerId)} (scripted) answered: “{p.text}”</>);
    case 'affected_refused':
      return line('warn', <>{name(p.customerId)} kept their booking as is{p.withdrew ? ' (withdrew their pick)' : ''}</>);
    case 'fallback_planned':
      return line('opt', <>Next plan: asking another customer instead</>);
    case 'alternative_offered':
      return line('opt', <>No plans left: offering the closest alternative{p.holdReleased ? ', hold released' : ''}</>);
    case 'owner_approved':
      return line('ok', <>Owner approved</>);
    case 'owner_declined':
      return line('warn', <>Owner declined</>);
    case 'all_approved':
      return line('', <>Everyone agreed; capturing the payment</>);
    case 'proposal_committed':
      return line('ok', <>Committed: the schedule is updated</>);
    case 'proposal_ended':
      return line('warn', <>Request {String(p.to).toLowerCase()}: {p.reason}</>);
    case 'proposal_update':
      return line('dim', <>Telling {name(p.customerId)} the outcome</>);
    case 'booking_edited':
      return line('', <>Owner changed a booking{p.overrode?.length ? ' (override)' : ''}</>);
    case 'overdue_marked':
      return line('warn', <>{name(p.customerId)} marked overdue, expected back {shopTime(p.expectedReturnAt, owner.shop.timezone)}{p.outcome === 'extended' ? ': nothing else affected' : p.outcome === 'no_plan' ? ': no plan makes room' : ''}</>);
    case 'booking_returned':
      return line('ok', <>{name(p.customerId)} returned their rental{p.late ? ' (late)' : ''}</>);
    case 'draft_discarded':
      return line('', <>Owner discarded a red draft</>);
    case 'booking_edit_undone':
      return line('', <>Owner undid their last change</>);
    case 'booking_cancelled':
      return line('warn', <>Owner cancelled a booking, as agreed by phone{p.refundCents ? `: ${usd(p.refundCents)} refunded` : ''}</>);
    case 'draft_saved':
      return line('warn', <>Owner edit kept as a red draft: {(p.violations ?? []).join('; ')}</>);
    case 'fact_saved':
      return line('ok', <>Fact saved: {p.label ?? p.key} = {p.value}</>);
    case 'clock_fast_forwarded':
      return line('dim', <>Clock moved forward {p.minutes} min</>);
    case 'prepayments_seeded':
      return line('dim', <>Demo bookings prepaid in the PayPal sandbox ({p.paid})</>);
    case 'auto_reply_toggled':
      return line('dim', <>Auto-reply customers {p.enabled ? 'on' : 'off'}</>);
    default:
      if (a.kind.startsWith('payment_'))
        return line('pay', <>PayPal: {a.kind.replace('payment_', '').replace('_', ' ')}{p.amountCents ? ` ${usd(p.amountCents)}` : ''}</>);
      return line('dim', <>{a.kind.replaceAll('_', ' ')}</>);
  }
}
