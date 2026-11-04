// The page's frame: the sidebar, the top bar with the shop clock, the equipment drawer, help, and toasts.

import { DateTime } from 'luxon';
import { useState } from 'react';
import type { OwnerView } from '../api';
import { scheduleToToday } from '../highlight';
import { shopTime, usd } from '../live';

/** Three schedule bars, the middle one moved over to make room. */
export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <rect x="1" y="2" width="11" height="4" rx="1.5" fill="#1d1f22" />
      <rect x="8" y="8" width="11" height="4" rx="1.5" fill="#d9480f" />
      <rect x="1" y="14" width="11" height="4" rx="1.5" fill="#1d1f22" />
    </svg>
  );
}

/** A person's initial on a pale tint of their own, stable by name. */
export function Avatar({ name }: { name: string }) {
  const hue = [...name].reduce((sum, c) => sum + c.charCodeAt(0) * 47, 0) % 360;
  return (
    <span className="avatar" style={{ background: `hsl(${hue} 38% 88%)`, color: `hsl(${hue} 45% 26%)` }} aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function MiniMonth({ now, zone }: { now: string; zone: string }) {
  const today = DateTime.fromISO(now, { zone }).startOf('day');
  const first = today.startOf('month');
  const start = first.startOf('week');
  const spanStart = today.startOf('week');
  const spanEnd = spanStart.plus({ days: 6 });
  const days = Array.from({ length: first.plus({ months: 1 }).diff(start, 'days').days > 35 ? 42 : 35 }, (_, i) => start.plus({ days: i }));
  return (
    <section className="side-sec ref" aria-label={`${today.toFormat('LLLL yyyy')}, with this week marked`}>
      <h2 className="side-title">{today.toFormat('LLLL yyyy')}</h2>
      <div className="month-grid">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <span className="dow" key={i}>{d}</span>
        ))}
        {days.map((d) => {
          const inSpan = d >= spanStart && d <= spanEnd;
          const cls = ['day', d.month !== first.month && 'out', inSpan && 'span', +d === +spanStart && 'span-start', +d === +spanEnd && 'span-end', +d === +today && 'today'];
          return (
            <span className={cls.filter(Boolean).join(' ')} key={d.toISODate()}>
              {d.day}
            </span>
          );
        })}
      </div>
    </section>
  );
}

/** Who comes to the counter: the pickups and returns of today and tomorrow, in the shop's time. */
function AtTheCounter({ owner }: { owner: OwnerView }) {
  const zone = owner.shop.timezone;
  const now = DateTime.fromISO(owner.shop.now, { zone });
  const today = now.toISODate();
  const tomorrow = now.plus({ days: 1 }).toISODate();
  const nameOf = (id: string) => owner.customers.find((c) => c.id === id)?.name ?? 'A customer';
  const unitOf = (id: string | null) => owner.units.find((u) => u.id === id)?.label ?? 'no unit yet';
  const rows = owner.bookings
    .flatMap((b) => [
      { key: `${b.id}-out`, at: b.startsAt, text: `${nameOf(b.customerId)} picks up ${unitOf(b.unitId)}` },
      { key: `${b.id}-in`, at: b.endsAt, text: `${nameOf(b.customerId)} returns ${unitOf(b.unitId)}` },
    ])
    .sort((a, b) => a.at.localeCompare(b.at));
  const day = (date: string | null, title: string, none: string) => {
    const those = rows.filter((r) => DateTime.fromISO(r.at, { zone }).toISODate() === date);
    return (
      <section className="side-sec ref">
        <h2 className="side-title">{title}</h2>
        {those.length === 0 && <div className="small muted">{none}</div>}
        <ul className="counter">
          {those.slice(0, 4).map((r) => (
            <li key={r.key}>
              <span className="when">{shopTime(r.at, zone, 'h:mma').toLowerCase()}</span>
              <span>{r.text}</span>
            </li>
          ))}
        </ul>
      </section>
    );
  };
  return (
    <>
      {day(today, 'At the counter today', 'No pickups or returns.')}
      {day(tomorrow, 'Tomorrow', 'No pickups or returns.')}
    </>
  );
}

