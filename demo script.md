# Demo scripts

Candidate scenarios for the demo video, all told from the owner's point of view. **Scenario 1 is the proposed signature scenario** (the spec, per `CLAUDE.md`). The others are shorter scenarios for cutaways, or backups if a feature slips.

## Shared seed data

Every scenario starts from the same shop, so we only need one seed script. Days are relative to the demo week (Mon–Sat), so the seed never goes stale.

| Model | Units | Rate |
|---|---|---|
| Sony A7 IV | A7IV-1, A7IV-2, A7IV-3 | $45/day |
| Sony A7R V | A7RV-1 | $65/day |
| DJI RS3 gimbal | RS3-1 | $25/day |
| Zhiyun Crane 4 gimbal | CRANE4-1 | $20/day |

| Customer | Booking | Unit | State |
|---|---|---|---|
| Vincent | Mon 9am → Wed 6pm | A7IV-1 | picked up |
| Bob | Thu 9am → Fri 6pm | A7IV-1 | confirmed, prepaid via PayPal |
| Charlie | Thu 9am → Fri 6pm | A7IV-2 | confirmed |
| Gina | Sat 9am → Sun 6pm | A7IV-2 | confirmed |
| Hank | Mon 9am → Tue 6pm (next week) | A7IV-2 | confirmed |
| — | Wed 9am → Fri 9pm maintenance | A7IV-3 | resource calendar: unavailable |
| Dana | Tue 9am → Thu 9am | RS3-1 | picked up |
| Eve | Thu 2pm → Sat 6pm | RS3-1 | confirmed; booking note: "for Canon R5 + RF 24-70" |

Facts: `CRANE4-1.balances_r5_rf2470 = unknown`. Shop hours 9am–9pm. All bookings are prepaid via PayPal. **Demo "now" is Wed 5:30pm, 30 minutes before Vincent is due back**, set on the injectable clock when the shop is seeded. Scenario 5 (Frank) needs its own fixture, still to be designed.

---

## 1. The extension (signature, ~2:30)

**Situation:** a customer with a camera already out wants to keep it longer, but the next renter is booked on that same unit.

1. **Chat (Vincent):** "Shoot ran over. Can I keep the camera until Thursday at 10am?"
2. The agent calls `request_change`. On the Bryntum schedule, Vincent's bar grows as a ghost event. With the 4h turnaround buffer, A7IV-1 isn't free until Thu 2pm, which overlaps Bob's booking. The conflict lights up red.
3. **Activity feed:** the optimizer runs, and the feed lists the alternatives it rejected and why:
   - Move Vincent to another unit → *pruned: picked-up rentals never change unit*
   - Move Bob to A7IV-2 → *pruned: overlaps Charlie*
   - Move Bob to A7IV-3 → *pruned: unit unavailable (maintenance)*
   - **Plan A:** upgrade Bob to the A7R V at no extra charge (the shop gives up $40). Needs Bob's approval.
   - **Plan B:** move Bob's pickup to Thu 2pm and refund him $15. Needs Bob's approval, and the owner's because his booking gets shorter.
4. The agent quotes Vincent $45 for the extra day. Vincent approves and **authorizes** $45 with the PayPal button: the money is held, not charged. The proposal claims Bob's booking and the extension slot.
5. Only now does the agent message Bob, with both plans as options on one approval card. Plan B is marked "needs shop confirmation." Bob: "2pm is fine, I'll take the discount," and taps Plan B, which supersedes Plan A.
6. **Owner approval card** appears on the dashboard: "Bob's booking shortened by 5h, $15 refund, net +$30." The owner clicks **Approve**.
7. **Commit:** Vincent's authorization is captured, the plan revalidates, all changes apply in one transaction, the ghost events become real bars, and Bob's $15 partial refund goes through on his original capture.
8. **Activity feed** closes the loop: claims, approvals per revision, authorization ID, capture ID, refund ID, and the final schedule.

**What it shows:** buffers, resource calendars, ghost events, pruned alternatives, claims, negotiation with a customer, an owner escalation, PayPal authorize → capture plus partial refund, and the commit sequence.

---

## 2. The owner drags, the agent asks (~1:15)

**Situation:** a regular calls the shop. The owner extends a booking by dragging it in Bryntum, and the agent works out the consequences. Along the way it hits a fact nobody has recorded.

1. **Owner** drags the end of Dana's RS3 booking from Thu 9am to Fri 9am and ticks "Dana agreed by phone." The overlap with Eve turns red and stays a draft. The owner clicks **Resolve with agent**.
2. The optimizer finds one plan: move Eve to the Crane 4 and refund her $20 (the $15 price difference plus $5 goodwill). It depends on `CRANE4-1.balances_r5_rf2470`, which is `unknown`, so the plan is marked **needs owner confirmation** rather than infeasible. The Crane 4 is cheaper, so the move is a downgrade and the plan is outside the plausibility envelope too.
3. **Owner card:** "Moves Eve to a cheaper gimbal (downgrade), $20 refund, net +$5. Needs a fact: Eve is shooting on a Canon R5 + RF 24-70. Does the Crane 4 balance that rig?" The owner answers **Yes** and approves.
4. The agent asks: "Save this as a fact so I don't ask again?" The owner clicks **Save**, and the fact flips to `yes` in the equipment panel.
5. Dana authorizes payment for the extra day through a PayPal link. The agent offers Eve the Crane 4 with the $20 refund, and she accepts. The authorization is captured and the changes commit.
6. *(Optional 5-second tag:)* the equipment panel shows the saved fact with its source ("owner, Wed 6:05pm"). Any later plan that needs it uses it without asking. A reset reseeds facts too, so the tag can't be shown by replaying.

