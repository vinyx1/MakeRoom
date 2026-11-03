# RentFlow: what's left

Written 2026-10-29. Deadline about **Nov 12**, so roughly 13 working days. Estimates are for focused days with Claude.
The rule from `CLAUDE.md` still holds: the video scenarios must run reliably before anything new is added.

**Done so far:** Scenarios 1, 2, 3 and 6 work end to end (backend, agent, UI). Also done: owner price adjustment and judge mode (one shop per visitor, auto-reply, fast-forward, reset, usage cap). 139 tests pass.

---

## P0: required to submit (about 5 days)

1. ~~**Deploy**~~ done 2026-11-03: Railway, from the `production` branch (`git push origin main:production`; `main` auto-commits, so it must not deploy directly). `Dockerfile` and `railway.json` build it; migrations run on start. After each deploy: `npm run smoke -- <url>` in `server/`. It can't click the PayPal popup, so check that by hand.
2. ~~**Protect the public URL**~~ built 2026-11-03: daily Anthropic spend cap (`AGENT_DAILY_SPEND_USD`, default $5, then templates), new shops per IP (`SHOPS_PER_IP_PER_HOUR`, default 5, production only), per-session limits on chat, payment and reset requests (`server/src/server/rate-limit.ts`), and hourly cleanup of shops unseen for 48 hours. Confirm the per-IP limit on Railway before sharing the link: it assumes one proxy hop.
3. ~~**Bryntum trial**~~ non-issue, checked 2026-11-03: the trial ends well after the hackathon, so nothing to do. Decided 2026-11-02: the hackathon expects the free trial, so no paid licence. The trial watermark stays in the video and on the live site.
4. **Tricky-prompt eval** (1 day). Write the ~25 prompts in `evals/chat-prompts.md` (judge scenarios A1–A15 plus extras). Run them on Sonnet and fix any bad replies. Of all the things a judge might try, free-form chat is the most likely to look bad.
5. **Demo video** (1 day): about 3 minutes, following "Suggested video cut" in `demo script.md`. Record it from the deployed site (or locally) after the UI revamp.
6. **Devpost write-up and README** (half a day): the problem, how it works (a diagram of "Claude proposes, code decides", the commit sequence and PayPal authorize → capture), how to try it (link, sandbox login, "try this first"), the tech stack, and what's mocked.
7. **Buffer and freeze** (1 day before the deadline): no features after this point. Re-run the smoke test and do the submission.

## P1: what judges notice (about 4–5 days)

8. **UI revamp** (2–3 days). Judges arrive cold, so the first minute matters most. Covers both prizes.
   - **First-run guidance:** a short "Try this" strip with one-click prompt chips ("As Alice: keep the camera until Thursday 10am"). Highlight who the two chats are and what the owner column is for. Help is currently hidden behind "?".
   - **Cause and effect at a glance:** when a card appears or a booking changes, highlight it on the schedule. Clearer ghost and alternative styling.
   - **Payment states shown as states:** a held / captured / voided / refunded badge on each request, linked to the feed.
   - **Visual polish:** spacing, typography, an empty-state for each pane. Check at 1280px wide and in Safari.
   - **Read-only Bryntum depth, if time allows** (see `CLAUDE.md` "If time permits"), in this order:
     1. **Play rejected alternatives on the schedule:** clicking a pruned plan in the feed shows it as ghosts, with the rule it broke lit up. The optimizer already stores these as data, so this is cheap and very visual.
     2. **Resource utilization view** under the schedule: per-unit load before and after a plan.
     3. **Engine what-if:** a separate read-only scheduler instance that computes conflicts for a proposed plan. This one carries the most risk. The engine must never touch real bookings (invariant: the backend decides).
9. ~~**Counter-offers: `revise_terms`**~~ done 2026-11-03 (judge B1, B2, B4): infeasible → nearest time; a counter is a draft with Send and Discard; beyond limits → the owner; the 3-revision cap. A requester correcting an unpaid offer now replaces it. Not built: changing terms after paying the hold, owner editing a refund (B3).
10. **Agent speed perception** (half a day). Sonnet turns take several seconds. Show the agent's tool steps live in the chat ("checking the schedule…") rather than only in the feed.

## P2: if time permits

