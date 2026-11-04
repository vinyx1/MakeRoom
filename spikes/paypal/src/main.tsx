import { createRoot } from 'react-dom/client';
import { useMemo, useState } from 'react';
import { PayPalOneTimePaymentButton, PayPalProvider, usePayPal, INSTANCE_LOADING_STATE } from '@paypal/react-paypal-js/sdk-v6';
import './app.css';

type Auth = { authId: string; status: string; amount: { value: string; currency_code: string }; expires: string };

async function api(method: string, path: string) {
  const res = await fetch(path, { method });
  const body = await res.json();
  if (!res.ok) throw new Error(`${body.error ?? res.status}: ${body.description ?? ''}`);
  return body;
}

// A mock of Vincent's approval card from Scenario 1: accept the extension and authorize $45.
function ApprovalCard() {
  const { loadingStatus, error } = usePayPal();
  const [log, setLog] = useState<string[]>([]);
  const [auth, setAuth] = useState<Auth | null>(null);
  const say = (line: string) => setLog(l => [...l, `${new Date().toLocaleTimeString()}  ${line}`]);

  const act = (verb: 'capture' | 'void') => async () => {
    try {
      const r = await api('POST', `/api/authorizations/${auth!.authId}/${verb}`);
      say(`${verb}: ${JSON.stringify(r)}`);
      const s = await api('GET', `/api/authorizations/${auth!.authId}`);
      setAuth(a => a && { ...a, status: s.status });
    } catch (e) { say(`${verb} failed: ${e}`); }
  };

  return (
    <div className="card" data-testid="card">
      <div className="card-head">Extension request</div>
      <div className="terms">
        <div><span>Booking</span><b>Sony A7 IV (A7IV-1)</b></div>
        <div><span>Return</span><b>Wed 6:00pm → Thu 10:00am</b></div>
        <div><span>Price</span><b>$45.00 for the extra day</b></div>
      </div>
      <p className="note">Your card is only authorized now. You're charged when the shop confirms; if it falls through, the hold is released.</p>

      {loadingStatus === INSTANCE_LOADING_STATE.PENDING && <div>Loading PayPal…</div>}
      {loadingStatus === INSTANCE_LOADING_STATE.REJECTED && <div className="err">PayPal failed to load: {error?.message}</div>}
      {loadingStatus === INSTANCE_LOADING_STATE.RESOLVED && !auth && (
        <PayPalOneTimePaymentButton
          presentationMode="popup"
          createOrder={async () => {
            const { orderId } = await api('POST', '/api/orders');
            say(`order created: ${orderId}`);
            return { orderId };
          }}
          onApprove={async ({ orderId }) => {
            say(`buyer approved ${orderId}; authorizing…`);
            const a = await api('POST', `/api/orders/${orderId}/authorize`);
            setAuth(a);
            say(`authorized: ${JSON.stringify(a)}`);
          }}
          onCancel={() => say('buyer closed the popup without approving')}
          onError={(e: unknown) => say(`error: ${JSON.stringify(e)}`)}
        />
      )}

      {auth && (
        <div className="auth" data-testid="auth">
          <div>Authorization <code>{auth.authId}</code>: <b data-testid="auth-status">{auth.status}</b>, {auth.amount.currency_code} {auth.amount.value}</div>
          <div className="small">Hold expires {new Date(auth.expires).toLocaleString()}</div>
          <div className="row">
            <button onClick={act('capture')} disabled={auth.status !== 'CREATED'}>Capture (shop confirms)</button>
            <button onClick={act('void')} disabled={auth.status !== 'CREATED'}>Void (falls through)</button>
          </div>
        </div>
      )}

      {log.length > 0 && <pre className="log" data-testid="log">{log.join('\n')}</pre>}
    </div>
  );
}

function App() {
  const clientId = useMemo(() => api('GET', '/api/config').then(c => c.clientId as string), []);
  return (
    <PayPalProvider clientId={clientId} environment="sandbox" components={['paypal-payments']} pageType="checkout">
      <main>
        <h1>PayPal spike</h1>
        <p className="small">Sandbox only. Log in to the popup with the sandbox <b>Personal</b> (buyer) account from Testing Tools → Sandbox Accounts.</p>
        <ApprovalCard />
      </main>
    </PayPalProvider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