**What it shows:** owner drag-to-extend, the `unknown` fact flow, the agent learning a constraint, and the agent stating facts only from the database.

---

## 3. The customer says no (~1:00)

**Situation:** a customer refuses a proposed change. Nothing about their booking moves, and the agent falls back to another plan.

1. Same starting point as Scenario 1, up to Vincent's authorization. Then Bob replies: "No, I really need it at 9am, and I want the A7 IV, not the R." The agent records both as constraints and points him to the card, and Bob taps **Keep my booking as is**.
2. Bob's ghost event rolls back in Bryntum, and his booking is byte-for-byte unchanged (show its version number in the inspector). Bob is now excluded from changes needing his approval.
3. The agent tries the next plan as revision 2: upgrade Charlie to the A7R V so Bob can swap to A7IV-2 (same model, notice only). Charlie declines.
4. No plans are left, so the agent offers Vincent the closest option: "I can't do Thursday, but you can keep it until 9pm tonight, closing time, at no extra charge." (Mon 9am → Wed 9pm is still 3 started days, so the rate card adds nothing.)
5. Vincent doesn't answer. The demo clock jumps ahead 30 minutes, the proposal goes to `EXPIRED`, their authorization is voided, the claims release, and their original Wed 6pm return stands.

**What it shows:** invariant 3 (no change without the customer's approval), ghost-event rollback, fallback planning across revisions, expiry, and voiding an authorization.

---

## 4. A unit goes down (~1:15)

**Situation:** the owner finds sensor dust on a camera during a return check and pulls it from service. Three upcoming bookings need a new home.

1. **Owner** adds a condition note to A7IV-2 ("sensor dust, out for a week") and marks it unavailable. Bryntum greys out the row, and Charlie's, Gina's and Hank's bookings drop into the **Unassigned** row.
2. The agent builds one plan for the three bookings:
   - Gina and Hank move to A7IV-3, which is free once its maintenance ends Fri 9pm. Same model, so they just get a notice.
   - No A7 IV is free for Charlie on Thu–Fri, so he's offered an upgrade to the A7R V (the shop gives up $40).
3. The plan touches 3 bookings, and with no requester paying, net revenue is −$40. The backend escalates it. **Owner review card** shows the whole plan as ghost events, along with the checks it tripped. The owner approves.
4. Gina and Hank get notices. Charlie accepts the upgrade. Everything commits together, with no PayPal step because no one owes money.
5. *(Branch:)* if Charlie refuses, his booking stays in the Unassigned row and the owner decides: cancel with a full refund, or find another camera.

**What it shows:** resource calendars, the Unassigned row, same-model swaps without approval, the 3+ bookings escalation, and reviewing a whole plan before it applies.

---

## 5. Above the agent's pay grade (~0:45)

**Situation:** a conflict can only be fixed with generous compensation, and the affected customer is angry.

1. Frank demands $80 to move. The agent passes it on with `revise_terms`. The backend **won't let it through as an offer**: over the $50 cap, so the revision goes to the owner as needing confirmation. The feed shows "Agent asked for $80 → over $50 cap → sent to owner."
2. Frank writes: "This is the second time. I want to talk to a person." The agent calls `escalate_to_owner` with the reason "upset customer, asked for a person" and a short summary of the situation and options.
3. The conversation is marked handed off, so the agent stops messaging Frank and drafts replies for the owner instead. **Owner** reads the summary, sets compensation to $60, and replies to Frank in the same chat thread.

**What it shows:** invariant 1 (Claude proposes, code decides), both the backend checks and the judgment-based escalations, and a clean handoff.

---

## 6. The race (~0:30, for technical judges)

**Situation:** while a proposal is waiting on Bob, the owner edits Bob's booking by hand.

1. During Scenario 1 step 5, after Vincent has authorized and before Bob answers, the owner drags Bob's booking to a different time.
2. Bryntum warns: "Bob's booking is part of Vincent's pending request." The owner overrides and ticks "Bob agreed by phone."
3. Vincent's proposal goes to `CANCELLED`, their authorization is voided, and the ghost events disappear. The agent tells Bob his request is withdrawn and re-plans Vincent against the new schedule.
4. *(Optional:)* show the Postgres exclusion constraint rejecting a forced double-booking insert in a terminal.

**What it shows:** claims, the owner-wins rule, voiding instead of refunding, and the database-level double-booking guard. The rarer capture → revalidation failure → refund path is covered by Vitest, not the video.

---

## Coverage

| Feature | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|
| Event buffers | ● | ● | ● | | | |
| Resource calendars | ● | | | ● | | |
| Ghost events / rollback | ● | ● | ● | ● | | |
| Owner drag + Resolve with agent | | ● | | | | ● |
| Pruned alternatives in feed | ● | ● | ● | ● | | |
| Customer negotiation | ● | ● | ● | ● | ● | |
| Owner escalation | ● | ● | | ● | ● | |
| Unknown fact → learned fact | | ● | | | | |
| Claims | ● | | ● | | | ● |
| PayPal authorize → capture | ● | ● | | | | |
| PayPal void | | | ● | | | ● |
| PayPal partial refund | ● | ● | | | | |
| Revisions / fallback plans | | | ● | | | |
| Expiry | | | ● | | | |
| Owner override | | | | | | ● |

## Suggested video cut (~3:00)

Scenario 1 in full (2:30), Scenario 2 steps 2–4 as the "it learns" moment (0:20), and Scenario 6 steps 2–3 as the "safe with money" moment (0:10). Scenarios 3–5 work as test fixtures and as fallbacks if a feature isn't ready.