type SidebarProps = {
  owner: OwnerView;
  onReset: () => void;
  onEquipment: () => void;
  onHelp: () => void;
};

export function Sidebar({ owner, onReset, onEquipment, onHelp }: SidebarProps) {
  return (
    <aside className="side">
      <div className="brand">
        <Mark />
        <span className="brand-name">MakeRoom</span>
      </div>
      <MiniMonth now={owner.shop.now} zone={owner.shop.timezone} />
      <AtTheCounter owner={owner} />
      <section className="side-sec ref">
        <h2 className="side-title">On the schedule</h2>
        <ul className="legend">
          <li><span className="swatch booked" /> Confirmed</li>
          <li><span className="swatch out" /> Out with the customer</li>
          <li><span className="swatch proposal" /> Proposed by the assistant</li>
          {owner.drafts.length > 0 && <li><span className="swatch draft" /> Your draft, in conflict</li>}
          {owner.bookings.some((b) => b.status === 'picked_up' && b.overdueMarkedAt) && <li><span className="swatch overdue" /> Overdue</li>}
        </ul>
      </section>
      <div className="side-foot">
        <button className="nav-btn" onClick={onEquipment}>Equipment</button>
        <button className="nav-btn" onClick={onHelp}>How to demo</button>
        <button
          className="nav-btn"
          onClick={() => {
            if (window.confirm('Start the demo over? Every change in this shop is undone and open payment holds are released.')) onReset();
          }}
        >
          Reset demo
        </button>
      </div>
    </aside>
  );
}

export function TopBar({ owner, shopNow, onFastForward }: { owner: OwnerView; shopNow: Date; onFastForward: (minutes: number) => void }) {
  const zone = owner.shop.timezone;
  return (
    <header className="top">
      <h1>{owner.shop.name}</h1>
      <button onClick={scheduleToToday} title="Scroll the schedule back to the current time">Today</button>
      <div className="clock" title="The demo runs on its own clock">
        <span className="muted">Shop time</span> <b>{shopTime(shopNow, zone, 'ccc d LLL, h:mma')}</b>
        <button onClick={() => onFastForward(30)} title="Jump the shop clock ahead; offers waiting past their timeout expire">
          +30 min
        </button>
        <button onClick={() => onFastForward(240)} title="Jump the shop clock ahead four hours">
          +4 h
        </button>
      </div>
    </header>
  );
}

export function EquipmentDrawer({ owner, onClose }: { owner: OwnerView; onClose: () => void }) {
  const zone = owner.shop.timezone;
  const unitLabel = (id: string | null) => owner.units.find((u) => u.id === id)?.label;
  const modelName = (id: string | null) => owner.models.find((m) => m.id === id)?.name;
  return (
    <aside className="drawer" role="dialog" aria-label="Equipment">
      <header className="pane-head">
        <span className="pane-title">Equipment</span>
        <button className="link" onClick={onClose}>
          Close
        </button>
      </header>
      <h4>Facts</h4>
      {owner.facts.length === 0 && <div className="muted small">No facts recorded.</div>}
      {owner.facts.map((f) => (
        <div className="fact" key={f.id}>
          <div>
            <b>{unitLabel(f.unitId) ?? modelName(f.modelId)}</b>: {f.label ?? f.key.replaceAll('_', ' ')}
          </div>
          <div>
            <span className={`badge fact-${f.value}`}>{f.value}</span>{' '}
            <span className="muted small">
              {f.value === 'unknown' ? (f.source === 'agent' ? 'asked by the assistant, waiting for the shop' : 'not known yet') : `source: ${f.source}, ${shopTime(f.setAt, zone)}`}
            </span>
          </div>
        </div>
      ))}
      <h4>Models</h4>
      {owner.models.map((m) => (
        <div className="fact" key={m.id}>
          <b>{m.name}</b> <span className="muted small">{m.category.replace('_', ' ')} · {usd(m.dailyRateCents)}/day</span>
          <div className="muted small">{owner.units.filter((u) => u.modelId === m.id).map((u) => u.label).join(', ')}</div>
        </div>
      ))}
      <h4>Unavailable</h4>
      {owner.unavailability.map((u) => (
        <div className="fact" key={u.id}>
          <b>{unitLabel(u.unitId)}</b> <span className="muted small">{u.reason.replace('_', ' ')}: {shopTime(u.period.start, zone)} → {shopTime(u.period.end, zone)}</span>
        </div>
      ))}
    </aside>
  );
}

