// What the backend needs from PayPal. The real client is ./paypal.ts; tests use a fake.

export type GatewayResult =
  | { ok: true; ref: string | null }
  /** `retryable` false = PayPal answered with a final refusal; retrying with the same id won't change it. */
  | { ok: false; error: string; retryable: boolean };

export interface PaymentGateway {
  voidAuthorization(authorizationId: string, requestId: string): Promise<GatewayResult>;
}
