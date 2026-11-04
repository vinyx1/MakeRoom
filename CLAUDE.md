# MakeRoom

An AI rental-operations agent for a small camera rental shop. It resolves scheduling conflicts by searching for feasible rearrangements, negotiating with affected customers, and coordinating PayPal payments before committing changes. Built for the PayPal AI Hackathon (Devpost), targeting **Best Use of Bryntum** and **Agentic Commerce / PayPal + AI**. Build window: ~20 days from 2026-10-23.

The signature scenario (Scenario 1) in `demo script.md` is the spec. Every feature exists to make that scenario run reliably on video; work outside it waits until it does.

**Before touching proposals, approvals, claims, payments, the optimizer, or any conflict handling, read `docs/conflict-model.md`.** It holds the state machine, the approval and money rules, and how each kind of disagreement resolves.

**Before writing schema, migrations, or queries, read `docs/data-model.md`.** It holds every table, the database constraints, and where each invariant lives.

**Before writing agent tools, prompts, or the tool loop, read `docs/agent-tools.md`.** It holds turn scopes, every tool's checks, and what no tool can do.

## Status

Planning → spikes. Bryntum spike done: all 9 questions pass; read `spikes/bryntum/FINDINGS.md` before writing any Bryntum code. PayPal spike done: all 10 checks pass; read `spikes/paypal/FINDINGS.md` before writing any payment code. Agent tool-loop spike done: Scenario 1 turns and 16/16 trick prompts pass on Haiku 5.5, 9/9 judgment cases on Sonnet 5.5; read `spikes/agent/FINDINGS.md` before writing agent tools or prompts. Data model done: schema, migrations and the demo seed are in `server/` (run `docker compose up -d`, then `npm test` in `server/`); prepayments aren't seeded yet, as they need the payments module. Optimizer and validator started in `server/src/optimizer/` (pure; tests in `server/test/optimizer.test.ts`): Scenarios 1–3 plan correctly. Still missing: placing unassigned bookings (Scenario 4), money checks and compensation ranking (need the quote module), nearest alternatives for non-extensions. Scenario 6 backend done: `server/src/owner/edit-booking.ts` (owner edit, claim warning, override → `CANCELLED` + void + re-plan), the proposal transition table (`server/src/proposals/state-machine.ts`), PayPal void with retries (`server/src/payments/`), tested against the sandbox. Not yet: telling customers (needs the agent), the HTTP route and the Bryntum warning. Quote module done (`server/src/quote/quote.ts`): every optimizer plan carries its quote, the money checks, and ranking rules 4–5. Scenario 1 proposal flow done (`server/src/proposals/flow.ts`): request → options → authorize → claims → affected pick → owner approval → capture → revalidate → commit → refund, plus owner decline (B8/B9), expiry, capture failure, revalidation failure and claim races; tested against the real sandbox. Not yet: refusals and fallback plans (Scenario 3), counters, withdrawal. Fastify server done (`server/src/server/`): one seeded, prepaid shop per session cookie; owner and customer views with backend-rendered cards; routes for every action; SSE activity stream; reset and fast-forward; expiry sweep. Run: `docker compose up -d`, then in `server/`: `npm run db:migrate`, `npm run dev` (port 3000). A first visit takes ~4s (7 real sandbox captures). Agent done (`server/src/agent/`): customer-scope tools over the real backend (all of `docs/agent-tools.md` §3 except `record_constraint`), the turn loop with the money lint, one nudge and template fallbacks, a per-shop turn cap (`AGENT_TURN_CAP`, default 60), and a dispatcher that turns `offer_ready` / `proposal_update` / `proposal_ended` activity into turns. Chat: `POST /api/customers/:id/messages` (202; replies arrive over SSE). Model: Claude Sonnet 5.5 for the live demo (decided 2026-10-29; Opus 5.5 measured ~11s and ~$0.04/turn, Haiku 5.5 ~4s and ~$0.001/turn). Live Scenario 1 through chat passes on Haiku. Scenario 2 backend done: Resolve with agent on a red draft (`resolveDraft`, owner-attested requester), owner review while the plan is a draft, fact answers on the owner card (a No declines, judge D8), Save as fact (`server/src/owner/facts.ts`), then the requester's payment card and the usual offers. Scenario 6 now re-plans the requester into a fresh offer after an override. Backend for the video cut (Scenarios 1, 2, 6) is complete, and Scenario 3 since; Scenarios 4–5 are not. Not yet: owner-assist turns. Terminal tester: `npm run dev:test-card` (server; the sandbox test card replaces the PayPal popup, never in production), then `npm run try` in `server/` (`help` lists commands and the Scenario 1, 2, 6 walkthroughs). Agent turns from activity events are claimed once per event (`agent_dispatches`), so several server processes on one database don't double messages. Judge mode: auto-reply customers (`POST /api/demo/auto-reply`; a scripted affected customer answers their offer after the agent's message, Plan B when there are two) and the sandbox buyer login in `GET /api/config` (`PAYPAL_SANDBOX_BUYER_EMAIL` / `_PASSWORD`). Still to do before submission: deployment, and the `evals/chat-prompts.md` set. Frontend started (`web/`, `npm run dev` on :5177, proxies /api to :3000): schedule on top (Bryntum in shop time zone, ghosts, red drafts, drag/resize with "agreed by phone" and override), owner column (cards, fact Yes/No, Save as fact, activity feed), two chat panes with cards and the PayPal button. Scenarios 1, 2 and 6 pass end to end through the UI in headless Chrome (browser time zones Berlin, New York), with the live agent and sandbox payments. Owner "Adjust price" on pending requests (lower the requester's price before they pay; `POST /api/proposals/:id/price`). Scenario 3 done (2026-10-29): **Keep my booking as is** (`affectedRefuse`, `POST /api/proposals/:id/keep`; also withdraws an earlier pick, judge B5) excludes the customer and drops their options; the backend re-plans (`planFallback`): up to 2 fallback plans with the requester's terms unchanged (approval and hold carry over), then the closest alternative back to the requester (hold voided at once when it costs nothing; never more than they authorized), else `REJECTED`. The requester can **Cancel my request** any time before capture (`requesterCancel`). Tested in `server/test/scenario3.test.ts` and through the UI with the live agent. Not built from the demo script's Scenario 3: `record_constraint` (Bob's stated limits; a refusal already excludes him). Tester: `keep`, `cancel`. **What's left, prioritized: `TODO.md`** (next: deployment and public-URL protection, then the UI revamp). The stack below is the working choice; days 1–3 spikes (Bryntum render + event buffers, PayPal order → authorize → capture/void + partial refund on a prior capture, Claude tool loop) validate it before the data model is written on day 4. Seeded prepayments are real sandbox captures, made server-side with a sandbox test card when a shop is seeded, so refunds against them are real sandbox refunds.

