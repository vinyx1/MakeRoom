# Spikes

Throwaway experiments that check a library or API can do what the design needs before the real build relies on it. Each folder has a `FINDINGS.md` with the results; read that first. The code here is not the app.

All need Node 24+ (the PayPal spike runs `.ts` files directly) and Google Chrome.

## Bryntum (`bryntum/`)

Does Bryntum Scheduler Pro do the schedule work: buffers, unavailable units, ghost events, red drafts, intercepted drags, live updates?

```sh
cd spikes/bryntum
npm install        # first time only; approve Bryntum's two postinstall scripts
npm run dev        # http://localhost:5180
```

Open http://localhost:5180. The header buttons show the Plan B ghosts, commit them or roll them back, try state tracking, and simulate a live update. Drag or resize a bar to send it through the fake backend; the log at the bottom shows its verdict.

**Automated check:** with `npm run dev` still running, open a second terminal and run `npm run check`. It drives headless Chrome through every question and prints JSON results, and writes screenshots to `/tmp`.

## PayPal (`paypal/`)

Does PayPal support the money design: authorize first, capture or void later, partial refunds, safe retries, and payments seeded without a buyer click?

**One-time setup**

1. On developer.paypal.com (Sandbox mode) → **Apps & Credentials**, open the app (the Default Application works) and copy its **Client ID** and **Secret**.
2. Create `spikes/paypal/.env` in your editor. It's gitignored; keep the exact name.
   ```
   PAYPAL_CLIENT_ID=...
   PAYPAL_CLIENT_SECRET=...
   ```
3. Note the buyer login: **Testing Tools → Sandbox Accounts** → the `@personal.example.com` account → ⋯ → **View/Edit account**.

```sh
cd spikes/paypal
npm install        # first time only
```

**Button flow (a person clicks):** run these in two terminals.

```sh
npm run server     # API on http://localhost:5191; holds the secret
npm run dev        # page on http://localhost:5190
```

Open http://localhost:5190 → **Pay with PayPal** → log in to the popup with the sandbox **Personal** account → approve. The card shows a `CREATED` hold for USD 45.00; **Capture** turns it into a charge, **Void** releases it. Reload the page to start again. Closing the popup without approving logs a cancel.

**Automated checks (no clicks):** `npm run checks`. It runs every check that needs no buyer, using a sandbox test card, and prints JSON results. Each run makes about 30 real sandbox payments and refunds, which show up in the business account's activity.

**Seeing what happened:** sandbox.paypal.com, logged in as the buyer or business sandbox account, shows payments and balances. developer.paypal.com → **Event Logs → API Calls** shows every request the server sent. The balance on the developer dashboard's account page doesn't update; ignore it.

## Agent tool loop (`agent/`)

Can Claude run MakeRoom's customer turns through typed tools: call the right ones, follow refusals, stay in scope, and never invent a price?

**One-time setup:** put an Anthropic API key in `spikes/agent/.env` as `ANTHROPIC_API_KEY=sk-ant-...` (gitignored). The key spends real money, but these runs cost fractions of a cent on Haiku.

```sh
cd spikes/agent
npm install          # first time only
npm run scenario     # Scenario 1 as three agent turns (Vincent asks, Bob is offered, Bob counters)
npm run evals        # 16 tricky prompts with automatic pass/fail checks
```

Both take a model name: `npm run scenario sonnet`, `npm run evals sonnet`. The default is `haiku` (cheapest). `npm run evals haiku judgment` runs only the judgment-heavy cases; `npm run evals haiku A1,A6` runs specific ones. Each run prints every tool call, the message the customer would see, time and cost, and saves the evals to `results/`.
