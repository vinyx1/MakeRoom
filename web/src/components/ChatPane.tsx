// One customer's chat with the assistant, with their approval cards inline. The owner can also write here
// ("Reply as the shop"), and hand a conversation back after a handoff.

import { useCallback, useEffect, useRef, useState } from 'react';
import { type Config, type Customer, type CustomerView, type Outcome, api } from '../api';
import { shopTime } from '../live';
import { Card, StatusCard } from './Cards';

type Props = {
  customerId: string;
  customers: Customer[];
  onCustomer: (id: string) => void;
  config: Config;
  zone: string;
  tick: number;
  typing: boolean;
  onOutcome: (o: Outcome) => void;
};

export function ChatPane({ customerId, customers, onCustomer, config, zone, tick, typing, onOutcome }: Props) {
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

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setSending(true);
    try {
      if (asShop) await api.ownerMessage(customerId, body);
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
        <span className="pane-title">Chat</span>
        <select value={customerId} onChange={(e) => onCustomer(e.target.value)} aria-label="Customer">
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {view?.handedOff && <span className="badge shop">With the shop</span>}
      </header>

      <div className="messages">
        {!view && <div className="muted small">Loading…</div>}
        {view?.messages.length === 0 && (
          <div className="empty">
            Chatting as <b>{name}</b>. Ask about a booking, e.g. “Can I keep the camera until Thursday at 10am?”
          </div>
        )}
        {view?.messages.map((m) => {
          if (m.cardRevisionIds.length) {
            const card = cardFor(m.cardRevisionIds);
            if (card) shown.add(card.proposalId + card.role);
            return (
              <div className="msg card-msg" key={m.id}>
                {card ? (
                  <Card card={card} customerId={customerId} config={config} zone={zone} onOutcome={onOutcome} />
                ) : (
                  closedCard(m.id, statusFor(m.cardRevisionIds))
                )}
              </div>
            );
          }
          const who = m.author === 'customer' ? name : m.author === 'owner' ? 'Shop' : m.author === 'system' ? 'Shop' : 'Assistant';
          return (
            <div className={`msg ${m.author}`} key={m.id}>
              <div className="who">
                {who} <span className="when">{shopTime(m.at, zone, 'h:mma')}</span>
              </div>
              <div className="body">{m.body}</div>
            </div>
          );
        })}
        {/* A card that no message points at (rare): still show it, so a decision is never stranded. */}
        {view?.cards
          .filter((c) => !shown.has(c.proposalId + c.role))
          .map((c) => (
            <div className="msg card-msg" key={c.proposalId + c.role}>
              <Card card={c} customerId={customerId} config={config} zone={zone} onOutcome={onOutcome} />
            </div>
          ))}
        {typing && <div className="typing">Assistant is replying…</div>}
        <div ref={bottom} />
      </div>

      {view?.handedOff && (
        <div className="handoff">
          The assistant handed this chat to the shop; its replies are drafts for the owner.
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
