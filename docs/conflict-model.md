# Conflict model

How RentFlow turns any schedule change into a safe outcome. The invariants in `CLAUDE.md` are the guarantees; this file is the mechanism. Every path ends in one of: **committed** (everyone agreed, money moved), **rejected / expired / cancelled** (nothing changed, authorization voided), **failed** (nothing changed, capture refunded), or **escalated** (a person decides).

## Build tiers

The PoC builds everything here except the items below, which wait until the signature scenario and judge mode (`CLAUDE.md`) work. Each is tagged **Deferred** where it appears.

| Deferred | PoC stand-in |
|---|---|
| Fingerprints (§3a) | Re-run the validator against current state and the current time at every transition; that alone catches staleness |
| Payment outbox (§5) | Retry the PayPal call in place with the same `PayPal-Request-Id`; alert the owner after 3 failures |
| Waitlist (§6) | The agent tells the customer someone is mid-request and to try again in a few minutes |
| Overdue and no-show timers (§8) | Owner buttons: **Mark overdue**, **Mark no-show** |
| Full test suite (§10) | Golden scenarios from the demo seed, plus property tests for validator soundness and determinism |

## 1. Where proposals come from

| Source | Optimizer runs? |
|---|---|
| Customer request in chat | Only if the request conflicts. A request that fits still runs as a proposal whose only party is the requester: quote, authorize, capture, commit. |
| Owner drags a booking | No. A clean drag commits at once; a conflicting drag stays a red **draft** until the owner fixes it by hand, reverts, or clicks **Resolve with agent**. |
| Owner clicks **Resolve with agent** | Yes, on that conflict only. |
| Owner marks a unit unavailable, or a booking goes overdue | Yes, for the affected bookings. |
| Customer cancels, returns early, or no-shows | No. Freed capacity triggers waitlist processing (§6). |

The optimizer never runs in the background and never reshuffles the whole schedule.

Owner drafts are scratch work: they hold no claims, block nothing, and are revalidated when saved. An owner edit to another customer's confirmed booking needs that customer's approval, or the owner ticks "agreed by phone" (recorded as an owner-attested approval).

## 2. Optimizer

Pure function: `(schedule snapshot, request, facts, claims, exclusions) → ranked plans with prune reasons`.

