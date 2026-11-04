// The owner's messages: every customer's chat, like a messaging app. The list comes first; choosing someone opens
// their thread, where the owner can write as the shop. Writing pauses the assistant in that chat until it's handed
// back (docs/conflict-model.md §7). Decisions stay on the customer's own cards (invariant 3), so here a card is only
// a line saying one was sent.

import { useEffect, useRef, useState } from 'react';
import { type Customer, type Message, type Outcome, type OwnerView, api } from '../api';
import { shopTime } from '../live';
import { Avatar, Mark } from './Chrome';

type Props = {
  owner: OwnerView;
  openId: string | null;
  onOpen: (customerId: string | null) => void;
  typing: (customerId: string) => boolean;
  onOutcome: (o: Outcome) => void;
  onChanged: () => void;
};

const inOrder = (messages: Message[]) => [...messages].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
const sentToCustomer = (m: Message) => !m.isOwnerDraft;

function preview(m: Message | undefined, name: string) {
  if (!m) return 'No messages yet';
  if (m.cardRevisionIds.length) return `Offer card sent to ${name}`;
  const who = m.author === 'owner' ? 'You: ' : m.author === 'agent' ? 'Assistant: ' : m.author === 'system' ? 'Shop: ' : '';
  return who + m.body;
}

export function OwnerMessages({ owner, openId, onOpen, typing, onOutcome, onChanged }: Props) {
  // What the owner has read, for this visit: how many of each customer's messages they've seen.
  const [seen, setSeen] = useState<Record<string, number>>({});
  const threadOf = (id: string) => owner.conversations.find((c) => c.customerId === id);
  const messagesOf = (id: string) => inOrder((threadOf(id)?.messages ?? []) as Message[]);
  const fromCustomer = (id: string) => messagesOf(id).filter((m) => m.author === 'customer').length;

  const openCount = openId ? fromCustomer(openId) : 0;
  useEffect(() => {
    if (openId) setSeen((s) => (s[openId] === openCount ? s : { ...s, [openId]: openCount }));
  }, [openId, openCount]);

  const open = owner.customers.find((c) => c.id === openId);
  if (open) return <Thread customer={open} owner={owner} messages={messagesOf(open.id)} typing={typing(open.id)} onBack={() => onOpen(null)} onOutcome={onOutcome} onChanged={onChanged} />;

  const latestAt = (id: string) => {
    const last = messagesOf(id).filter(sentToCustomer).at(-1);
    return last ? new Date(last.at).getTime() : 0;
  };
  const rows = [...owner.customers].sort((a, b) => latestAt(b.id) - latestAt(a.id) || a.name.localeCompare(b.name));
  const unreadTotal = rows.filter((c) => fromCustomer(c.id) > (seen[c.id] ?? 0)).length;

  return (
    <section className="pane threads">
      <header className="pane-head">
        <h2 className="pane-title">Messages</h2>
        <span className={`count ${unreadTotal ? 'hot' : ''}`}>{unreadTotal ? `${unreadTotal} new` : ''}</span>
      </header>
      <ul className="thread-list">
        {rows.map((c) => {
          const last = messagesOf(c.id).filter(sentToCustomer).at(-1);
          const unread = fromCustomer(c.id) > (seen[c.id] ?? 0);
          return (
            <li key={c.id}>
              <button className={`thread-row ${unread ? 'unread' : ''}`} onClick={() => onOpen(c.id)}>
                <Avatar name={c.name} />
                <span className="thread-text">
                  <span className="thread-top">
                    <span className="thread-name">{c.name}</span>
                    {threadOf(c.id)?.handedOffAt && <span className="tag held">With you</span>}
                    <span className="thread-when">{last ? shopTime(last.at, owner.shop.timezone, 'h:mma').toLowerCase() : ''}</span>
                  </span>
                  <span className="thread-preview">{typing(c.id) ? 'Assistant is replying…' : preview(last, c.name)}</span>
                </span>
                {unread && <span className="unread-dot" aria-label="New message" />}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Thread({ customer, owner, messages, typing, onBack, onOutcome, onChanged }: { customer: Customer; owner: OwnerView; messages: Message[]; typing: boolean; onBack: () => void; onOutcome: (o: Outcome) => void; onChanged: () => void }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const zone = owner.shop.timezone;
  const handedOff = !!owner.conversations.find((c) => c.customerId === customer.id)?.handedOffAt;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [customer.id, messages.length, typing]);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setSending(true);
    try {
      await api.ownerMessage(customer.id, body);
      setText('');
      onChanged();
    } catch (e) {
      onOutcome({ status: 'error', reason: (e as Error).message });
    } finally {
      setSending(false);
    }
  };
  const handBack = async () => {
    try {
      await api.handBack(customer.id);
      onChanged();
    } catch (e) {
      onOutcome({ status: 'error', reason: (e as Error).message });
    }
  };

  return (
    <section className="pane threads chat">
      <header className="pane-head">
        <button className="back" onClick={onBack} aria-label="Back to all messages">‹</button>
        <div className="pane-who">
          <Avatar name={customer.name} />
          <div className="pane-names">
            <span className="pane-title">{customer.name}</span>
            <span className="pane-role">{handedOff ? 'You are handling this chat' : 'The assistant is handling this chat'}</span>
          </div>
        </div>
      </header>
      <div className="messages">
        {messages.length === 0 && <div className="empty">No messages with {customer.name} yet.</div>}
        {messages.map((m) => {
          if (m.cardRevisionIds.length) return <div className="thread-note" key={m.id}>Offer card sent to {customer.name} · {shopTime(m.at, zone, 'h:mma').toLowerCase()}</div>;
          const who = m.author === 'customer' ? customer.name : m.author === 'owner' ? 'You' : m.author === 'system' ? 'Shop' : 'Assistant';
          return (
            <div className={`msg ${m.author} ${m.isOwnerDraft ? 'draft' : ''}`} key={m.id}>
              {who === 'Assistant' ? <Mark size={22} /> : <Avatar name={who} />}
              <div>
                <div className="who">
                  {who}
                  {m.isOwnerDraft && <span className="when">Draft, not sent</span>}
                  <span className="when">{shopTime(m.at, zone, 'h:mma').toLowerCase()}</span>
                </div>
                <div className="body">{m.body}</div>
              </div>
            </div>
          );
        })}
        {typing && !handedOff && <div className="typing">Assistant is replying…</div>}
        <div ref={bottom} />
      </div>
      {handedOff && (
        <div className="handoff">
          The assistant is paused here.
          <button className="link" onClick={handBack}>Hand back to the assistant</button>
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
          placeholder={`Write to ${customer.name} as the shop…`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-row">
          <span className="small muted">{handedOff ? '' : 'Sending pauses the assistant in this chat.'}</span>
          <button className="primary" disabled={sending || !text.trim()}>Send</button>
        </div>
      </form>
    </section>
  );
}
