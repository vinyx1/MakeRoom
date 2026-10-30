# RentFlow: what's left

Written 2026-10-29. Deadline about **Nov 12**, so roughly 13 working days. Estimates are for focused days with Claude.
The rule from `CLAUDE.md` still holds: the video scenarios must run reliably before anything new is added.

**Done so far:** Scenarios 1, 2, 3 and 6 work end to end (backend, agent, UI). Also done: owner price adjustment and judge mode (one shop per visitor, auto-reply, fast-forward, reset, usage cap). 139 tests pass.

---

## P0: required to submit (about 5 days)

1. **Deploy** (1–2 days). Do this first: hosting problems surface late, and redeploying afterwards is cheap.
   - The server serves `web/dist`. Set up a hosted Postgres, run the migrations, and store the secrets on the host: PayPal, `ANTHROPIC_API_KEY`, the sandbox buyer login.
   - The test card must be disabled in production. Cookies must be `Secure` over HTTPS.
   - The build needs access to the Bryntum npm registry, either in CI or by building locally and uploading.
   - Write a smoke-test script to run against the live URL after every deploy: load the page, Scenario 1 with the test card switched on only for that run, then Reset.
2. **Protect the public URL** (half a day). These are my additions, and they matter because the link is public:
   - **A global daily spend cap on Anthropic calls.** The per-shop cap doesn't stop many shops, bots or several judges at once. Past the cap, turns fall back to templates.
   - **Rate-limit shop creation per IP.** Every new visitor creates a shop and makes 7 real sandbox captures, so a crawler could flood PayPal and the database.
   - **Clean up shops untouched for 48 hours.** Void their open holds first.
3. **Bryntum licence** (an hour, but start now). The trial watermark shows across the schedule in the video and on the live site, and the 45-day trial may run out during judging. Ask the hackathon or Bryntum for a hackathon licence. If there isn't one, decide whether the watermark is acceptable. For the "Best Use of Bryntum" prize, it probably isn't.
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
9. **Counter-offers: `revise_terms`** (1 day; judge B1–B4). "Can I pick up at noon?" or "make it $25": this is the backend gap judges are most likely to hit. Covers:
   - an infeasible counter, which gets the nearest feasible time back;
   - a counter within limits, which becomes a new revision that counts as that customer's approval;
   - a counter beyond limits, which goes to the owner;
   - the 3-revision cap.
10. **Agent speed perception** (half a day). Sonnet turns take several seconds. Show the agent's tool steps live in the chat ("checking the schedule…") rather than only in the feed.

## P2: if time permits

11. **A customer cancels their own booking** (half a day; C8). Refund policy: 100% if 24h or more before pickup, otherwise 50%. A request that claimed the booking gets re-planned.
12. **`record_constraint`** (half a day; demo Scenario 3, step 1). Bob's "I need it at 9am, and I want the A7 IV" is stored and respected by later plans. Only needed if that moment goes in the video.
13. **Scenario 4: a unit goes down** (1–2 days). Owner UI to mark a unit unavailable, the Unassigned row, a multi-booking plan for owner review, notice-only swaps.
14. **Scenario 5: above the agent's pay grade** (1 day). Compensation over the cap plus an angry customer leads to escalation and handoff. Most of the parts already exist.
15. **Repricing after authorization** (half a day; C4/C5). A lower price captures less. A higher price needs a new authorization.
16. **Overdue returns** (D10) and **owner-assist turns** (the agent drafting for the owner).

## P3: security hardening (last)

Checked 2026-10-29. No keys are in git (history scanned). No secrets reach the browser (the frontend reads no `VITE_` variables; the PayPal client ID is public by design). The test card is off in production. The session cookie is `httpOnly`, `SameSite=Lax` and `Secure` in production. A 500 error returns no stack trace. Chat messages are capped at 2,000 characters.

The abuse protections in P0 item 2 (the global spend cap, the per-IP shop limit, shop cleanup) stay in P0: they protect money and uptime on the public URL. The rest:

17. **A separate Anthropic key for the deployment**, with a monthly spend limit set in the Anthropic console: the hard backstop behind the in-app cap. Revoke it after judging.
18. **Sandbox only, everywhere.** The buyer login shown on the page must be a dedicated sandbox account whose password isn't used anywhere else. No live PayPal credentials, ever.
19. **Database:** the host's managed Postgres with TLS and a long generated password, not open to the whole internet if the host allows that. `DATABASE_URL` lives only in the host's secret settings.
20. **Bryntum registry login** kept as a secret in the build environment, never in a committed `.npmrc`. Bryntum's trial code is never committed.
21. **Host settings:** `NODE_ENV=production`, HTTPS only, installs from the lockfile with `npm ci` (versions are already pinned exactly).
22. **Optional extras:** security headers (`@fastify/helmet`, with a content security policy that allows PayPal and the Bryntum assets), and a rate limit on chat messages and payment routes per session.

## Not doing

From `CLAUDE.md` "Out of scope": a multi-business marketplace, shipping, damage claims, late fees, real auth, multi-item kits, and Bryntum's engine moving real bookings.

## Suggested order

Learn the codebase → 1–3 (deploy, protect, ask about the licence) → 8 (UI) → 4 (eval) → 9 (counters) → 10 → 5–6 (video, write-up) → 7 (freeze). Pull in P2 items only if the P0/P1 items are finished before about Nov 9.
