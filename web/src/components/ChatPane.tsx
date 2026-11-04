// One customer's chat with the assistant, with their approval cards inline. The owner can also write here
// ("Reply as the shop"), and hand a conversation back after a handoff.

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
  role: string;
  onOutcome: (o: Outcome) => void;
};

/** One click to start, in the customer's own words. */
const TRY: Record<string, string> = { Alice: 'Shoot ran over. Can I keep the camera until Thursday at 10am?' };
const TRY_ANYONE = 'When is my booking?';

export function ChatPane({ customerId, customers, onCustomer, config, zone, tick, typing, role, onOutcome }: Props) {
  const [view, setView] = useState<CustomerView | null>(null);
  const [text, setText] = useState('');
  const [asShop, setAsShop] = useState(false);
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => setView(await api.customer(customerId)), [customerId]);
  useEffect(() => {
    void load().catch(() => {});
  }, [load, tick]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [view?.messages.length, typing]);

  const send = async (typed = text, shop = asShop) => {
    const body = typed.trim();
    if (!body) return;
    setSending(true);
    try {
      if (shop) await api.ownerMessage(customerId, body);
      else await api.send(customerId, body);
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
      <header className="pane-head">
        <div className="pane-who">
          <Avatar name={name} />
          <div className="pane-names">
            <select className="who-select" value={customerId} onChange={(e) => onCustomer(e.target.value)} aria-label="Show another customer's chat">
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <span className="pane-role">{role}</span>
          </div>
        </div>
        {view?.handedOff && <span className="badge shop">With the shop</span>}
      </header>

      <div className="messages">
        {!view && <div className="muted small">Loading…</div>}
        {view?.messages.length === 0 && view.cards.length === 0 && view.requests.length === 0 && (
          <div className="empty">
            <p>You're writing as {name}. Nothing here yet.</p>
            <button className="try" disabled={sending} onClick={() => void send(TRY[name] ?? TRY_ANYONE, false)}>
              {TRY[name] ?? TRY_ANYONE}
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
        <div ref={bottom} />
      </div>

      {view?.handedOff && (
        <div className="handoff">
          The shop is handling this chat, so the assistant is paused.
          <button className="link" onClick={() => api.handBack(customerId).then(load)}>
            Hand back to the assistant
          </button>
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
          placeholder={asShop ? `Write to ${name} as the shop…` : `Message as ${name}…`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-row">
          <label className="small muted">
            <input type="checkbox" checked={asShop} onChange={(e) => setAsShop(e.target.checked)} /> Reply as the shop
          </label>
          <button className="primary" disabled={sending || !text.trim()}>
            Send
          </button>
        </div>
      </form>
    </section>
  );
}
