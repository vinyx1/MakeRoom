# MakeRoom

## How Bryntum is used

[Bryntum Scheduler Pro](https://bryntum.com/products/schedulerpro/) is the owner's live view of the shop, and its scheduling engine is a second opinion on every plan the optimizer proposes. The server stays the source of truth and never trusts the browser, so Bryntum never moves a real booking.

**The schedule** (`web/src/components/Schedule.tsx`)
- **Turnaround buffers** after each rental (event buffers) and **maintenance windows** (resource time ranges), shown in the shop's time zone whatever the browser's.
- **Ghost bookings** for every plan the assistant has proposed, so the owner sees the change before anyone agrees.
- **Red drafts** for owner edits that conflict, each with a **Resolve with agent** button.
- **Drag and resize held for the server:** an edit waits (async finalize) until the backend answers, then applies, becomes a draft, or is refused.
- **Ruled-out plans drawn on the schedule:** click one in the activity feed to see where it fails, with the booking it overlaps lit up.
- **A booking menu** (change times, delete, mark returned, mark overdue), a "Fully booked" summary row per day, and an Unassigned row.
- Every booking is `manuallyScheduled`, so the engine never repositions it.

**The scheduling engine** (`web/src/engine.ts`, shown by `web/src/components/EngineNote.tsx`)
- A separate, hidden Scheduler Pro project is built from the same bookings: each unit's bookings are chained with **finish-to-start dependencies** (the turnaround buffer inside each task), inside a **shop-hours calendar**, with **start-no-earlier-than constraints** and maintenance as fixed tasks.
- **Verify a plan:** if the engine has to move anything to make a plan's schedule hold, the plan has an overlap, a missed turnaround, a pickup outside shop hours or a booking in maintenance. The owner sees "Bryntum engine agrees" or "disagrees" on each card.
- **Solve the cascade:** apply only the late customer's extension and let the engine propagate it, to see which bookings it alone would slide and to when. For the main demo that is Bob's pickup to 2pm, the same answer as the optimizer's Plan B.
- It is read-only: built, committed, read and destroyed inside one call, never sent to the server and never drawn as a booking.

Bryntum is used under its free trial, installed from public npm (no Bryntum code is in this repo), so the trial watermark shows on the schedule.

## About

**When a rental runs late, make room.** MakeRoom is an AI agent for small rental shops. A customer asks to keep a rental longer, and MakeRoom finds which bookings can move, asks the customer affected, holds the late customer's payment with PayPal, and changes the schedule only once everyone agrees.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/).

- **Live demo:** https://make-room-for-it.up.railway.app (the app is at `/demo/`)
- **Payments run in the PayPal sandbox.** No real money moves. The sandbox buyer login for the PayPal popup is on the Devpost submission page.

## What it does

1. A customer chats with the shop's assistant: "Shoot ran over. Can I keep the camera until tomorrow at 10am?"
2. An optimizer searches the schedule for rearrangements that fit (another unit, a better model, a later pickup), ranks them by disruption, and keeps every plan it ruled out, with the reason.
3. The late customer approves a PayPal **authorization hold**. It is not a charge.
4. The affected customer is asked in plain language and can decline. Only a click on the offer card counts as a yes.
5. The owner approves anything outside the agent's limits.
6. When everyone agrees, the hold is captured, the bookings change in one transaction, and the affected customer is refunded the difference through PayPal. Any other outcome releases the hold.

The owner sees all of it on a live [Bryntum Scheduler Pro](https://bryntum.com/products/schedulerpro/) schedule: turnaround buffers, maintenance windows, proposed plans as ghost bookings, red drafts for conflicting owner edits, and an activity feed of every step.

## How it works

**Claude proposes, code decides.**

- **AI (Claude):** talks to customers and calls typed tools that check the schedule. It cannot set a price, record an approval, change a booking or move money. A check blocks any dollar amount in a message that didn't come from the shop's quote.
- **Optimizer:** plain deterministic code (`server/src/optimizer/`), no AI. Iterative deepening over up to 3 moved bookings, ranked by fewest bookings changed, then disruption hours, then approvals needed.
- **PayPal:** Orders v2 with `intent: AUTHORIZE` and the JS SDK v6 button. The hold is captured only when everyone has agreed; every other exit voids it. Calls are idempotent (`PayPal-Request-Id`) and retried.
- **Safety:** every change for a shop runs under a per-shop lock and is re-validated against the current schedule and time before it applies. Postgres itself refuses overlapping bookings (an exclusion constraint that includes the turnaround buffer).
- **Bryntum:** draws the schedule. Bookings are pinned (`manuallyScheduled`), so the browser never moves one. Scheduler Pro's scheduling engine runs in a separate, read-only project as an independent cross-check on each plan (`web/src/engine.ts`).

More detail: [`docs/conflict-model.md`](docs/conflict-model.md) (states, approvals, money rules), [`docs/data-model.md`](docs/data-model.md) (tables and constraints), [`docs/agent-tools.md`](docs/agent-tools.md) (what the agent can and can't do), [`demo script.md`](demo%20script.md) (the demo scenarios).

## Stack

TypeScript throughout. React and Vite, Bryntum Scheduler Pro (free trial from public npm), Fastify with server-sent events, PostgreSQL with Drizzle, the Anthropic SDK (default model `claude-sonnet-5-5`), PayPal Orders v2 (sandbox), Vitest.

## Run it locally

You need Node 24, Docker, and a PayPal **sandbox** app (developer.paypal.com, Apps & Credentials, Sandbox). The server won't start without its `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`. An Anthropic API key is optional: without `ANTHROPIC_API_KEY` the assistant sends a fixed template reply instead of using Claude. `PAYPAL_SANDBOX_BUYER_EMAIL` and `_PASSWORD` are only used to show the buyer login to your testers.

```bash
docker compose up -d                  # Postgres
cd server
cp .env.example .env                  # fill in the PayPal, sandbox buyer and Anthropic values
npm install
npm run db:migrate
npm run dev                           # API on http://localhost:3000
```

In a second terminal:

```bash
cd web
npm install
npm run dev                           # http://localhost:5177  (the app is at /demo/)
```

`./start.sh` does all of this in one go. Run it with `--test-card` to pay with the sandbox test card instead of the PayPal popup (development only; it is off in production).

Each visitor gets their own freshly seeded shop, and the demo story starts from today's date. **Reset demo** starts it over.

## Tests

```bash
cd server
npm test                              # needs the Postgres container; PayPal is faked, and a few tests also hit the real sandbox when PAYPAL_CLIENT_ID is set
npm run eval:chat                     # 26 tricky chat prompts against a running server (see evals/chat-prompts.md)
npm run smoke -- <url>                # checks a deployed copy
```

## Repository layout

| Path | What's in it |
|---|---|
| `server/src/optimizer/` | The pure, deterministic scheduling search and validator |
| `server/src/proposals/` | The state machine: requests, approvals, claims, commit |
| `server/src/payments/` | PayPal authorize, capture, void and refund, with retries |
| `server/src/agent/` | Claude's typed tools, the turn loop and the money check |
| `server/src/server/` | Fastify routes and the views the frontend reads |
| `web/src/` | The React app, the Bryntum schedule and the engine cross-check |
| `evals/` | Judge scenarios and the chat prompt set |
| `spikes/` | The early experiments for Bryntum, PayPal and the agent loop |

## Notes

- PayPal, Bryntum and Claude are trademarks of their owners. This project is not affiliated with them.
- Bryntum Scheduler Pro is used under its free trial, so the trial watermark shows on the schedule.
- Not built: a unit going down (marking equipment unavailable mid-rental), the angry-customer handoff, a customer cancelling their own booking, and repricing after the hold is placed. See [`TODO.md`](TODO.md).

## License

[MIT](LICENSE)