export function Help({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal help" onClick={(e) => e.stopPropagation()}>
        <h3>How to demo</h3>
        <p className="muted small">
          You play everyone: the owner (Needs owner approval and Owner's Messages) and one customer at a time (bottom right; switch with the menu by their name, or the prompt that appears when someone has an offer to answer). Payments use the PayPal sandbox; the
          buyer login is shown on each payment card. Reset demo starts over any time.
        </p>
        <h4>1 · The extension</h4>
        <ol>
          <li>As Alice: “Shoot ran over. Can I keep the camera until Thursday at 10am?”</li>
          <li>Pay on her card with PayPal. The schedule shows the plan as ghosts.</li>
          <li>On Bob's card, press “Let Bob answer” and he takes option B (2pm, $15 back). Or choose for him with the card's own buttons.</li>
          <li>As the owner: Approve. The payment is captured, both bookings move, and Bob is refunded.</li>
        </ol>
        <h4>2 · The owner drags, the assistant asks</h4>
        <ol>
          <li>Drag the end of Dana's RS3 booking to Fri 9am and tick “Dana agreed by phone”. It turns into a red draft.</li>
          <li>Resolve with agent. The owner card asks whether the Crane 4 balances Eve's rig: answer Yes and Approve, then Save as fact.</li>
          <li>As Dana: pay. As Eve: accept the Crane 4. Check Equipment: the fact is now “yes”.</li>
        </ol>
        <h4>3 · The race</h4>
        <ol>
          <li>Do 1 until Alice has paid.</li>
          <li>Drag Bob's pickup to Thu 2pm, tick “Bob agreed by phone”. The warning names Alice's pending request: Override.</li>
          <li>Alice's request is cancelled, her hold released, and she gets a fresh offer that now fits.</li>
        </ol>
        <h4>Cancelling a booking</h4>
        <p className="muted small">Click a booking on the schedule and choose Delete booking, or select it and press Delete. It asks you to confirm the customer agreed by phone, then refunds everything they paid. For a rental that's out, the same click offers Mark returned.</p>
        <h4>4 · A late return</h4>
        <ol>
          <li>The demo starts at Wed 5:30pm, 30 minutes before Alice's camera is due back. Press +30 min and it shows under Needs owner approval as “Due back”.</li>
          <li>Mark overdue, expected back Thu 10am. That runs into Bob's pickup, so the plans come to you first: Approve one.</li>
          <li>As Bob: accept it, or keep the booking (then you're alerted to sort it out). Mark returned when she's back.</li>
        </ol>
        <p className="muted small">
          +30 min and +4 h jump the shop clock: offers waiting more than 30 minutes expire and their holds are released.
        </p>
        <button className="primary" onClick={onClose}>
          Got it
        </button>
      </div>
    </div>
  );
}

export type Toast = { id: number; kind: 'ok' | 'warn' | 'error'; text: string };

export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div className={`toast ${t.kind}`} key={t.id}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

/** Owner edit flow: "agreed by phone?", then the pending-request warning with Override. */
export type EditPrompt =
  | { step: 'confirm'; name: string; summary: string; resolve: (answer: { agreed: boolean } | null) => void }
  | { step: 'claimed'; name: string; requesters: string[]; resolve: (override: boolean) => void }
  /** Resolve with agent on a draft whose customer's agreement wasn't ticked at the drag. */
  | { step: 'agree'; name: string; summary: string; resolve: (agreed: boolean) => void }
  /** Delete on a booking: cancel it and refund what the customer paid. */
  | { step: 'cancel'; name: string; summary: string; refund: string; resolve: (confirmed: boolean) => void }
  /** Mark overdue: when the customer now expects to return it, as shop-local `yyyy-MM-ddTHH:mm`. */
  | { step: 'overdue'; name: string; summary: string; initial: string; resolve: (expected: string | null) => void };

export function EditDialog({ prompt }: { prompt: EditPrompt }) {
  const [agreed, setAgreed] = useState(false);
  const [expected, setExpected] = useState(prompt.step === 'overdue' ? prompt.initial : '');
  if (prompt.step === 'overdue')
    return (
      <div className="modal-back">
        <div className="modal">
          <h3>{prompt.name} is late returning</h3>
          <p>{prompt.summary}</p>
          <label>
            Expected back (shop time) <input type="datetime-local" value={expected} onChange={(e) => setExpected(e.target.value)} />
          </label>
          <p className="muted small">
            The assistant re-plans the next bookings around this time. {prompt.name} isn't charged for the extra time. Any plan that
            costs the shop comes to you first, before another customer is asked.
          </p>
          <div className="row">
            <button className="primary" disabled={!expected} onClick={() => prompt.resolve(expected)}>
              Mark overdue
            </button>
            <button onClick={() => prompt.resolve(null)}>Cancel</button>
          </div>
        </div>
      </div>
    );
  if (prompt.step === 'cancel')
    return (
      <div className="modal-back">
        <div className="modal">
          <h3>Cancel {prompt.name}'s booking?</h3>
          <p>{prompt.summary}</p>
          <p><b>{prompt.refund}</b> goes back to {prompt.name}'s original payment: everything they paid for this booking.</p>
          <label>
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /> {prompt.name} agreed by phone
          </label>
          <p className="muted small">This can't be undone. {prompt.name} is told straight away.</p>
          <div className="row">
            <button className="danger" disabled={!agreed} onClick={() => prompt.resolve(true)}>
              Cancel booking and refund
            </button>
            <button onClick={() => prompt.resolve(false)}>Keep booking</button>
          </div>
        </div>
      </div>
    );
  if (prompt.step === 'agree')
    return (
      <div className="modal-back">
        <div className="modal">
          <h3>Did {prompt.name} agree to this change?</h3>
          <p>{prompt.summary}</p>
          <p className="muted small">
            The assistant arranges the change on {prompt.name}'s behalf, so it needs their agreement, for example by phone. {prompt.name} still pays
            on their own card, and anyone else affected is asked as usual.
          </p>
          <div className="row">
            <button className="primary" onClick={() => prompt.resolve(true)}>
              Yes, {prompt.name} agreed: resolve
            </button>
            <button onClick={() => prompt.resolve(false)}>Cancel</button>
          </div>
        </div>
      </div>
    );
  if (prompt.step === 'confirm')
    return (
      <div className="modal-back">
        <div className="modal">
          <h3>Change {prompt.name}'s booking?</h3>
          <p>{prompt.summary}</p>
          <label>
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /> {prompt.name} agreed by phone
          </label>
          <p className="muted small">Without their agreement the change can't apply; a conflicting change is kept as a red draft either way.</p>
          <div className="row">
            <button className="primary" onClick={() => prompt.resolve({ agreed })}>
              Save change
            </button>
            <button onClick={() => prompt.resolve(null)}>Cancel</button>
          </div>
        </div>
      </div>
    );
  return (
    <div className="modal-back">
      <div className="modal">
        <h3>{prompt.name}'s booking is part of a pending request</h3>
        <p>
          {prompt.requesters.join(', ')}'s request depends on it. Overriding cancels that request and releases their payment hold; they'll be
          offered a new plan against your change.
        </p>
        <p className="muted small">This can't be undone: the customers are told straight away.</p>
        <div className="row">
          <button className="danger" onClick={() => prompt.resolve(true)}>
            Override
          </button>
          <button onClick={() => prompt.resolve(false)}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