| Layer | Choice |
|---|---|
| Language | TypeScript end to end; shared types for bookings, proposals, tool schemas |
| Frontend | React + Vite, Bryntum Scheduler Pro (React wrapper, Bryntum npm registry) |
| Backend | Node + Fastify, SSE for live agent/schedule updates |
| Database | PostgreSQL + Drizzle |
| Agent | Anthropic TS SDK tool runner (`betaZodTool`), model `claude-sonnet-5-5` (`AGENT_MODEL` overrides; Haiku 5.5 for development and evals) |
| Payments | PayPal Orders v2 with `intent: AUTHORIZE` + JS SDK v6 buttons (`@paypal/react-paypal-js/sdk-v6`); capture or void the authorization, partial refunds on prepaid captures; sandbox only; poll status, no webhooks |
| Tests | Vitest |

## Vocabulary

- **Owner**: the shop running MakeRoom; uses the dashboard. **Customer**: Alice, Bob, Charlie, etc.; talks to the agent by chat.
- **Model** vs **unit**: customers book a model (Sony A7 IV); the system assigns a unit (A7IV-1). Same-model unit swaps need no approval, only a notice. One unit per booking.
- **Proposal**: any change to the schedule, from any source (customer request, owner edit, agent resolution). Made of immutable **revisions**; a change to terms creates a new revision.
- **Requester** vs **affected party**: the requester wants the change; affected parties are customers whose bookings the plan changes.
- **Approval**: an explicit click on a specific revision by a party, recorded in the DB.
- **Claim**: an active proposal's lock on the bookings and slots it touches.
- **Buffer**: turnaround after a rental on a unit, default 4h, stored per booking (Bryntum event buffer; also enforced by the optimizer and the exclusion constraint).
- **Shop hours**: 9am–9pm daily. Pickups and returns happen only within them.
- **Fact**: an equipment attribute with three values: `yes`, `no`, `unknown`.
- **Escalation**: the agent handing a decision or question to the owner via an approval card.

## Invariants

These hold in code, enforced by the backend, regardless of what the agent says:

