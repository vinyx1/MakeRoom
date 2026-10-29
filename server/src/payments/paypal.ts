// PayPal REST client (Orders v2 + Payments v2), sandbox only. The only module that holds the secret.
// Ported from spikes/paypal/paypal.ts; read spikes/paypal/FINDINGS.md before changing payment code.

import type { GatewayResult, PaymentGateway } from './gateway.ts';

const BASE = 'https://api-m.sandbox.paypal.com';

export type PayPalResult = { status: number; ok: boolean; body: any; debugId: string | null };

export type CallOptions = {
  /** PayPal-Request-Id. One id = one amount: PayPal replays the first result without comparing the body. */
  requestId?: string;
  /** PayPal-Mock-Response application code, for sandbox negative testing. */
  mock?: string;
};

export function createPayPalClient(clientId = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET) {
  if (!clientId || !secret) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set');
  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > Date.now() + 60_000) return token.value;
    const res = await fetch(`${BASE}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(`PayPal token: ${res.status} ${await res.text()}`);
    const body = await res.json();
    token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return token.value;
  }

  async function call(method: string, path: string, body?: unknown, opts: CallOptions = {}): Promise<PayPalResult> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };
    if (opts.requestId) headers['PayPal-Request-Id'] = opts.requestId;
    if (opts.mock) headers['PayPal-Mock-Response'] = JSON.stringify({ mock_application_codes: opts.mock });
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, ok: res.ok, body: text ? JSON.parse(text) : null, debugId: res.headers.get('paypal-debug-id') };
  }

  return { call };
}

export type PayPalClient = ReturnType<typeof createPayPalClient>;

/** PayPal's error name, e.g. `PREVIOUSLY_VOIDED`, from a 4xx body. */
const issueOf = (r: PayPalResult): string | undefined => r.body?.details?.[0]?.issue ?? r.body?.name;

const failure = (r: PayPalResult): GatewayResult => ({
  ok: false,
  error: `${r.status} ${issueOf(r) ?? 'error'}${r.debugId ? ` (debug id ${r.debugId})` : ''}`,
  // 4xx other than 429 is PayPal's final answer; 5xx, 429 and network errors are worth retrying.
  retryable: r.status >= 500 || r.status === 429,
});

export function payPalGateway(client: PayPalClient = createPayPalClient()): PaymentGateway {
  return {
    async voidAuthorization(authorizationId, requestId) {
      try {
        const r = await client.call('POST', `/v2/payments/authorizations/${authorizationId}/void`, undefined, { requestId });
        if (r.ok) return { ok: true, ref: r.body?.id ?? authorizationId };
        // Already voided under another request id: the outcome we wanted.
        if (issueOf(r) === 'PREVIOUSLY_VOIDED') return { ok: true, ref: authorizationId };
        return failure(r);
      } catch (e) {
        return { ok: false, error: String(e), retryable: true };
      }
    },
  };
}
