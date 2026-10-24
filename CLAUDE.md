# RentFlow

An AI rental-operations agent for a small camera rental shop. It resolves scheduling conflicts by searching for feasible rearrangements, negotiating with affected customers, and coordinating PayPal payments before committing changes. Built for the PayPal AI Hackathon (Devpost), targeting **Best Use of Bryntum** and **Agentic Commerce / PayPal + AI**. Build window: ~20 days from 2026-10-23.

The signature scenario (Scenario 1) in `demo script.md` is the spec. Every feature exists to make that scenario run reliably on video; work outside it waits until it does.

**Before touching proposals, approvals, claims, payments, the optimizer, or any conflict handling, read `docs/conflict-model.md`.** It holds the state machine, the approval and money rules, and how each kind of disagreement resolves.

**Before writing schema, migrations, or queries, read `docs/data-model.md`.** It holds every table, the database constraints, and where each invariant lives.

**Before writing agent tools, prompts, or the tool loop, read `docs/agent-tools.md`.** It holds turn scopes, every tool's checks, and what no tool can do.

## Status

Planning → spikes. The stack below is the working choice; days 1–3 spikes (Bryntum render + event buffers, PayPal order → authorize → capture/void + partial refund on a prior capture, Claude tool loop) validate it before the data model is written on day 4. The PayPal spike must also answer how to seed prepaid sandbox captures for each visitor's shop without a buyer clicking through. Fallback: seeded bookings carry simulated captures, and refunds against them are simulated and labelled as such in the feed.

| Layer | Choice |
|---|---|
| Language | TypeScript end to end; shared types for bookings, proposals, tool schemas |
| Frontend | React + Vite, Bryntum Scheduler Pro (React wrapper, Bryntum npm registry) |
| Backend | Node + Fastify, SSE for live agent/schedule updates |
| Database | PostgreSQL + Drizzle |
| Agent | Anthropic TS SDK tool runner (`betaZodTool`), model `claude-opus-5-5` |
| Payments | PayPal Orders v2 with `intent: AUTHORIZE` + JS SDK buttons; capture or void the authorization, partial refunds on prepaid captures; sandbox only; poll status, no webhooks |
| Tests | Vitest |

## Vocabulary

- **Owner**: the shop running RentFlow; uses the dashboard. **Customer**: Alice, Bob, Charlie, etc.; talks to the agent by chat.
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

Bryntum must do real work, not just display a calendar: event buffers for turnaround, resource calendars for unavailability, ghost/preview events for proposals (applied and rolled back via state tracking), red drafts for owner edits that conflict, and a **Resolve with agent** action on each conflict. The backend stays the source of truth; Bryntum syncs from it.

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
