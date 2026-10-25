# PayPal spike: plan

Goal: confirm PayPal supports the money design in `docs/conflict-model.md` §5 (authorize first, capture only when everyone agrees, void if it falls through, partial refunds for affected customers). Sandbox only. Write results to `FINDINGS.md` here, like `spikes/bryntum/FINDINGS.md`.

## Checks

Critical:

1. **Authorize without charging**: JS SDK button → buyer approves in the popup → server authorizes the order (Orders v2, `intent: AUTHORIZE`) → authorization id.
2. **Capture later, including less than authorized** (judge C5).
3. **Void** an authorization (rejected, expired, cancelled proposals).
4. **Partial refund on an earlier capture**, and refunds can't exceed what was captured.
5. **Idempotency**: repeat a capture and a refund with the same `PayPal-Request-Id`; PayPal must return the first result, not act twice.
6. **Seeding prepaid captures with no buyer click** (each judge's shop needs Bob's etc. earlier payments): try a server-side sandbox card payment, then a vaulted/saved payment method. Fallback: simulated captures for seeded bookings, labelled in the feed.

Secondary:

7. **Failures**: a declined authorization (judge C2) and a failed refund (C6), using PayPal sandbox negative testing.
8. **Status polling without webhooks**: read order, authorization, capture and refund status, including refunds that stay pending.
9. **The button inside a React page**: renders, popup works, fits in an approval card.
10. **Raising the price** (judge C4): void the old authorization, create a larger one.

## Setup the user does

- PayPal developer account and a sandbox app (client id + secret). PayPal also creates a sandbox buyer account, used to click Pay.
- Secrets go in `spikes/paypal/.env` (gitignored), entered by the user, never pasted into chat.
- The user clicks Pay as the sandbox buyer for checks 1 and 9; the server automates the rest.
