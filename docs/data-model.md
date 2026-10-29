# Data model

The tables RentFlow stores, how they link, and where each rule from `CLAUDE.md` and `docs/conflict-model.md` lives. Implemented in `server/src/db/schema.ts` (Drizzle) and `server/drizzle/0001_constraints.sql` and `0003_immutable_revisions.sql` (exclusion constraints and triggers, which Drizzle can't express); `server/test/db.test.ts` checks each database guarantee below.

Conventions for every table:

- `id uuid` primary key, `shop_id uuid` foreign key to `shops` (one shop per visitor; every query filters by it).
- Times are `timestamptz` (UTC). The shop's time zone is used only for display and for shop-hours checks.
- Tables the owner or agent can edit concurrently carry `version int`, bumped on every update. Owner edits and revisions record the versions they were made against.
- Money is integer cents (`*_cents`), one currency per shop.
- Event times (`created_at`, `at`, `requested_at`, …) are on the **shop clock** (server now + `clock_offset_ms`) and passed by the app, never defaulted by the database, so the feed and timeouts follow fast-forward.

Postgres extension needed: `btree_gist` (exclusion constraints mixing `=` / `<>` with range overlap).

## 1. Shop and policy

### `shops`

| Column | Notes |
|---|---|
| `name`, `timezone` | e.g. `America/Los_Angeles` |
| `opens_at`, `closes_at` | `time`, shop hours (9:00, 21:00) |
| `clock_offset_ms` | Injectable clock: shop "now" = server now + offset. Fast-forward adds to it; seeding sets it so now = Wed 2pm. |
| `policy jsonb` | All tunable limits, validated by a Zod schema: `default_buffer_minutes` (240), `approval_timeout_minutes` (30), `discount_band_pct` (10), `compensation_cap_cents` (5000), `shift_compensation_cents_per_hour` (300), `downgrade_goodwill_cents` (500), `max_shift_hours` (6), `max_bookings_touched` (3), `search_window_hours` (24), `model_change_penalty_hours` (6), `max_revisions` (3), `max_fallback_plans` (2), `grace_minutes` (60), `cancel_full_refund_hours` (24), `cancel_late_refund_pct` (50), `payment_retry_limit` (3) |
| `agent_turns_used` | Judge-mode usage cap counter |
| `session_key` | Hash of the visitor's session cookie; the shop is looked up by this, never by URL |

The owner is implicit: one per shop, acting through the dashboard. No owner table.

## 2. Inventory

### `equipment_models`

| Column | Notes |
|---|---|
| `name` | "Sony A7 IV" |
| `category` | `camera_body`, `gimbal`, … |
| `tier int` | Rank within category. A move to a lower tier is a **downgrade** (envelope), a higher tier an **upgrade**. |
| `daily_rate_cents` | Rate card. Billing is per started 24h. |
| `rate_min_cents`, `rate_max_cents` | Plausibility bounds on the rate (catches typos) |

### `model_substitutes`

`(model_id, substitute_model_id)`, same category only. Defines the optimizer's search scope: the requested model plus its substitutes. Seed: A7 IV ↔ A7R V, RS3 ↔ Crane 4.

### `units`

| Column | Notes |
|---|---|
| `model_id` | |
| `label` | "A7IV-1" |
| `active bool` | |

### `unit_unavailability` (resource calendars)

| Column | Notes |
|---|---|
| `unit_id`, `period tstzrange` | |
| `reason` | `maintenance`, `out_of_service` |
| `version` | |

Bookings and unavailability are separate tables, so the database can't exclude one against the other; the validator checks it inside the per-shop lock.

### `condition_notes`

`unit_id`, `body`, `opened_at`, `resolved_at`, `version`. An open note (resolved_at null) on a unit in a plan is an owner trigger.

### `facts`

| Column | Notes |
|---|---|
| `unit_id` or `model_id` | Exactly one set (CHECK). Seed: `CRANE4-1` |
| `key` | `balances_r5_rf2470` |
| `label` | How the owner's card asks about it: "Balances a Canon R5 + RF 24-70" (for an agent-raised question, the customer's question) |
| `value` | enum `yes`, `no`, `unknown` |
| `source` | `seed`, `owner`, or `agent` (a question the agent raised, still `unknown`); plus `set_at`, `escalation_id` that answered it. Only the owner's "Save as fact" sets a value |
| `version` | |

