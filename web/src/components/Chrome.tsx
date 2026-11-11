// The page's frame: the sidebar, the top bar with the shop clock, the equipment drawer, help, and toasts.

import { DateTime } from 'luxon';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { type Customer, type OwnerView, api } from '../api';
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

/**
 * A native modal dialog: focus moves inside and returns to where it was on close, the page behind is inert, and
 * Escape calls onClose. Focus starts on `[data-autofocus]` if there is one, else on the first control.
 */
export function Modal({ className = '', onClose, dismissOnBackdrop = false, children }: { className?: string; onClose: () => void; dismissOnBackdrop?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const before = document.activeElement as HTMLElement | null;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      dialog.close();
      before?.focus?.();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal-dialog"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (dismissOnBackdrop && e.target === ref.current) onClose();
      }}
    >
      <div className={`modal ${className}`}>{children}</div>
    </dialog>
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
      <a className="brand" href="/" title="Back to the home page">
        <Mark />
        <span className="brand-name">MakeRoom</span>
      </a>
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

type TopBarProps = { owner: OwnerView; shopNow: Date; onFastForward: (minutes: number) => void; phoneOpen: boolean; onPhone: () => void; waitingOn: Customer[] };

export function TopBar({ owner, shopNow, onFastForward, phoneOpen, onPhone, waitingOn }: TopBarProps) {
  const zone = owner.shop.timezone;
  return (
    <header className="top">
      <ShopSwitcher owner={owner} />
      <button onClick={scheduleToToday} title="Scroll the schedule back to the current time">Today</button>
      <div className="clock">
        {/* The demo runs on its own clock; the jumps sit on it, so it reads as one control. */}
        <div className="clock-group" role="group" aria-label="Shop clock">
          <span className="clock-now">
            <span className="muted">Shop time</span> <b>{shopTime(shopNow, zone, 'ccc d LLL, h:mma')}</b>
          </span>
          <button onClick={() => onFastForward(30)} title="Jump the shop clock ahead; offers waiting past their timeout expire">
            +30 min
          </button>
          <button onClick={() => onFastForward(240)} title="Jump the shop clock ahead four hours">
            +4 h
          </button>
        </div>
        <button className={`phone-toggle ${!phoneOpen && waitingOn.length ? 'waiting' : ''}`} aria-pressed={phoneOpen} onClick={onPhone}>
          {phoneOpen ? 'Hide phone' : waitingOn.length ? `Phone · ${waitingOn[0]!.name} has an offer` : 'Customer phone'}
        </button>
      </div>
    </header>
  );
}

/** The shop name opens the visitor's other demo shop. Each keeps its own state; the page reloads into the one chosen. */
function ShopSwitcher({ owner }: { owner: OwnerView }) {
  const [open, setOpen] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const choose = async (id: string, label: string) => {
    if (id === owner.shop.scenario) return setOpen(false);
    setOpening(label);
    setError(null);
    try {
      await api.switchShop(id);
      window.location.reload();
    } catch (e) {
      setOpening(null);
      setError((e as Error).message);
    }
  };

  return (
    <div className="shop-switch" ref={root}>
      <button className="shop-switch-button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <h1>{owner.shop.name}</h1>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <div className="shop-menu" role="menu">
          {owner.shop.demo.shops.map((s) => (
            <button key={s.id} role="menuitemradio" aria-checked={s.id === owner.shop.scenario} disabled={!!opening} onClick={() => void choose(s.id, s.label)}>
              <span className="shop-menu-name">{s.label}</span>
              <span className="muted small">{opening === s.label ? 'Opening, and placing its sandbox payments…' : s.tagline}</span>
            </button>
          ))}
          {error && <div className="error small">{error}</div>}
        </div>
      )}
    </div>
  );
}

