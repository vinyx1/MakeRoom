// Approval cards in a customer's chat. Their words come from the server, rendered from the stored revision; a
// decision is only ever a click here (invariant 3). The requester pays through the PayPal button (JS SDK v6, see
// spikes/paypal/FINDINGS.md): createOrder asks our server for the order, onApprove has it authorize.

import { INSTANCE_LOADING_STATE, PayPalOneTimePaymentButton, usePayPal } from '@paypal/react-paypal-js/sdk-v6';
import { useState } from 'react';
import { type Config, type CustomerCard, type Outcome, api } from '../api';
import { usd } from '../live';

type CardProps = { card: CustomerCard; customerId: string; config: Config; zone: string; onOutcome: (o: Outcome) => void };

export function Card(props: CardProps) {
  return props.card.role === 'requester' ? <RequesterCard {...props} /> : <AffectedCard {...props} />;
}

function Terms({ lines, needsShop, isAlternative }: { lines: string[]; needsShop: boolean; isAlternative: boolean }) {
  return (
    <>
      {isAlternative && <div className="badge alt">Closest alternative</div>}
      <ul className="terms">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      {needsShop && <div className="badge shop">Needs shop confirmation</div>}
    </>
  );
}

function RequesterCard({ card, customerId, config, onOutcome }: CardProps) {
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  const offer = card.options[0]!;
  if (hidden) return <button className="link" onClick={() => setHidden(false)}>Show the offer again</button>;

  const run = async (fn: () => Promise<Outcome>) => {
    setBusy(true);
    try {
      onOutcome(await fn());
    } catch (e) {
      onOutcome({ status: 'error', reason: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const payWithTestCard = () =>
    run(async () => {
      const order = await api.order(card.proposalId, customerId, true);
      if (order.status !== 'ok') return order;
      return api.accept(card.proposalId, customerId);
    });

  const cancel = () =>
    run(async () => {
      const r = await api.cancel(card.proposalId, customerId);
      return r.status === 'rejected' ? { status: 'cancelled', reason: 'Request cancelled: your booking stays as it was, and any payment hold is released.' } : r;
    });
  // A fallback alternative that costs no more than what's already held is accepted without paying again.
  const needsPayment = card.chargeCents > 0 && card.heldCents < card.chargeCents;

  return (
    <div className="card requester">
      <div className="card-head">{offer.isAlternative ? 'The closest we can do' : 'Your offer'}</div>
      <Terms lines={offer.lines} needsShop={offer.needsShop} isAlternative={offer.isAlternative} />
      {needsPayment ? (
        <>
          <div className="hold-note">
            <b>Nothing is charged yet.</b> PayPal holds {usd(card.chargeCents)} while we confirm. You're only charged if it goes ahead;
            otherwise the hold is released automatically.
          </div>
          <PayPalCheckout card={card} customerId={customerId} onOutcome={onOutcome} disabled={busy} />
          {config.sandboxBuyer && (
            <div className="sandbox-login">
              PayPal sandbox buyer: <code>{config.sandboxBuyer.email}</code> / <code>{config.sandboxBuyer.password}</code>
            </div>
          )}
          {config.testCardEnabled && (
            <div>
              <button className="link" disabled={busy} onClick={payWithTestCard}>
                Development: pay with the sandbox test card
              </button>
            </div>
          )}
        </>
      ) : (
        <button className="primary" disabled={busy} onClick={() => run(() => api.accept(card.proposalId, customerId))}>
          Accept
        </button>
      )}
      <div className="card-actions">
        <button className="link muted" disabled={busy} onClick={cancel}>
          Cancel my request
        </button>
        <button className="link muted" onClick={() => setHidden(true)}>
          Not now
        </button>
      </div>
    </div>
  );
}

function PayPalCheckout({ card, customerId, onOutcome, disabled }: { card: CustomerCard; customerId: string; onOutcome: (o: Outcome) => void; disabled: boolean }) {
  const { loadingStatus, error } = usePayPal();
  if (loadingStatus === INSTANCE_LOADING_STATE.PENDING) return <div className="muted small">Loading PayPal…</div>;
  if (loadingStatus === INSTANCE_LOADING_STATE.REJECTED) return <div className="error small">PayPal failed to load: {error?.message}</div>;
  return (
    <div className={`paypal ${disabled ? 'disabled' : ''}`}>
      <PayPalOneTimePaymentButton
        presentationMode="popup"
        createOrder={async () => {
          const order = await api.order(card.proposalId, customerId);
          if (order.status !== 'ok' || !order.orderId) throw new Error(order.reason ?? order.error ?? 'could not start the payment');
          return { orderId: order.orderId };
        }}
        // Must return its promise, or the SDK finishes before the server does (spike gotcha 4).
        onApprove={async () => {
          onOutcome(await api.accept(card.proposalId, customerId));
        }}
        onCancel={() => onOutcome({ status: 'cancelled', reason: 'The PayPal window was closed; nothing was charged.' })}
        onError={(e: unknown) => onOutcome({ status: 'error', reason: `PayPal: ${(e as Error)?.message ?? 'something went wrong'}` })}
      />
    </div>
  );
}

function AffectedCard({ card, customerId, onOutcome }: CardProps) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<Outcome>) => {
    setBusy(true);
    try {
      onOutcome(await fn());
    } catch (e) {
      onOutcome({ status: 'error', reason: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card affected">
      <div className="card-head">Another customer's request affects your booking</div>
      {card.options.map((o) => (
        <div className="option" key={o.revisionId}>
          {o.option && <div className="option-label">Option {o.option}</div>}
          <Terms lines={o.lines} needsShop={o.needsShop} isAlternative={o.isAlternative} />
          <button className="primary" disabled={busy} onClick={() => run(() => api.pick(card.proposalId, o.revisionId, customerId))}>
            {o.option ? `Accept option ${o.option}` : 'Accept'}
          </button>
        </div>
      ))}
      <div className="option keep">
        <button disabled={busy} onClick={() => run(() => api.keep(card.proposalId, customerId))}>
          Keep my booking as is
        </button>
        <div className="muted small">Nothing about your booking changes.</div>
      </div>
    </div>
  );
}
