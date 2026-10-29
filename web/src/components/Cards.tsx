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

  return (
    <div className="card requester">
      <div className="card-head">Your offer</div>
      <Terms lines={offer.lines} needsShop={offer.needsShop} isAlternative={offer.isAlternative} />
      {card.chargeCents > 0 ? (
        <>
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
      <div>
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
      <div className="muted small">Your payment is only held now ({usd(card.chargeCents)}), and charged when the shop confirms.</div>
    </div>
  );
}

function AffectedCard({ card, customerId, onOutcome }: CardProps) {
  const [busy, setBusy] = useState(false);
  const pick = async (revisionId: string) => {
    setBusy(true);
    try {
      onOutcome(await api.pick(card.proposalId, revisionId, customerId));
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
          <button className="primary" disabled={busy} onClick={() => pick(o.revisionId)}>
            {o.option ? `Accept option ${o.option}` : 'Accept'}
          </button>
        </div>
      ))}
      <div className="muted small">Want neither? Do nothing: your booking stays as it is.</div>
    </div>
  );
}
