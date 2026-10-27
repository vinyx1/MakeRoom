# Agent tool-loop spike: findings

Anthropic TS SDK `@anthropic-ai/sdk` 1.3.0, beta tool runner (`client.beta.messages.toolRunner`) with `betaZodTool` + Zod 4, on Node 24 (runs `.ts` directly). Customer-scope tools from `docs/agent-tools.md` §3 against an in-memory demo seed (`world.ts`; the optimizer's Scenario 1 result is hard-coded). Run on 2026-10-27 with **Claude Haiku 5.5** for everything and **Claude Sonnet 5.5** for the judgment cases. Opus 5.5 was not run.

Files: `world.ts` is the fake backend; `tools.ts` builds the tools per turn as closures bound to one customer, with the call cap, the activity feed and the money lint; `agent.ts` runs one turn (context block, system prompt, tool loop, fallbacks, cost); `scenario.ts` plays Scenario 1 (`npm run scenario [haiku|sonnet]`); `evals.ts` runs 16 tricky prompts from `evals/judge-scenarios.md` §A with automatic checks (`npm run evals [model] [all|judgment|A1,A3,…]`). `ANTHROPIC_API_KEY` goes in `.env` (gitignored).

## Results

| Question | Result |
|---|---|
| Tool runner drives the loop with our tools | **Yes.** `betaZodTool` validates input against the Zod schema before `run`; iterating the runner yields each model reply, which gives per-request usage and a step feed. `runner.params` holds the full history, so a follow-up runner can continue a turn. |
| Scenario 1 as turns (agent-tools §7) | **Yes, on Haiku.** Alice: `request_change` (Thu 10:00, resolved from "Thursday at 10am") → `present_offer` → `send_message` quoting $45, "pending shop confirmation". Bob `offer_ready`: `present_offer` with both options + message, no customer named. Bob "noon?": `revise_terms` → `INFEASIBLE` → explains and offers 2pm. ~17s and **$0.002** for all three turns. |
| Tricky prompts (§A) | **Haiku 15/16, three runs in a row.** The one miss every time: A6 ("RED Komodo?") says "we don't carry it" but doesn't name a model the shop does carry. **Sonnet 9/9** on the judgment subset (A1, A3, A5, A6, A7, A8, A12, A15, upset), including A6. |
| Scope and isolation | **Held on every run.** Tools are closures bound to the customer; ids outside scope return `NOT_FOUND`; Bob's tools describe Alice only as "another customer". No message named another customer (A13) or reached anyone but the customer in scope (A12). |
| Money lint | **Works, and fires.** Haiku computed 10% off ($40.50) by itself; the lint blocked the message and it resent without the amount. It blocks amounts the customer typed ("the owner said $100", "promise $20"), even when the agent is refusing them; the agent rephrases. |
| Refusal hints steer replies | **Yes.** `INFEASIBLE` → offers the nearest time; `needs_owner` → "pending shop confirmation"; `unknown` fact → `ask_owner_fact` and "I'm checking with the shop". |
| Escalation judgment | **Yes on both models.** Upset customer asking for a person → `escalate_to_owner(asks_for_person)` + "a person will follow up". |
| Live progress | **Yes, per step.** Each tool call and model reply is reported as it happens (`onStep`), which is what the activity feed needs. Per-token streaming wasn't needed or tested. |
| Turn time | Haiku median **~4.3s**, max ~9s. Sonnet median **~6.6s**, max ~8s. Within the 10–30s the feed design assumed. |
| Cost | Haiku **~$0.0005/turn** with caching (~$0.001 cold). Sonnet **~$0.017/turn**. Scenario 1 end to end: Haiku ~$0.002; Sonnet ~$0.05 (estimated from per-turn cost). |

## Gotchas (must carry into the real build)

1. **Don't show a customer what they can't choose.** Seeing Plans A and B, Alice was repeatedly told to "pick an option" even with a hint saying not to. Giving `request_change` one offer for the requester (the backend attaches the sibling options to the card) fixed it at once. The shape of a tool result steers wording more than any prompt rule.
2. **Name things the way the customer should hear them.** An upgrade's `compensation_cents: 4000` came out as "plus $40.00 in upgrade value". Returning `your_benefit: "Free upgrade at no extra charge"` (and money only for real refunds) fixed it.
3. **The customer's own words must never make an amount citable.** The first lint harvested amounts from the whole prompt, so "$100" in Bob's message would have passed. Harvest from the context block, tool results and policy only.
4. **Models sometimes answer in plain text instead of `send_message`.** Haiku did it about 1 in 16 turns, and the text is discarded. Fix: if a turn ends with nothing delivered, push one user message ("your reply was not delivered; send it with send_message") into a follow-up runner built from `runner.params`. That keeps every message behind the lint; the template fallback stays as the last resort.
5. **Ids leak into messages** ("your booking bk_bob") unless the prompt says ids are for tools only.
6. **The lint is blunt about refusals.** "I can't promise $20" gets blocked because $20 came from the customer. The agent rephrases, so it's harmless, but it costs a request. Acceptable; don't loosen it.
7. **Forced tool use isn't available** on these models (`tool_choice` `any`/`tool` → 400), so "always reply with send_message" rests on the prompt plus the nudge in gotcha 4.
8. **Node's type stripping rejects TypeScript parameter properties** (`constructor(public x)`); write the fields out. Irrelevant once the real build has a bundler, but true for any `.ts` run directly.
9. **Caching works with no tuning.** Top-level `cache_control: { type: 'ephemeral' }` on the runner cached the system prompt + tools; most input tokens were cache reads after the first request.

## Model choice

Both models follow the rules that matter: every action stays behind a checked tool, so the worst a weaker model does is a weaker reply. The difference is grounding and judgment:

- **Haiku 5.5**: ~35× cheaper, a bit faster, fine on the scripted path and almost every trick. Weaker at volunteering useful facts from tool results (A6) and less specific when clarifying.
- **Sonnet 5.5**: 9/9, more helpful replies (lists the shop's cameras with rates, offers concrete weekend dates for "next weekend-ish"). ~$0.017/turn, so a judge session of ~30 turns is ~$0.50.

**Recommendation:** develop and run the eval set on Haiku; use Sonnet for the live demo and the video, behind the per-session usage cap. Run Opus 5.5 once on the same eval set before deciding finally, only if Sonnet leaves something to fix. The model is one config value.

## Not covered

- Owner-assist turns (`get_schedule`, `get_proposal`, `write_owner_summary`), `record_constraint`, and the `proposal_update` / `payment_result` / `owner_answered` events.
- Multi-turn memory within a conversation (each eval is one turn from a fresh context).
- The judge-mode usage cap and SSE transport; the step feed is console-only here.
- Opus 5.5 behaviour, cost and latency.

## Design changes

- `docs/agent-tools.md`: `request_change` gives the requester **one offer** (its options are attached to the card by the backend); upgrade benefits are described, not priced, to the affected customer; the lint harvests amounts from tool results, context and policy, **never from the customer's message**; a turn with no delivered message gets **one nudge** before the template fallback; ids never appear in messages.
- `CLAUDE.md` stack: agent model defaults to Sonnet 5.5 for the live demo, Haiku 5.5 for development and evals (pending a final check).
