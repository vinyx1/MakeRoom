# PayPal spike: findings

PayPal REST (Orders v2 + Payments v2) in the sandbox, with the JS SDK **v6** button through `@paypal/react-paypal-js` 10.6 (`/sdk-v6` entry). Merchant and buyer sandbox accounts are both region **CA**. Run on 2026-10-26/27.

Files: `paypal.ts` is the REST client (the only file that holds the secret); `checks.ts` runs every check that needs no buyer (`npm run checks`); `server.ts` + `src/main.tsx` are the button flow (`npm run server` and `npm run dev` in two terminals, then http://localhost:5190). Credentials in `.env` (gitignored): `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`.

## Results

| # | Check | Result | How |
|---|---|---|---|
| 1 | Authorize without charging | **Yes** | Button → buyer approves in the popup → server `POST /v2/checkout/orders/{id}/authorize` → authorization `CREATED`, expires in 29 days. Done by hand with the sandbox Personal account. The buyer's sandbox activity page doesn't list the hold, only the later capture. |
| 2 | Capture later, less than authorized | **Yes** | `$45` hold, `$40` captured with `final_capture: true` → authorization `CAPTURED`. Capturing **more** than authorized works up to **115%** of the order; above that, `422 MAX_CAPTURE_AMOUNT_EXCEEDED`. |
| 3 | Void | **Yes** | Authorization → `VOIDED`. Capture after a void: `422 AUTHORIZATION_VOIDED`. Void again with a new request id: `422 PREVIOUSLY_VOIDED`. Verified by hand too. |
| 4 | Partial refund on an earlier capture | **Yes** | `$15` off a `$90` capture → refund `COMPLETED`, capture `PARTIALLY_REFUNDED`. Refunding more than is left: `422 REFUND_AMOUNT_EXCEEDED`. Refunding the rest → capture `REFUNDED`. |
| 5 | Idempotency (`PayPal-Request-Id`) | **Yes, with one trap** | Same id twice on capture, refund, void and button-order create → `201` then `200` with the **same** object; nothing happens twice. A double-click on Void in the button page replayed harmlessly (judge C3). **Trap:** same id with a **different amount** silently returns the first result (`$10` refund returned for a `$20` request). |
| 6 | Seed prepaid captures with no buyer click | **Yes** | Server-side card order: `payment_source.card` with a sandbox test card and `intent: CAPTURE` → captured immediately (`intent: AUTHORIZE` → authorization immediately). Vaulting also works: `attributes.vault.store_in_vault: ON_SUCCESS` → `VAULTED` with a vault id; a later order with `payment_source.card.vault_id` captures. Requires Advanced Card Payments and Vault, both on by default in this sandbox app. |
| 7 | Failures | **Yes** | `PayPal-Mock-Response: {"mock_application_codes": "<CODE>"}`. `INSTRUMENT_DECLINED` on order create → `422` (judge C2). `REFUND_FAILED_INSUFFICIENT_FUNDS` on refund → `422` (judge C6). `INTERNAL_SERVER_ERROR` on capture → `500`. |
| 8 | Status by polling | **Yes** | `GET` order / authorization / capture / refund all return current status. No webhooks needed. Never saw a `PENDING` refund (see Not covered). |
| 9 | Button inside a React card | **Yes** | v6 `PayPalProvider` (`environment="sandbox"`, client id fetched from the server) + `PayPalOneTimePaymentButton` with `presentationMode="popup"`, `createOrder` and `onApprove` calling our API. Closing the popup fires `onCancel` (judge C1). |
| 10 | Raise the price | **Yes** | Void the old authorization, authorize the new amount. Within 115% a single capture of the higher amount would also work, but the design asks for re-approval anyway (judge C4). |
| — | Currency | **USD and CAD both work** | The CA merchant receives USD converted to CAD (capture shows `exchange_rate` and `receivable_amount` in CAD), and the CA buyer paid ~CAD 64.86 for USD 45 after PayPal's conversion markup. |

## Gotchas (must carry into the real build)

1. **A request id belongs to exactly one amount.** PayPal does not compare the body on a replay, so reusing an id after an amount change returns the old result as a success and the new amount never happens. The design's `{proposal}:{revision}:{kind}:{customer}` is safe because revisions are immutable; never derive an id from anything that can change under it.
2. **Server-side card orders don't replay.** Repeating a card-funded `POST /v2/checkout/orders` with the same request id returns `422 TRANSACTION_REFUSED`, not the first order (button orders do replay). Nothing is charged twice, but the original order can't be recovered by retrying. Only seeding uses card orders: store the order id the moment it returns, and on doubt create a fresh one.
3. **The SDK is v6.** `@paypal/react-paypal-js` ≥ 10 documents v6 by default (`PayPalProvider`, `PayPalOneTimePaymentButton` from `/sdk-v6`). `environment` is required; the client id doesn't pick the environment. v5 (`PayPalScriptProvider`, `PayPalButtons`) still ships under a separate README.
4. **`onApprove` must return its promise** (await the authorize call) or the SDK finishes before the server does.
5. **The secret never leaves the server.** The page gets only the client id (public by design) from `/api/config`; every PayPal call goes through the backend.
6. **The developer dashboard's account balance is a setup value.** It stays at its initial number (CAD 5,000) and editing it didn't change the live balance on sandbox.paypal.com. Use sandbox.paypal.com, or Event Logs → API Calls, to see what happened.
7. **Mocked failures aren't remembered.** After a mocked refund failure, retrying with the same id succeeded. Whether a real failure is cached under its id is unknown, so the retry policy must also handle "same failure again".
8. **Fees and conversion show up in PayPal records.** A USD 45 capture had a USD 1.52 fee and converted to CAD for the merchant.

## Not covered (sandbox limits)

- **Pending refunds.** Every refund completed instantly. Treat `PENDING` as in progress and keep polling; fake it in a test.
- **Hold expiry and the honor period.** PayPal's clock can't be advanced. Irrelevant at a 30-minute approval timeout.
- **Rate limits** with many judges on one sandbox merchant at once.

## Design changes

- **Seeded prepayments are real sandbox captures**, made server-side with a sandbox test card when a shop is seeded. The simulated-capture fallback isn't needed; `paypal_orders.simulated` stays only as a safety valve if the sandbox misbehaves on demo day.
- **Price the demo in CAD.** Both sandbox accounts are Canadian, so CAD keeps every screen consistent (no USD 45 → CAD 64.86 surprises in PayPal's records). One config value; the spike used USD only because the demo script did.
- **Request id rule** (gotcha 1) added to `docs/data-model.md` (`payment_ops.request_id`).

Nothing else in the money design (`docs/conflict-model.md` §5) needs to change.