Unique `(shop_id, unit_id, model_id, key)` `NULLS NOT DISTINCT` (one of the two ids is always null, which would otherwise defeat it). The agent's fact tool reads only this table.

## 3. Customers and bookings

### `customers`

`name`, `email`, `flagged bool` (owner-flagged is an escalation trigger).

### `bookings`

| Column | Notes |
|---|---|
| `customer_id`, `model_id` | The customer books a model |
| `unit_id` | **Nullable.** Null = **unassigned** (forced change, §7) |
| `starts_at`, `ends_at` | Pickup and return |
| `buffer_ends_at` | `ends_at` + this booking's buffer, written by the app; CHECK `buffer_ends_at >= ends_at` |
| `status` | `confirmed`, `picked_up`, `returned`, `cancelled`, `no_show` |
| `overdue_marked_at`, `no_show_marked_at` | Owner buttons (timers deferred) |
| `price_cents` | What the booking cost |
| `prepaid_order_id` | → `paypal_orders`; the capture refunds are issued against |
| `note` | "for Canon R5 + RF 24-70" |
| `required_facts text[]` | Fact keys any unit this booking moves to must satisfy (Eve: `balances_r5_rf2470`). `no` rules the unit out; `unknown` makes the plan need owner confirmation. Seeded from the note; how a new booking gets them is still open |
| `version` | |

**Exclusion constraint** (invariant 7):

```sql
EXCLUDE USING gist (unit_id WITH =, tstzrange(starts_at, buffer_ends_at) WITH &&)
  WHERE (unit_id IS NOT NULL AND status IN ('confirmed', 'picked_up'))
  DEFERRABLE INITIALLY DEFERRED
```

Gotcha: the constraint must be **deferred** to commit time. A plan applies several booking updates in one transaction, and in between them the schedule can overlap. In Scenario 1, Alice's extension lands before Bob's later start, and a swap of two bookings always overlaps midway. Ranges are half-open `[start, end)`, so a booking may start exactly when the previous buffer ends.

Gotcha: `buffer_ends_at` is stored, not generated, because `timestamptz + interval` is not immutable in Postgres and can't be used in a generated column or constraint expression.

**Trigger backstop** for invariant 3: reject an update where `OLD.status = 'picked_up'` and `unit_id` changes, or `ends_at` moves earlier without an owner-sourced change. "Owner-sourced" is a transaction-local setting, `rentflow.owner_shorten = on`, set by `allowOwnerShorten` in `server/src/db/lock.ts`. The validator enforces this first; the trigger catches bugs.

## 4. Proposals

### `proposals`