export function EquipmentDrawer({ owner, onClose }: { owner: OwnerView; onClose: () => void }) {
  const zone = owner.shop.timezone;
  const unitLabel = (id: string | null) => owner.units.find((u) => u.id === id)?.label;
  const modelName = (id: string | null) => owner.models.find((m) => m.id === id)?.name;
  // Not modal (the schedule stays usable beside it), but Escape closes it and focus goes back to where it was.
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('keydown', esc);
      before?.focus?.();
    };
  }, [onClose]);
  return (
    <aside className="drawer" role="dialog" aria-label="Equipment">
      <header className="pane-head">
        <span className="pane-title">Equipment</span>
        <button className="link" ref={close} onClick={onClose}>
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

function YardHelp({ onClose }: { onClose: () => void }) {
  return (
    <Modal className="help" onClose={onClose} dismissOnBackdrop>
        <h3 tabIndex={-1} data-autofocus>A rainy Monday at the yard</h3>
        <p className="muted small">
          It's 6:30am after a wet weekend. The same engine as the camera shop, with four problems already open at once. Each holds what it needs, so they can't step on each other. Handle them in any order. A dot on the phone marks anyone with an offer to answer.
        </p>
        <h4>The rain delay</h4>
        <ol>
          <li>Harbor needs their skid steer until Wednesday, which runs into Northside's booking. Harbor's hold is already placed.</li>
          <li>On the phone, open Delgado Paving: they're asked to take a track loader on Tuesday, at no extra charge.</li>
          <li>When they accept, Northside moves to Delgado's skid steer. It's the same model, so they only get a notice.</li>
        </ol>
        <h4>Over the assistant's limit</h4>
        <ol>
          <li>Redwood's extra day would put Mesa on a larger machine for four days. That's $560 of list value, more than the cap and more than Redwood pays, though the shop still collects $340.</li>
          <li>It waits for you under Needs owner approval, and Mesa hears nothing until you decide. Approve, then answer as Mesa.</li>
        </ol>
        <h4>Will it fit?</h4>
        <ol>
          <li>Summit phoned in an extension. The only machine left for Alder's backyard job is the larger Cat 308, and nobody has recorded whether it's right for that site: the gate, its weight, the ground.</li>
          <li>Answer on your card. Yes and Approve moves on to Summit's payment and Alder's answer. No ends that plan, and nothing moves.</li>
        </ol>
        <h4>The last telehandler</h4>
        <ol>
          <li>Pacific's extension holds the Genie for Coastline while Coastline decides.</li>
          <li>As Dune Framing, press the one-click message. Both telehandlers are taken or held for those days, so the assistant works from what's actually free.</li>
          <li>Open Coastline Roofing and choose Keep my booking as is. The Genie is released, and Dune can ask again.</li>
        </ol>
        <p className="muted small">Reset demo starts this shop over and leaves the camera shop as it is. Switch shops from the name at the top.</p>
        <button className="primary" onClick={onClose}>
          Got it
        </button>
    </Modal>
  );
}

export function Help({ scenario, onClose }: { scenario: string; onClose: () => void }) {
  if (scenario === 'yard') return <YardHelp onClose={onClose} />;
  return (
    <Modal className="help" onClose={onClose} dismissOnBackdrop>
        <h3 tabIndex={-1} data-autofocus>How to demo</h3>
        <p className="muted small">
          You play everyone: the owner (Needs owner approval and Owner's Messages) and one customer at a time, on the phone at the side. Switch accounts along the top of the phone; a dot marks anyone with an offer to answer. Payments use the PayPal sandbox; the
          buyer login is shown on each payment card. Reset demo starts over any time.
        </p>
        <h4>1 · The extension</h4>
        <ol>
          <li>As Vincent: “Shoot ran over. Can I keep the camera until Thursday at 10am?”</li>
          <li>Pay on his card with PayPal. The schedule shows the plan as ghosts.</li>
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
          <li>Do 1 until Vincent has paid.</li>
          <li>Drag Bob's pickup to Thu 2pm, tick “Bob agreed by phone”. The warning names Vincent's pending request: Override.</li>
          <li>Vincent's request is cancelled, his hold released, and he gets a fresh offer that now fits.</li>
        </ol>
        <h4>Cancelling a booking</h4>
        <p className="muted small">Click a booking on the schedule and choose Delete booking, or select it and press Delete. It asks you to confirm the customer agreed by phone, then refunds everything they paid. For a rental that's out, the same click offers Mark returned.</p>
        <h4>4 · A late return</h4>
        <ol>
          <li>The demo starts at Wed 5:30pm, 30 minutes before Vincent's camera is due back. Press +30 min and it shows under Needs owner approval as “Due back”.</li>
          <li>Mark overdue, expected back Thu 10am. That runs into Bob's pickup, so the plans come to you first: Approve one.</li>
          <li>As Bob: accept it, or keep the booking (then you're alerted to sort it out). Mark returned when he's back.</li>
        </ol>
        <p className="muted small">
          +30 min and +4 h jump the shop clock: offers waiting more than 30 minutes expire and their holds are released.
        </p>
        <button className="primary" onClick={onClose}>
          Got it
        </button>
    </Modal>
  );
}

export type Toast = { id: number; kind: 'ok' | 'warn' | 'error'; text: string };

/** Confirmations fade on their own; warnings and errors stay until dismissed, so nothing that went wrong slips by unread. */
export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="status">
      {toasts.map((t) => (
        <div className={`toast ${t.kind}`} key={t.id}>
          <span>{t.text}</span>
          {t.kind !== 'ok' && (
            <button className="toast-close" onClick={() => onDismiss(t.id)} aria-label="Dismiss">
              ×
            </button>
          )}
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
  | { step: 'overdue'; name: string; summary: string; initial: string; resolve: (expected: string | null) => void }
  /** Change times or unit: the same edit as a drag, for the keyboard. Times are shop-local `yyyy-MM-ddTHH:mm`. */
  | { step: 'move'; name: string; units: { id: string; label: string }[]; initial: Placement; resolve: (placement: Placement | null) => void };

export type Placement = { unitId: string; startsAt: string; endsAt: string };

export function EditDialog({ prompt }: { prompt: EditPrompt }) {
  const [agreed, setAgreed] = useState(false);
  const [expected, setExpected] = useState(prompt.step === 'overdue' ? prompt.initial : '');
  const [place, setPlace] = useState<Placement | null>(prompt.step === 'move' ? prompt.initial : null);
  if (prompt.step === 'move') {
    const at = place ?? prompt.initial;
    return (
      <Modal onClose={() => prompt.resolve(null)}>
        <h3>Change {prompt.name}'s booking</h3>
        <label>
          Unit{' '}
          <select value={at.unitId} onChange={(e) => setPlace({ ...at, unitId: e.target.value })}>
            {prompt.units.map((u) => (
              <option key={u.id} value={u.id}>{u.label}</option>
            ))}
          </select>
        </label>
        <label>
          Pickup (shop time) <input type="datetime-local" step={3600} value={at.startsAt} onChange={(e) => setPlace({ ...at, startsAt: e.target.value })} />
        </label>
        <label>
          Return (shop time) <input type="datetime-local" step={3600} value={at.endsAt} onChange={(e) => setPlace({ ...at, endsAt: e.target.value })} />
        </label>
        <p className="muted small">Next you're asked whether {prompt.name} agreed. A change that conflicts is kept as a red draft, as with a drag.</p>
        <div className="row">
          <button className="primary" onClick={() => prompt.resolve(at)}>
            Continue
          </button>
          <button onClick={() => prompt.resolve(null)}>Cancel</button>
        </div>
      </Modal>
    );
  }
  if (prompt.step === 'overdue')
    return (
      <Modal onClose={() => prompt.resolve(null)}>
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
      </Modal>
    );
  if (prompt.step === 'cancel')
    return (
      <Modal onClose={() => prompt.resolve(false)}>
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
      </Modal>
    );
  if (prompt.step === 'agree')
    return (
      <Modal onClose={() => prompt.resolve(false)}>
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
      </Modal>
    );
  if (prompt.step === 'confirm')
    return (
      <Modal onClose={() => prompt.resolve(null)}>
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
      </Modal>
    );
  return (
    <Modal onClose={() => prompt.resolve(false)}>
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
          <button data-autofocus onClick={() => prompt.resolve(false)}>Cancel</button>
        </div>
    </Modal>
  );
}