Ranking, lexicographic:
1. Fewest confirmed bookings changed.
2. Least disruption size: total hours shifted across changed bookings, plus a fixed penalty per model change (default: 6 hours' worth).
3. Fewest customers whose approval is needed (same-model unit swaps count as zero; they need only a notice).
4. Least compensation.
5. Net revenue positive (plans below zero are dropped unless the owner asks).

Hard rules: shop hours for every pickup and return; no pickup or return in the past; buffers; resource calendars; picked-up rentals keep their unit and are never shortened (the owner may shorten one through a manual edit); claimed bookings and slots are fixed; customers who refused this conflict are excluded from changes needing approval; customer-stated constraints on this proposal (below); plans touching a unit with an open condition note are flagged for the owner. A plan depending on an `unknown` fact is marked **needs owner confirmation**, not infeasible.

Search scope: only bookings overlapping the conflict window ± 24h, on the requested model and its compatible substitutes. Nothing outside that neighbourhood moves.

**Customer-stated constraints.** When a customer states a limit in chat ("I leave for a shoot at noon", "I need the A7 IV, not the R"), the agent records it with a `record_constraint` tool as a structured constraint on the proposal (customer, kind, value, source message). The optimizer and validator treat it as a hard rule for the rest of that proposal. It is logged and shown on the owner's card.

The optimizer's constraint checker is also exported as a standalone pure **validator**: `(plan, current state, now) → valid | violations`. §3a uses it at every transition.

### Plausibility envelope

Deterministic sanity checks that run on every plan after the optimizer and on every revision. A plan outside the envelope goes to the owner as a review card and is never offered straight to a customer:

- no booking shifts by more than 6h;
- no model downgrade for any customer;
- compensation for the whole plan ≤ the revenue the requester's change brings in;
- at most 3 bookings touched;
- every price used is within the rate card's recorded min/max for that model (catches data-entry typos);
- a fallback that gives the requester something other than what they asked for is labelled **alternative** on the card.

Limits are config values; the owner card shows which check tripped.

## 3. Proposal state machine

```
                  counter or new plan → current revision SUPERSEDED, new revision at DRAFT
                ┌──────────────────────────────────────┐
                ▼                                      │
DRAFT ──valid──► AWAITING_APPROVALS ──all approved──► CAPTURING ──captured + revalidated──► COMMITTED
  │                 │        │        │                   │
  │ infeasible      │ reject │timeout │ owner override    │ capture fails / revalidation fails
  ▼                 ▼        ▼        ▼                   ▼
agent re-plans   REJECTED  EXPIRED  CANCELLED          FAILED
```

- Entering `AWAITING_APPROVALS` requires the requester's PayPal authorization (when the requester owes money) and successful claims. A plan with no money due skips authorization and capture. A `DRAFT` waiting on the requester's authorization expires after the approval timeout.
- `REJECTED`, `EXPIRED`, `CANCELLED`: void the authorization, release claims, roll back ghost events.
- `FAILED` before capture: void. After capture: refund the capture. Both through the outbox.
- The transition table lives in plain TypeScript in the backend; agent tools fire events (`approve`, `reject`, `counter`, `escalate`) and the table decides legality. One unit test per transition.

## 3a. Staleness

A plan depends on more than bookings, and time keeps moving while people decide. **Deferred:** fingerprints (step 1); the PoC runs steps 2–3 only. Every revision stores a **fingerprint**: the version of each booking it changes or relies on, each involved unit's resource calendar and condition notes, each fact used, the stored quote, and the shop-hours config.

At every transition (claim acquired, each approval recorded, capture, commit) the backend:

1. compares the fingerprint with current state;
2. runs the validator against current state and the current time, whether or not the fingerprint changed;
3. on any violation, does not take the transition: the optimizer re-plans as a new revision (re-approval rule applies) or, if nothing is feasible, the proposal goes to `EXPIRED` with the requester told why.

A changed fingerprint with a still-valid plan updates the fingerprint and continues. Stale assumptions never commit, including the passage of time: a plan whose 2pm pickup is approved at 2:30pm fails the validator.

Edits to non-booking inputs (resource calendars, condition notes, facts) on a claimed unit warn the owner the same way a drag on a claimed booking does (§6).

**Atomic check-and-write.** Validating and then writing in separate steps leaves a gap where another change can land (time-of-check to time-of-use). Every mutating request for a shop (owner edits, proposal transitions, commits, fact, calendar and condition-note edits, agent tool calls that write) runs in one transaction that first takes `pg_advisory_xact_lock(shop_id)`, then reads state, validates and writes. Writes within a shop are therefore serialized; the lock releases on commit or rollback. Shops are per visitor, so contention is negligible. At real multi-user scale this would become row-level locks.

PayPal capture is an external call and cannot sit inside the transaction:

1. In the lock: validate, set the proposal to `CAPTURING`. While `CAPTURING`, owner overrides on its claimed bookings are refused.
2. Outside the lock: capture the authorization.
3. In the lock: revalidate and apply. On failure, refund the capture.

The Bryntum client can be stale too: every owner edit carries the versions it was made against; on a mismatch the backend refuses it and SSE resyncs the view.

## 4. Revisions and approvals

- Revisions are immutable. A counter from any party, an owner modification, or a switch to another plan for the same request each create a new revision of the same proposal.
- An approval is a row `(proposal, revision, party, status)`: one per affected customer and the requester, plus the owner when an escalation trigger fires on that revision. Status: `pending / approved / rejected / countered`.
- **Re-approval rule**: after a new revision, a customer approves again only if their own booking or money changed; the backend decides by diffing the two revisions. The party who made a counter approves it by clicking **Send** on its card. Approvals carry over otherwise, including across a switch to another plan.
- **Owner sets the price** (built 2026-10-29, `ownerSetPrice`): before the requester has paid, the owner can lower what they pay. Each live option becomes a new revision (`origin: owner_modify`) with the owner's price as a discount; the old ones are superseded, an unpaid order for the old amount is voided, the requester accepts again, and the agent presents the new card. Raising a price, and repricing after the requester authorized (judge C4/C5), are not built yet.
- **Owner re-approval**: the owner approves again when the new revision trips an escalation trigger and differs from the revision the owner approved in any booking, price or compensation.
- **Options**: an offer to one party may present up to 2 plans as options, sibling revisions on one card. Claims cover every option's capacity. The party's pick supersedes the other options. An option that needs the owner is marked "needs shop confirmation"; the owner declining it drops only that option, and the agent re-offers the rest.
- **Withdrawal**: a party may withdraw an approval while the proposal is `AWAITING_APPROVALS`; for an affected party it counts as a refusal or a counter. When the **requester** withdraws, the proposal ends: `REJECTED`, authorization voided, claims released, and affected parties told their bookings stand. From `CAPTURING` on, approvals are final; after commit, the requester cancels under the normal refund policy (§6).
- Approving the same revision twice is a no-op, so double-clicks are harmless.
- Approvals are explicit clicks on an approval card bound to a revision id. So are refusals (**Keep my booking as is**), withdrawals and sending a counter. Chat text like "ok", "no" or "the owner said I get $100" records nothing; the agent responds by pointing to the card. Tools and buttons: `docs/agent-tools.md`.
- The card's contents (times, unit, model, price, compensation) are rendered by the backend from the revision, never from agent text. The agent discusses the offer around the card; the card is what a party agrees to, so a stale or invented claim in chat cannot become a commitment.
- Customers' acceptances are worded "pending shop confirmation" until the proposal commits.
- Limits: at most 3 revisions per proposal, then the agent escalates or closes. Each approval request times out after 30 min (configurable).
- One active proposal per requester per booking: a second request from Alice about the same booking is a counter on her proposal.

## 5. Money

**Principle: the requester's money backs the request; nobody is charged until everyone agrees.**

- The requester authorizes (`intent: AUTHORIZE`) before any affected party is contacted. A declined authorization stops the proposal before anyone else is bothered.
- On commit, capture the authorization. A revision that lowers the requester's price captures less than authorized; one that raises it needs the requester's re-approval and a fresh authorization replacing the old one.
- All bookings are prepaid in full at booking time, so compensation to an affected customer is a partial refund on their original capture, capped at what they paid. Non-cash compensation (an upgrade) is valued at the forgone price difference and counts toward the $50 cap.
- Quotes come from the `quote` tool: rate card, the agent's discount band (≤10%), compensation caps. Compensation rules (`server/src/quote/quote.ts`): an upgrade's price difference is value given up; a downgrade refunds the price difference plus $5 goodwill; a time shift refunds $3 per hour moved plus any rate-card saving; a same-model swap pays nothing. Both goodwill amounts are policy values. Each revision stores its quote, so a rate-card change mid-negotiation never changes agreed terms.
- Net revenue across the whole proposal must stay positive; the backend checks every revision.
- **Deferred** (PoC retries in place): captures, voids and refunds are outbox jobs written in the same DB transaction as the state change, executed after, retried with the same `PayPal-Request-Id`. Repeated failure alerts the owner; a committed schedule never waits on a refund.

## 6. Concurrency: claims and the waitlist

- Claims cover the bookings a revision changes and the slots it targets. Claims are acquired before any customer is contacted, so no offer is made on capacity someone else holds.
- **Claims follow revisions.** Each revision holds its own claims. A new revision (counter, fallback plan, owner change) is offered only after it acquires claims for any capacity it needs that the proposal doesn't already hold. In the same locked transaction, claims held only by superseded or dropped revisions are released. If the new claims fail because another proposal got there first, the revision is never offered: the optimizer re-plans around the other claim, and that counts as one of the fallback plans. A proposal's active claims are always the union of its live revisions' claims, so it never holds capacity it no longer needs.
- A second request touching claimed capacity: the optimizer plans around the claims. If nothing works, the customer joins a first-come waitlist (**Deferred**; the PoC says "try again in a few minutes") for that model and time ("someone is mid-request; I'll come back to you").
- When a proposal ends without committing, or capacity is freed by a cancellation, early return or no-show, the waitlist re-plans in order.
- **Owner wins**: dragging a claimed booking warns the owner; overriding sets the proposal `CANCELLED`, voids the authorization, and the agent tells everyone involved and re-plans the requester against the new schedule.
- **A customer may always cancel their own booking**, even if it is claimed. Refund policy: full refund 24h or more before pickup, 50% within 24h; the owner may override. The claiming proposal is superseded and re-planned, often into a simpler plan because the conflict is gone.

## 7. Disagreements

| Who | Says | Result | Next |
|---|---|---|---|
| Affected customer | Counter ("noon?") | If feasible, new revision; if infeasible, no revision | Re-ask whoever's terms changed; or explain and offer the nearest feasible option |
| Affected customer | Refusal ("no, as booked") | Their booking untouched; excluded from approval-needing changes for this conflict (notice-only swaps remain allowed) | Next-best plan as a new revision, up to 2 more plans, then "no, but here's what I can do" to the requester |
| Requester | Declines every alternative | `REJECTED`, authorization voided, original booking stands | Agent confirms the original terms in writing |
| Owner | Declines | `REJECTED` | Customers who said yes are told their booking stands; agent offers the requester an alternative |
| Owner | Modifies terms | New revision | Re-ask only the parties whose terms changed |
| Anyone | No answer | `EXPIRED` after the approval timeout | Requester told; nothing changed |
| Agent | Offers beyond its limits | Tool rejects, logged | Agent escalates |

The requester always gets the closest feasible alternative, never a bare denial.

**Built (2026-10-29, `affectedRefuse` / `planFallback` in `server/src/proposals/flow.ts`):** a refusal drops every live option that needs the refusing customer and records the exclusion. Fallback plans are offered only when the requester's terms are unchanged, so their approval and hold carry over; the closest alternative goes back to the requester as a `DRAFT` revision, is never priced above the authorized amount, and voids the hold immediately when it costs nothing. If neither exists the request is `REJECTED`. Customers who refused aren't messaged again when the request ends; they were told when they refused.

**Forced changes.** When a unit goes unavailable, a booking on it can't stay as it was, so "a rejection leaves the booking unchanged" has no valid meaning. Such bookings become **unassigned**: still confirmed for their model, with no unit, shown in an "Unassigned" row in Bryntum. The agent offers options as usual. If the customer refuses every option, the booking stays unassigned and the owner decides: cancel with a full refund, or source gear. The exclusion constraint applies only to assigned bookings.

**Owner priority.** The owner may decline any proposal; nothing commits, and conflicts left unresolved stay escalated until the owner acts.

**Handoff.** When the agent escalates because a customer is upset or asks for a person, the conversation is marked handed off. The agent stops messaging that customer and drafts replies for the owner instead, until the owner hands the conversation back.

## 8. Picked-up rentals and overdue returns

- A customer holding gear who declines an alternative keeps the original return time.
- **Deferred** timers below; in the PoC the owner clicks **Mark overdue** / **Mark no-show** and the same handling follows.
- At return time plus 1h grace, an unreturned booking becomes **overdue**: owner escalation, and the agent re-plans the next customer treating the late return as fixed. No automatic late fees or chasing in the PoC.
- No-show: at pickup time plus 1h grace, the owner is asked whether to release the unit.

**Built (2026-10-30, `markOverdue` / `markReturned` in `server/src/proposals/flow.ts`):** once a picked-up rental is past its return time, the Owner column shows it as **Due back**, with **Mark returned** and **Mark overdue…** (with the time the customer now expects to return). Overdue is planned as an extension that happens regardless (`forced`): the late customer isn't charged, there is no "closest alternative" for them, and the proposal has no requester. If nothing else is affected, the booking just runs later. Otherwise the next renters are re-planned; with nobody paying, any plan that compensates someone is outside the envelope, so the owner reviews it before the customer is asked. A refusal tries fallback plans as usual; if none is agreed, or nobody answers before the timeout, the owner gets a "late return" alert to sort it out with the next renter (cancel with a full refund, or find other gear). Marking it overdue again with a new time replaces the plan. **Mark returned** records the return now and ends any request planned around the rental. Not built: the automatic timers, late fees.

## 9. Time

All times stored in UTC, displayed and validated in the shop's time zone (DST-aware). Timeouts, grace periods and claim expiry read an injectable clock, so tests and the demo can jump ahead.

## 10. Testing the optimizer

Golden scenarios (the demo script's seed) prove the happy paths; these catch edge cases. **Deferred** except validator soundness and determinism:

- **Property tests** over randomly generated schedules (fast-check with Vitest): every returned plan passes the validator; picked-up rentals keep unit and end time; all times fall in shop hours and after `now`; every plan the envelope passes satisfies its limits.
- **Determinism**: same input gives the same output, including under shuffled input order.
- **Metamorphic tests**: adding a booking outside the search scope does not change the chosen plan; removing the conflict yields the zero-change plan; adding a customer constraint never yields a plan that breaks it.
- **Reference check**: on tiny schedules, an independent exhaustive enumerator confirms the chosen plan is the best under the ranking.
- **Staleness tests**: for each fingerprint input, mutate it between transitions and assert the proposal re-plans or expires; advance the injectable clock past a planned pickup and assert the validator rejects it.

## Open decisions

- Whether an extension of a picked-up rental always needs the owner. Current rule: only if it shortens or cancels a confirmed booking or trips another trigger.
- Approval timeout length for real use (30 min fits the demo).