| Column | Notes |
|---|---|
| `source` | `customer_request`, `owner_edit`, `owner_resolve`, `unit_down`, `overdue`, `customer_cancel` |
| `requester_customer_id` | Null when the owner or system initiates with no paying requester |
| `subject_booking_id` | The booking the request is about (Alice's), if any |
| `request jsonb` | What was asked, as structured data ("extend booking X to Thu 10:00") |
| `state` | `DRAFT`, `AWAITING_APPROVALS`, `CAPTURING`, `COMMITTED`, `REJECTED`, `EXPIRED`, `CANCELLED`, `FAILED` |
| `revision_seq int` | Last revision number used; capped by `policy.max_revisions` |
| `fallback_plans_used int` | Capped by `policy.max_fallback_plans` |
| `expires_at` | Current timeout (approval or authorization) |
| `ended_reason` | Free text shown in the feed |
| `version` | |

Unique partial index: one active proposal per requester per booking —
`(requester_customer_id, subject_booking_id) WHERE state IN ('DRAFT','AWAITING_APPROVALS','CAPTURING')`.

### `revisions`

Immutable once created, apart from `status`, `validated_at` and `fingerprint`; a trigger refuses any other update, and any update to `revision_changes`.

| Column | Notes |
|---|---|
| `proposal_id`, `seq int` | Revision number. Options share a `seq`. |
| `option_label` | Null, or `A` / `B` when offered as options on one card |
| `parent_revision_id` | The revision this one replaced (for diffing) |
| `status` | `draft`, `offered`, `selected`, `superseded`, `dropped` |
| `origin` | `optimizer`, `counter`, `owner_modify`, `fallback`, `alternative` |
| `created_by`, `created_by_customer_id` | `agent`, `owner` or `customer`; the customer id is set only for `customer` (the counter's author) |
| `is_alternative bool` | Gives the requester something other than asked; labelled on the card |
| `quote jsonb` | Stored quote: line items, discount, compensation per party, net revenue. Agreed terms never change after this. |
| `net_revenue_cents` | Denormalised from the quote for the envelope and owner card |
| `owner_triggers text[]` | Escalation triggers that fired (`booking_shortened`, `over_cap`, `unknown_fact`, …) |
| `envelope_trips text[]` | Plausibility checks that failed |
| `needs_owner bool` | Either list non-empty |
| `fact_dependencies uuid[]` | Facts the plan relies on, incl. `unknown` ones |
| `fingerprint jsonb` | **Deferred.** Versions of every input |
| `validated_at` | Last successful validator run |

Unique `(proposal_id, seq, option_label)` `NULLS NOT DISTINCT`, so a revision without options is unique per seq.

### `revision_changes`

One row per booking a revision touches. Together they are the plan.

| Column | Notes |
|---|---|
| `revision_id` | |
| `booking_id` | Null for a booking the plan creates |
| `action` | `create`, `update`, `cancel`, `unassign`, `assign` |
| `before jsonb` | Booking snapshot incl. `version` (what the diff and revalidation compare against) |
| `new_unit_id`, `new_model_id`, `new_starts_at`, `new_ends_at`, `new_buffer_ends_at` | The after state; null = unchanged |
| `kind` | `new_booking`, `extension`, `time_shift`, `same_model_swap`, `model_change`, `cancellation` |
| `requires_approval bool` | False for `same_model_swap` (notice only) |
| `hours_shifted numeric` | For ranking and the 6h envelope check |
| `party_customer_id` | Whose booking this is |
| `price_delta_cents`, `compensation_cents`, `compensation_kind` | `refund` or `upgrade_value` |

The **re-approval diff** compares a party's `revision_changes` rows and quote lines between a revision and its parent: any difference means that party re-approves.

### `approvals`

| Column | Notes |
|---|---|
| `revision_id`, `proposal_id` | |
| `role` | `requester`, `affected`, `owner` |
| `customer_id` | Null for the owner |
| `status` | `pending`, `approved`, `rejected`, `countered`, `withdrawn` |
| `refusal bool` | A rejection meaning "no, as booked" (excludes the customer, below) |
| `source` | `card_click`, `owner_attested` ("agreed by phone"), `counter_author` (a click on **Send** for their own counter), `carried_over` |
| `carried_from_id` | The approval this one carried over from |
| `requested_at`, `responded_at`, `expires_at` | |

Unique `(revision_id, role, customer_id)` `NULLS NOT DISTINCT` (the owner's row has no customer); approving twice is an upsert that changes nothing. Approval rows are only written by the card endpoint and owner actions; no agent tool writes `approved`.

### `proposal_exclusions`

`(proposal_id, customer_id, reason)`. Customers who refused; the optimizer won't plan approval-needing changes for them in this proposal.

### `customer_constraints`

| Column | Notes |
|---|---|
| `proposal_id`, `customer_id` | |
| `kind` | `not_before`, `not_after`, `require_model`, `forbid_model`, `keep_unit` |
| `value jsonb` | e.g. `{ "at": "Thu 12:00" }` |
| `source_message_id` | The chat message it came from |

Only enumerated kinds; a limit the agent can't express as one of these is an escalation.

### `claims`

| Column | Notes |
|---|---|
| `proposal_id` | |
| `revision_id` | The revision that needs it. When several live revisions need the same capacity (options, or a new revision that still needs a booking), each holds its own row; the constraints below ignore same-proposal overlaps. |
| `booking_id` | Set for a claim on an existing booking |
| `unit_id`, `period tstzrange` | Set for a claim on capacity a plan targets |
| `released_at` | Null while active |

Two exclusion constraints make invariant 8 a database guarantee, while letting one proposal's options overlap each other:

```sql
EXCLUDE USING gist (booking_id WITH =, proposal_id WITH <>)
  WHERE (released_at IS NULL AND booking_id IS NOT NULL)
EXCLUDE USING gist (unit_id WITH =, period WITH &&, proposal_id WITH <>)
  WHERE (released_at IS NULL AND unit_id IS NOT NULL)
```

Lifecycle: a new revision inserts its claims; in the same transaction, claims whose revision became `superseded` or `dropped` get `released_at`. A failed insert (constraint violation) rolls back the new revision, so it is never offered.

## 5. Payments

### `paypal_orders`

| Column | Notes |
|---|---|
| `proposal_id`, `revision_id` | Null for seeded prepayments |
| `booking_id` | For prepayments |
| `customer_id` | Who pays |
| `paypal_order_id`, `intent` | `AUTHORIZE` for proposals, `CAPTURE` for prepayments |
| `amount_cents` | |
| `authorization_id`, `capture_id`, `captured_cents`, `refunded_cents` | |
| `status` | `created`, `approved`, `authorized`, `captured`, `voided`, `failed` |
| `simulated bool` | Normally false: seeded prepayments are real sandbox card captures. Safety valve if the sandbox misbehaves; the feed labels simulated rows |

Refund cap (compensation ≤ what they paid) = `captured_cents − refunded_cents`.

### `payment_ops`

Every PayPal call, recorded before it is made. In the PoC the call runs inline right after the transaction commits; this same table becomes the outbox later.

| Column | Notes |
|---|---|
| `kind` | `authorize`, `capture`, `void`, `refund` |
| `paypal_order_ref` | → `paypal_orders` |
| `amount_cents` | |
| `request_id` | **Unique.** The `PayPal-Request-Id`: `{kind}:{proposal}:{revision}:{customer}`, each id as 22 base64url characters (PayPal allows at most 108). One id = one amount: PayPal replays the first result for a repeated id without comparing the body (`spikes/paypal/FINDINGS.md`) |
| `status` | `pending`, `succeeded`, `failed` |
| `attempts`, `last_error`, `paypal_ref` | Retries reuse `request_id`; after `policy.payment_retry_limit`, an escalation |

## 6. Conversations and escalations

### `conversations`

`customer_id` (unique: one conversation per customer), `handed_off_at`, `handoff_reason`, `handed_back_at`. While handed off, agent output is stored as owner drafts, not sent.

### `messages`

| Column | Notes |
|---|---|
| `conversation_id` | |
| `author` | `customer`, `agent`, `owner`, `system` |
| `body` | |
| `card_revision_ids uuid[]` | An approval card. Contents are **rendered from the revisions at view time**, never stored as text. |
| `is_owner_draft bool` | Agent drafts during a handoff |

### `escalations`

| Column | Notes |
|---|---|
| `kind` | `approval`, `fact_question`, `plan_review`, `handoff`, `overdue`, `no_show`, `unassigned`, `payment_failure`, `customer_issue` (a judgment call from `escalate_to_owner` that doesn't hand off) |
| `proposal_id`, `revision_id`, `conversation_id`, `fact_id`, `booking_id` | Whichever apply |
| `reasons text[]` | Trigger codes |
| `summary` | Agent-written context for the owner |
| `status`, `resolution jsonb` | `open` / `resolved`; the owner's answer |

## 7. Owner drafts and activity

### `owner_drafts`

`booking_id` (unique: one draft per booking), `proposed jsonb` (new unit/times), `based_on_version`, `attested_customer_ids uuid[]` ("agreed by phone"). Stored server-side so a refresh keeps them; they hold no claims. "Resolve with agent" turns a draft into a proposal with `source = owner_resolve`.

### `activity_log`

Append-only: `seq` (insertion order, for stable feed order and SSE resume), `at` (shop clock), `actor` (`agent`, `owner`, `customer:{id}`, `system`), `kind`, `proposal_id`, `revision_id`, `payload jsonb`. Holds tool calls, optimizer runs with every pruned alternative and its reason, constraints recorded, claims, approvals, payment ops, transitions. Feeds the owner's activity feed over SSE (invariant 12).

## 8. Where each rule lives

| Rule | Where |
|---|---|
| Inv 1: Claude proposes, code decides | No agent tool writes `bookings`, `approvals.status = approved` or `payment_ops` directly; tools create revisions and fire events |
| Inv 2: pure optimizer | Reads a snapshot built from §2–4 tables; writes nothing |
| Inv 3: approval before change; picked-up rules | `approvals` rows per revision; commit checks all `approved`; picked-up trigger |
| Inv 4: commit sequence | `proposals.state` transitions, `payment_ops` order |
| Inv 5: no stale transitions | `pg_advisory_xact_lock(hashtextextended(shop_id::text, 0))` + validator in every write transaction |
| Inv 6: envelope | `revisions.envelope_trips` → `needs_owner` |
| Inv 7: no double-booking | `bookings` exclusion constraint |
| Inv 8: one active proposal per booking | `claims` exclusion constraints; unique active-proposal index |
| Inv 9: idempotent PayPal | `payment_ops.request_id` unique |
| Inv 10: prices from tools | `revisions.quote`, `equipment_models` rate card |
| Inv 11: facts from DB | `facts`; `unknown` → `escalations.kind = fact_question` |
| Inv 12: logging | `activity_log` |
| Options, re-approval, withdrawal | `revisions.option_label`, `parent_revision_id`, diff over `revision_changes`; `approvals.status = withdrawn` |
| Refusals, customer constraints | `proposal_exclusions`, `customer_constraints` |
| Forced changes | `bookings.unit_id` null + `escalations.kind = unassigned` |
| Handoff | `conversations.handed_off_at`, `messages.is_owner_draft` |
| Timeouts, fast-forward | `proposals.expires_at`, `approvals.expires_at`, `shops.clock_offset_ms` |
| Cancellation policy, all limits | `shops.policy` |
| One shop per visitor, reset | `shop_id` everywhere, `shops.session_key`; reset voids open `paypal_orders` then deletes and reseeds the shop's rows |

## 9. Scenario 1, row by row

| Step | Rows written |
|---|---|
| Alice asks to extend | `messages` (customer). `proposals` (customer_request, requester Alice, subject = Alice's booking, DRAFT). |
| Optimizer runs | `activity_log` (pruned alternatives with reasons). `revisions` seq 1 option A (Bob → A7R V) and option B (Bob 2pm, $15), each with `revision_changes` (Alice extension + Bob's change), `quote`; option B has `owner_triggers = {booking_shortened}`. |
| Quote to Alice | `approvals` (rev 1 A and B, requester Alice, pending) — her terms are identical in both. `messages` card → both revision ids. |
| Alice approves + authorizes | `approvals` → approved (card_click). `paypal_orders` (AUTHORIZE, $45) + `payment_ops` (authorize, succeeded). `claims`: Alice's and Bob's bookings; A7IV-1 Wed 10pm–Thu 2pm (the extension past Alice's current buffer); A7RV-1 Thu 9am–Fri 10pm. State → AWAITING_APPROVALS. |
| Offer to Bob | `approvals` (affected Bob, pending, rev 1 A and B). `messages` card → both revisions. |
| Bob taps B | Bob's approval on B → approved; rev 1 B → selected, rev 1 A → superseded; option A's claims (A7RV-1) released. Owner `approvals` row (pending) + `escalations` (approval). |
| Owner approves | Owner approval → approved; escalation resolved. All approvals on rev 1 B approved → state CAPTURING. |
| Capture | Outside the lock: `payment_ops` (capture, $45) → succeeded; `paypal_orders.captured_cents`. |
| Commit | In the lock: validator passes. `bookings` update Alice (`ends_at` Thu 10am, `buffer_ends_at` Thu 2pm) and Bob (`starts_at` Thu 2pm), versions bumped. Claims released. State COMMITTED. `payment_ops` (refund $15 on Bob's prepaid order) → succeeded. `activity_log` for each step; SSE pushes to Bryntum. |

## 10. Bryntum mapping

| Bryntum | Source |
|---|---|
| Resources | `units`, plus one virtual **Unassigned** resource for bookings with `unit_id` null |
| Events | `bookings` with status `confirmed` / `picked_up` (picked-up drawn locked: no drag to another resource) |
| Event buffer (postamble) | `buffer_ends_at − ends_at` |
| Resource time ranges | `unit_unavailability`, display only; open `condition_notes` as an icon on the resource. Not Pro resource calendars: every booking event is `manuallyScheduled`, so Bryntum's engine never moves one. |
| Ghost events | `revision_changes` of the proposal's active revisions, added to Bryntum's event store as read-only events with `kind: 'ghost'`. Never written to `bookings`. |
| Red drafts | `owner_drafts`, as events with `kind: 'draft'` and a Resolve with agent button |
| Writes | Owner drags and resizes are intercepted with `beforeEventDropFinalize` / `beforeEventResizeFinalize` (async finalize) and sent to the backend; the response (accepted, draft, or refused with reason) finalizes or cancels the change. Bryntum never saves to the DB on its own. Details and gotchas: `spikes/bryntum/FINDINGS.md`. |
| Live updates | SSE events from `activity_log` and booking changes patch the store |
