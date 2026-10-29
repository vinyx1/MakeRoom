// The page's frame: header with the shop clock and judge-mode controls, the equipment drawer, help, and toasts.

import { useState } from 'react';
import type { OwnerView } from '../api';
import { shopTime, usd } from '../live';

type HeaderProps = {
  owner: OwnerView;
  shopNow: Date;
  onFastForward: (minutes: number) => void;
  onAutoReply: (on: boolean) => void;
  onReset: () => void;
  onEquipment: () => void;
  onHelp: () => void;
};

export function Header({ owner, shopNow, onFastForward, onAutoReply, onReset, onEquipment, onHelp }: HeaderProps) {
  return (
    <header className="top">
      <div className="brand">
        <b>RentFlow</b> <span className="muted">· {owner.shop.name}</span>
      </div>
      <div className="clock" title="The demo runs on its own clock">
        Shop time <b>{shopTime(shopNow, owner.shop.timezone, 'ccc d LLL, h:mma')}</b>
        <button onClick={() => onFastForward(30)} title="Jump the shop clock ahead; offers waiting past their timeout expire">
          +30 min
        </button>
      </div>
      <div className="controls">
        <label title="Affected customers answer their offers by themselves, so you can play only the requester">
          <input type="checkbox" checked={owner.shop.autoReplyCustomers} onChange={(e) => onAutoReply(e.target.checked)} /> Auto-reply customers
        </label>
        <button onClick={onEquipment}>Equipment</button>
        <button
          onClick={() => {
            if (window.confirm('Start the demo over? Every change in this shop is undone and open payment holds are released.')) onReset();
          }}
        >
          Reset demo
        </button>
        <button onClick={onHelp} aria-label="How to demo">
          ?
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
          You play everyone: the owner (left) and two customers (right; switch them with the menus). Payments use the PayPal sandbox; the
          buyer login is shown on each payment card. Reset demo starts over any time.
        </p>
        <h4>1 · The extension</h4>
        <ol>
          <li>As Alice: “Shoot ran over. Can I keep the camera until Thursday at 10am?”</li>
          <li>Pay on her card with PayPal. The schedule shows the plan as ghosts.</li>
          <li>As Bob: pick option B (2pm, $15 back). Or turn on Auto-reply customers and he picks it himself.</li>
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
        <p className="muted small">+30 min jumps the shop clock: offers waiting more than 30 minutes expire and their holds are released.</p>
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
  | { step: 'claimed'; name: string; requesters: string[]; resolve: (override: boolean) => void };

export function EditDialog({ prompt }: { prompt: EditPrompt }) {
  const [agreed, setAgreed] = useState(false);
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
      <div className="modal warn">
        <h3>{prompt.name}'s booking is part of a pending request</h3>
        <p>
          {prompt.requesters.join(', ')}'s request depends on it. Overriding cancels that request and releases their payment hold; they'll be
          offered a new plan against your change.
        </p>
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
