// Minimal PayPal REST client for the spike. Sandbox only.

process.loadEnvFile(new URL('./.env', import.meta.url).pathname);

const BASE = 'https://api-m.sandbox.paypal.com';
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID!;
const SECRET = process.env.PAYPAL_CLIENT_SECRET!;
if (!CLIENT_ID || !SECRET) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing from .env');

export const clientId = CLIENT_ID;

let token: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`token: ${res.status} ${await res.text()}`);
  const body = await res.json();
  token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return token.value;
}

export type Result = { status: number; ok: boolean; body: any; debugId: string | null };

export type CallOptions = {
  requestId?: string; // PayPal-Request-Id: idempotency key
  mock?: string; // PayPal-Mock-Response application code, sandbox negative testing
  prefer?: 'return=minimal' | 'return=representation';
};

export async function call(method: string, path: string, body?: unknown, opts: CallOptions = {}): Promise<Result> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await accessToken()}`,
    'Content-Type': 'application/json',
    Prefer: opts.prefer ?? 'return=representation',
  };
  if (opts.requestId) headers['PayPal-Request-Id'] = opts.requestId;
  if (opts.mock) headers['PayPal-Mock-Response'] = JSON.stringify({ mock_application_codes: opts.mock });
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, ok: res.ok, body: text ? JSON.parse(text) : null, debugId: res.headers.get('paypal-debug-id') };
}

const money = (cents: number, currency: string) => ({ currency_code: currency, value: (cents / 100).toFixed(2) });

// Order for the JS SDK button: the buyer approves in the popup, then the server authorizes.
export const createOrder = (intent: 'AUTHORIZE' | 'CAPTURE', cents: number, currency: string, requestId?: string) =>
  call('POST', '/v2/checkout/orders', {
    intent,
    purchase_units: [{ reference_id: 'makeroom', description: 'MakeRoom spike', amount: money(cents, currency) }],
  }, { requestId });

// Server-side card order: no buyer click. PayPal authorizes or captures it immediately on create.
export const TEST_CARD = { number: '4111111111111111', expiry: '2030-12', security_code: '123', name: 'Bob Spike' };

export const createCardOrder = (
  intent: 'AUTHORIZE' | 'CAPTURE', cents: number, currency: string,
  opts: CallOptions & { vault?: boolean; vaultId?: string } = {},
) =>
  call('POST', '/v2/checkout/orders', {
    intent,
    purchase_units: [{ reference_id: 'makeroom', description: 'MakeRoom spike', amount: money(cents, currency) }],
    payment_source: {
      card: opts.vaultId
        ? { vault_id: opts.vaultId }
        : {
            ...TEST_CARD,
            ...(opts.vault ? { attributes: { vault: { store_in_vault: 'ON_SUCCESS' } } } : {}),
          },
    },
  }, opts);

export const authorizeOrder = (orderId: string, opts: CallOptions = {}) =>
  call('POST', `/v2/checkout/orders/${orderId}/authorize`, {}, opts);

export const captureAuthorization = (authId: string, cents: number | null, currency: string, opts: CallOptions & { final?: boolean } = {}) =>
  call('POST', `/v2/payments/authorizations/${authId}/capture`, {
    ...(cents === null ? {} : { amount: money(cents, currency) }),
    final_capture: opts.final ?? true,
  }, opts);

export const voidAuthorization = (authId: string, opts: CallOptions = {}) =>
  call('POST', `/v2/payments/authorizations/${authId}/void`, undefined, opts);

export const refundCapture = (captureId: string, cents: number, currency: string, opts: CallOptions = {}) =>
  call('POST', `/v2/payments/captures/${captureId}/refund`, { amount: money(cents, currency) }, opts);

export const getOrder = (id: string) => call('GET', `/v2/checkout/orders/${id}`);
export const getAuthorization = (id: string) => call('GET', `/v2/payments/authorizations/${id}`);
export const getCapture = (id: string) => call('GET', `/v2/payments/captures/${id}`);
export const getRefund = (id: string) => call('GET', `/v2/payments/refunds/${id}`);

// Pull the authorization or capture out of an order response.
export const authOf = (order: any) => order?.purchase_units?.[0]?.payments?.authorizations?.[0];
export const captureOf = (order: any) => order?.purchase_units?.[0]?.payments?.captures?.[0];
