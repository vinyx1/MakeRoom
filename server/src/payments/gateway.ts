// What the backend needs from PayPal. The real client is ./paypal.ts; tests use a fake.
// Every call that moves money takes a PayPal-Request-Id; one id always means one amount.

export type GatewayFailure = {
  ok: false;
  error: string;
  /** false = PayPal answered with a final refusal; retrying with the same id won't change it. */
  retryable: boolean;
};

export type GatewayResult = { ok: true; ref: string | null } | GatewayFailure;

export type CreatedOrder =
  | {
      ok: true;
      orderId: string;
      /** Set when PayPal authorized or captured on create (server-side card orders, used for seeding). */
      authorizationId: string | null;
      captureId: string | null;
    }
  | GatewayFailure;

export type CreateOrderInput = {
  intent: 'AUTHORIZE' | 'CAPTURE';
  amountCents: number;
  requestId: string;
  description: string;
  /** Pay with the sandbox test card, no buyer click (seeded prepayments). Otherwise a buyer approves in the button. */
  testCard?: boolean;
};

export interface PaymentGateway {
  createOrder(input: CreateOrderInput): Promise<CreatedOrder>;
  /** After the buyer approved a button order. `ref` is the authorization id. */
  authorizeOrder(orderId: string, requestId: string): Promise<GatewayResult>;
  /** `ref` is the capture id. */
  captureAuthorization(authorizationId: string, amountCents: number, requestId: string): Promise<GatewayResult>;
  /** `ref` is the refund id. */
  refundCapture(captureId: string, amountCents: number, requestId: string): Promise<GatewayResult>;
  voidAuthorization(authorizationId: string, requestId: string): Promise<GatewayResult>;
}

export const CURRENCY = 'USD';