11. **A customer cancels their own booking** (half a day; C8). Refund policy: 100% if 24h or more before pickup, otherwise 50%. A request that claimed the booking gets re-planned. The owner's version is done (2026-11-03): Delete on the schedule, agreed by phone, full refund.
12. **`record_constraint`** (half a day; demo Scenario 3, step 1). Bob's "I need it at 9am, and I want the A7 IV" is stored and respected by later plans. Only needed if that moment goes in the video.
13. **Scenario 4: a unit goes down** (1–2 days). Owner UI to mark a unit unavailable, the Unassigned row, a multi-booking plan for owner review, notice-only swaps.
14. **Scenario 5: above the agent's pay grade** (1 day). Compensation over the cap plus an angry customer leads to escalation and handoff. Most of the parts already exist.
15. **Repricing after authorization** (half a day; C4/C5). A lower price captures less. A higher price needs a new authorization.
16. ~~**Overdue returns** (D10)~~ done 2026-10-30 (see `docs/conflict-model.md` §8). Still open: **owner-assist turns** (the agent drafting for the owner), and automatic overdue/no-show timers (the owner marks them by hand).
17. **Better options for affected customers** (half a day to a day). Today `chooseOptions` (`server/src/proposals/flow.ts`) keeps the top 2 plans by rank. A model change carries a 6h ranking penalty, so a free upgrade can lose its slot to a time shift, and plans that fail the plausibility envelope are dropped whenever one passes. Instead:
    - reserve one slot for the best upgrade that stays within limits: at most one tier up, upgrade value under the $50 cap, and compensation no more than what the requester pays;
    - raise the cap to 3 options per card (each option claims its unit, so keep it small);
    - offer a downgrade only when nothing better exists (already true when it's the only plan, as for Eve).
    The seed has only two gimbals, so Scenario 2 still ends in a downgrade. To demo this, add a third, higher-tier gimbal. Move to P1 if it goes in the video.
18. **Add more customers to the demo** (about a day). Let someone add a customer and give them a booking, instead of only the 7 seeded ones. It needs a form, validation and a real sandbox prepayment for each booking. No video scenario needs this, and the chat panes already switch between all 7, so it comes after everything above. First check that a customer can book a free slot through chat in the UI (judge E7); if that works, a "try this" prompt in the UI revamp covers most of the value.

## P3: security hardening (last)

Checked 2026-10-29. No keys are in git (history scanned). No secrets reach the browser (the frontend reads no `VITE_` variables; the PayPal client ID is public by design). The test card is off in production. The session cookie is `httpOnly`, `SameSite=Lax` and `Secure` in production. A 500 error returns no stack trace. Chat messages are capped at 2,000 characters.

The abuse protections in P0 item 2 (the global spend cap, the per-IP shop limit, shop cleanup) stay in P0: they protect money and uptime on the public URL. The rest:

19. **A separate Anthropic key for the deployment**, with a monthly spend limit set in the Anthropic console: the hard backstop behind the in-app cap. Revoke it after judging.
20. **Sandbox only, everywhere.** The buyer login shown on the page must be a dedicated sandbox account whose password isn't used anywhere else. No live PayPal credentials, ever.
21. **Database:** the host's managed Postgres with TLS and a long generated password, not open to the whole internet if the host allows that. `DATABASE_URL` lives only in the host's secret settings.
22. **Bryntum trial:** nothing secret to store, since it installs from public npm with no login.
23. **Host settings:** `NODE_ENV=production`, HTTPS only, installs from the lockfile with `npm ci` (versions are already pinned exactly).
24. **Optional extras:** security headers (`@fastify/helmet`, with a content security policy that allows PayPal and the Bryntum assets), and a rate limit on chat messages and payment routes per session.

## Not doing

From `CLAUDE.md` "Out of scope": a multi-business marketplace, shipping, damage claims, late fees, real auth, multi-item kits, and Bryntum's engine moving real bookings.

## Suggested order

Learn the codebase → 1–3 (deploy, protect, check the trial dates) → 8 (UI) → 4 (eval) → 9 (counters) → 10 → 5–6 (video, write-up) → 7 (freeze). Pull in P2 items only if the P0/P1 items are finished before about Nov 9.