1. **Claude proposes, deterministic code decides.** The agent acts only through typed tools; every tool validates its input against current state. The agent has no direct DB or PayPal access.
2. **The optimizer is pure and deterministic**: no LLM calls, no I/O beyond its inputs, fully unit-tested. Brute-force search is fine at this inventory size.
3. **Confirmed bookings change only with the customer's recorded approval**: a click on that exact revision, or an owner-attested "agreed by phone". The agent never records an approval from chat text. A rejection leaves the booking exactly as it was. Picked-up rentals never change unit, and only the owner can shorten one.
4. **Commit sequence**: requester authorizes payment → claims placed → approvals recorded → authorization captured → plan revalidated → all changes applied in one DB transaction, which also enqueues refunds → refunds run. Every exit before capture voids the authorization; a failure after capture refunds it.
5. **No transition on stale assumptions**: every write for a shop takes a per-shop lock, then validates against current state and the current time, then writes, all in one transaction.
6. **Plans outside the plausibility envelope go to the owner**, never straight to a customer.
7. **Double-booking is impossible at the DB level**: Postgres exclusion constraint on `(unit_id, [start, end + buffer))`.
8. **A booking belongs to at most one active proposal**, enforced by claims acquired with a version check.
9. **Every PayPal call is idempotent and retried**: a `PayPal-Request-Id` derived from proposal, revision and step; a failed capture, void or refund is retried with the same id and alerts the owner on repeated failure.
10. **Prices and compensation come from tools** (rate card, discount band, caps), never from the agent's own arithmetic. Each revision stores its quote.
11. **The agent states equipment facts only from the database.** An `unknown` fact becomes an owner question, and in the optimizer it marks a plan as "needs owner confirmation" rather than infeasible.
12. **Everything is logged** (tool calls, alternatives with prune reasons, revisions, claims, approvals, constraints learned, payments) and shown in the owner's activity feed.

## Agent autonomy

The agent talks to customers directly as the shop's AI assistant and acts alone within limits. It escalates to the owner when:

- compensation exceeds $50 per customer, a discount exceeds 10%, a refund is outside policy, or net revenue would be negative;
- a confirmed booking would be cancelled or shortened, or a plan changes 3+ bookings;
- a needed equipment fact is `unknown`, or a unit has an open condition note;
- the customer is upset, reports damage or a dispute, is owner-flagged, or asks for a person;
- the request stays ambiguous after one clarifying question.

Money, booking-state and condition triggers are checked by the backend; the judgment triggers go through an `escalate_to_owner` tool. When the owner answers a fact question, the agent offers to save it as a fact so the question isn't asked again.
## Bryntum's role

Bryntum must do real work, not just display a calendar: event buffers for turnaround, resource time ranges for unavailability (bookings are `manuallyScheduled`, so Bryntum never moves them), ghost/preview events for proposals (applied and rolled back via state tracking), red drafts for owner edits that conflict, and a **Resolve with agent** action on each conflict. The backend stays the source of truth; Bryntum syncs from it. Set `manuallyScheduled: true` in the one function that maps bookings to Bryntum events, and in dev mode log loudly if a Bryntum event's times ever differ from the server's.

### If time permits (after Scenario 1 works)

Optional Bryntum depth, all read-only views over backend data, behind a toggle, dropped if unreliable. None of it may change a booking or turn the engine on for real bookings.

- **Play rejected alternatives on the schedule:** clicking a pruned alternative in the feed shows it as ghosts with the broken rule lit up (the overlapping buffer, the maintenance block). Cheap if the optimizer's pruned alternatives are stored as structured data (proposed changes, rule broken, conflicting booking), not just a sentence.
- **Resource utilization view** under the schedule (native Scheduler Pro widget): per-unit load and revenue, before and after a plan.
- **Planned vs actual** for extensions and late returns, instead of hand-made ghost styling.
- **Engine what-if:** a separate read-only scheduler instance where the Scheduler Pro engine computes load or conflicts for a proposed plan; the backend keeps the final say.

## Judge mode

Judges may try the live deployment, often several at once and alone. These are build requirements, not polish:

- **One shop per visitor.** Every table carries `shop_id` from the day-4 data model; a new visitor gets a freshly seeded shop from the demo script's seed. The shop comes from the session cookie, never the URL. A **Reset demo** button voids the shop's open authorizations, then reseeds it.
- **Role switcher.** One judge plays the owner, Alice and Bob: a switcher, or a three-pane view (owner dashboard + two customer chats).
- **Auto-reply customers.** A toggle that lets a scripted customer answer affected-party requests, so a judge acting as the requester sees the negotiation play out.
- **Fast-forward.** A demo-clock button that jumps ahead, driving the injectable clock, so timeouts and expiry are visible in seconds.
- **PayPal sandbox credentials** shown beside the PayPal button.
- **Live activity feed.** Stream agent steps over SSE while a tool loop runs, so a 10–30s turn never looks frozen.
- **Usage cap per session** on agent turns, to bound API cost on a public URL.
- **Tricky-prompt eval set** in `evals/chat-prompts.md`: ~25 messages a judge might type (vague dates like "next weekend", "make it free", gear the shop doesn't carry, two changes in one message, jailbreak attempts, off-topic). Run it every few days and fix the agent's replies.
- **Judge scenarios** in `evals/judge-scenarios.md`: multi-step things a judge might try, each with the expected outcome and the rule that produces it. Each one becomes an integration test.

## Out of scope

Multi-business marketplace, storefront, shipping, damage claims, late fees, identity verification, external rental platforms, auth beyond a demo login, multi-item kits, after-hours returns, constraint-solver libraries, agent frameworks.
