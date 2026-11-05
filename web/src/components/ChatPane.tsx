// One customer's chat with the assistant, as that customer sees it, with their approval cards inline. The demo's
// visitor plays them here; the owner's side of the chats is OwnerMessages.

import { useCallback, useEffect, useRef, useState } from 'react';
import { type Config, type Customer, type CustomerView, type Outcome, api } from '../api';
import { pointsAtRequest } from '../highlight';
import { shopTime } from '../live';
import { Card, StatusCard } from './Cards';
import { Avatar, Mark } from './Chrome';

type Props = {
  customerId: string;
  customers: Customer[];
  onCustomer: (id: string) => void;
  config: Config;
  zone: string;
  tick: number;
  typing: boolean;
  /** Other customers with a card waiting on them: with one chat on screen, this is how the visitor finds them. */
  waitingOn: Customer[];
  onOutcome: (o: Outcome) => void;
  /** This shop's one-click first messages, in each customer's own words. */
  suggestions: Record<string, string>;
};

/** One click to start, for a customer with no message of their own in this shop's demo. */
const TRY_ANYONE = 'When is my booking?';

export function ChatPane({ customerId, customers, onCustomer, config, zone, tick, typing, waitingOn, onOutcome, suggestions }: Props) {
  const [view, setView] = useState<CustomerView | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => setView(await api.customer(customerId)), [customerId]);
  useEffect(() => {
    void load().catch(() => {});
  }, [load, tick]);
  useEffect(() => {
    // Scrolls only this list: scrollIntoView would also move the panel around a closed phone.
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [view?.messages.length, typing]);

  const send = async (typed = text) => {
    const body = typed.trim();
    if (!body) return;
    setSending(true);
    try {
      await api.send(customerId, body);
      setText('');
      await load();
    } catch (e) {
      onOutcome({ status: 'error', reason: (e as Error).message });
    } finally {
      setSending(false);
    }
  };

  const name = view?.customer.name ?? customers.find((c) => c.id === customerId)?.name ?? '';
  const cardFor = (ids: string[]) => view?.cards.find((c) => c.options.some((o) => ids.includes(o.revisionId)));
  const statusFor = (ids: string[]) => view?.requests.find((r) => r.revisionIds.some((id) => ids.includes(id)));
  // A request can post several cards (a fallback, a new price); only its latest one shows where it stands now.
  const latestCard = new Map<string, string>();
  for (const m of view?.messages ?? []) {
    const r = m.cardRevisionIds.length ? statusFor(m.cardRevisionIds) : undefined;
    if (r) latestCard.set(r.proposalId, m.id);
  }
  const shown = new Set<string>();

  const closedCard = (messageId: string, status: ReturnType<typeof statusFor>) => {
    if (!status) return <div className="card closed">Offer closed</div>;
    if (latestCard.get(status.proposalId) !== messageId) return <div className="card closed">Earlier offer, replaced below</div>;
    return <StatusCard status={status} customerId={customerId} onOutcome={onOutcome} />;
  };

  return (
    <section className="pane chat">
      <div className="messages" ref={scroller}>
        {!view && <div className="muted small">Loading…</div>}
        {view?.messages.length === 0 && view.cards.length === 0 && view.requests.length === 0 && (
          <div className="empty">
            <p>You're writing as {name}. Nothing here yet.</p>
            <button className="try" disabled={sending} onClick={() => void send(suggestions[name] ?? TRY_ANYONE)}>
              {suggestions[name] ?? TRY_ANYONE}
            </button>
          </div>
        )}
        {view?.messages.map((m) => {
          if (m.cardRevisionIds.length) {
            const card = cardFor(m.cardRevisionIds);
            if (card) shown.add(card.proposalId + card.role);
            return (
              <div className="msg card-msg" key={m.id} {...pointsAtRequest(card?.proposalId ?? statusFor(m.cardRevisionIds)?.proposalId)}>
                {card ? (
                  <Card card={card} customerId={customerId} customerName={name} agentWriting={typing} config={config} zone={zone} onOutcome={onOutcome} />
                ) : (
                  closedCard(m.id, statusFor(m.cardRevisionIds))
                )}
              </div>
            );
          }
          const who = m.author === 'customer' ? name : m.author === 'owner' ? 'Shop' : m.author === 'system' ? 'Shop' : 'Assistant';
          return (
            <div className={`msg ${m.author}`} key={m.id}>
              {who === 'Assistant' ? <Mark size={22} /> : <Avatar name={who} />}
              <div>
                <div className="who">
                  {who}<span className="when">{shopTime(m.at, zone, 'h:mma').toLowerCase()}</span>
                </div>
                <div className="body">{m.body}</div>
              </div>
            </div>
          );
        })}
        {/* A card that no message points at (rare): still show it, so a decision is never stranded. */}
        {view?.cards
          .filter((c) => !shown.has(c.proposalId + c.role))
          .map((c) => (
            <div className="msg card-msg" key={c.proposalId + c.role} {...pointsAtRequest(c.proposalId)}>
              <Card card={c} customerId={customerId} customerName={name} agentWriting={typing} config={config} zone={zone} onOutcome={onOutcome} />
            </div>
          ))}
        {/* The same for a request whose card never reached the chat (they answered before the assistant posted it). */}
        {view?.requests
          .filter((r) => !view.cards.some((c) => c.proposalId === r.proposalId) && !view.messages.some((m) => m.cardRevisionIds.some((id) => r.revisionIds.includes(id))))
          .map((r) => (
            <div className="msg card-msg" key={r.proposalId} {...pointsAtRequest(r.proposalId)}>
              <StatusCard status={r} customerId={customerId} onOutcome={onOutcome} />
            </div>
          ))}
        {typing && <div className="typing">Assistant is replying…</div>}
      </div>

      {view?.handedOff && (
        <div className="handoff">The shop is handling this chat, so the assistant is paused.</div>
      )}
      {waitingOn.length === 1 && (
        <div className="nudge">
          {waitingOn[0]!.name} has an offer to answer.
          <button onClick={() => onCustomer(waitingOn[0]!.id)}>Open {waitingOn[0]!.name}'s phone</button>
        </div>
      )}
      {waitingOn.length > 1 && (
        <div className="nudge nudge-many">
          <span>{waitingOn.length} customers have an offer to answer:</span>
          <span className="nudge-names">
            {waitingOn.map((c) => (
              <button key={c.id} onClick={() => onCustomer(c.id)}>{c.name}</button>
            ))}
          </span>
        </div>
      )}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          value={text}
          rows={2}
          placeholder={`Message as ${name}…`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-row">
          <span />
          <button className="primary" disabled={sending || !text.trim()}>
            Send
          </button>
        </div>
      </form>
    </section>
  );
}
