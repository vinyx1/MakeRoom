// Customer-scope tools (docs/agent-tools.md §3), built per turn as closures bound to one shop, customer and
// conversation. The model never passes the shop or the customer. Every tool validates against current state;
// the agent can only reach the customer through send_message, and no tool records a decision or moves money.
//
// Not yet: revise_terms (counters) and record_constraint. Refusals are a card button (Keep my booking as is); the
// backend re-plans after one, so no tool is involved.

import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { logActivity } from '../activity.ts';
import type { Db, Tx } from '../db/client.ts';
import { loadSnapshot } from '../db/load-snapshot.ts';
import * as s from '../db/schema.ts';
import { type Request, optimize } from '../optimizer/optimizer.ts';
import { type Index, indexSnapshot, occupancy, overlaps } from '../optimizer/snapshot.ts';
import { earliestOpenAtOrAfter, latestOpenAtOrBefore } from '../optimizer/time.ts';
import { validate } from '../optimizer/validator.ts';
import { renderOption } from '../proposals/cards.ts';
import { requestChange } from '../proposals/flow.ts';
import { ACTIVE_STATES } from '../proposals/state-machine.ts';
import { LIVE_REVISION_STATUSES } from '../proposals/store.ts';
import { ShortIds, amountsIn, shopTime, usd } from './scope.ts';

export const MAX_TOOL_CALLS = 12;

/** What the backend tracks while one turn runs. */
export class TurnState {
  ids = new ShortIds();
  calls: { name: string; input: unknown; result: Record<string, unknown>; ms: number }[] = [];
  /** Every amount, in cents, the agent has seen from the context, tool results or policy: the money lint. */
  citable = new Set<number>();
  cardsPosted = 0;
  messagesSent = 0;
  /** Chat writes (cards and messages) in the order the model made the calls, even when it makes them in parallel. */
  writes: Promise<unknown> = Promise.resolve();
  private lastAt = 0;

  /** A strictly increasing timestamp for this turn's chat writes, so they sort in call order. */
  nextAt(now: Date) {
    this.lastAt = Math.max(now.getTime(), this.lastAt + 1);
    return new Date(this.lastAt);
  }

  /** Runs chat writes one after another, in call order. */
  inOrder<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writes.then(fn, fn);
    this.writes = run.catch(() => {});
    return run;
  }

  allow(text: string) {
    for (const cents of amountsIn(text)) this.citable.add(cents);
  }
}

export type ToolScope = {
  db: Db;
  shopId: string;
  customerId: string;
  conversationId: string;
  turn: TurnState;
  /** Shop clock. */
  now: () => Date;
  onStep: (line: string) => void;
};

type Result = Record<string, unknown>;
const ok = (body: Result): Result => ({ ok: true, ...body });
const refuse = (code: string, message: string, hint?: string, extra: Result = {}): Result => ({ ok: false, code, message, ...(hint ? { hint } : {}), ...extra });

const localTime = z.string().describe('Shop-local time, YYYY-MM-DDTHH:MM, resolved with the calendar in the context');
const Change = z.discriminatedUnion('type', [
  z.object({ type: z.literal('extend'), new_end: localTime }),
  z.object({ type: z.literal('shift'), new_start: localTime.optional(), new_end: localTime.optional() }),
  z.object({ type: z.literal('new_booking'), model_id: z.string(), start: localTime, end: localTime }),
]);

export function makeTools(scope: ToolScope) {
  const { db, shopId, customerId: me, turn } = scope;
  const read = <T>(fn: (tx: Tx, idx: Index) => Promise<T>) =>
    db.transaction(async (tx) => fn(tx, indexSnapshot(await loadSnapshot(tx, shopId))));

  // Every tool runs through here: the call cap, the activity feed, and harvesting amounts for the money lint.
  const tool = <S extends z.ZodType>(def: { name: string; description: string; inputSchema: S; run: (input: z.infer<S>) => Promise<Result> }) =>
    betaZodTool({
      ...def,
      run: async (input: z.infer<S>) => {
        const t0 = Date.now();
        let result: Result;
        if (turn.calls.length >= MAX_TOOL_CALLS) result = refuse('OVER_LIMIT', `Tool call limit (${MAX_TOOL_CALLS}) reached for this turn.`, 'Send one final message and stop.');
        else {
          try {
            result = await def.run(input);
          } catch (e) {
            scope.onStep(`${def.name} threw: ${String(e)}`);
            result = refuse('INTERNAL', 'Something went wrong on the shop side.', 'Apologise briefly and say the shop will follow up.');
          }
        }
        const text = JSON.stringify(result);
        if (def.name !== 'send_message') turn.allow(text);
        const ms = Date.now() - t0;
        turn.calls.push({ name: def.name, input, result, ms });
        scope.onStep(`${def.name} → ${result.ok ? 'ok' : result.code}`);
        await logActivity(db, {
          shopId, at: scope.now(), actor: 'agent', kind: 'agent_step',
          payload: { customerId: me, tool: def.name, input: input as Record<string, unknown>, ok: result.ok, code: result.code ?? null, ms },
        });
        return text;
      },
    });

  /** Proposals this customer is part of, as requester or with an approval to give. */
  async function myProposals(tx: Tx) {
    const asRequester = await tx
      .select()
      .from(s.proposals)
      .where(and(eq(s.proposals.shopId, shopId), eq(s.proposals.requesterCustomerId, me), inArray(s.proposals.state, [...ACTIVE_STATES])));
    const asParty = await tx
      .select({ proposal: s.proposals })
      .from(s.approvals)
      .innerJoin(s.proposals, eq(s.approvals.proposalId, s.proposals.id))
      .where(and(eq(s.approvals.shopId, shopId), eq(s.approvals.customerId, me), inArray(s.proposals.state, [...ACTIVE_STATES])));
    const all = new Map([...asRequester, ...asParty.map((r) => r.proposal)].map((p) => [p.id, p]));
    return [...all.values()];
  }

  /** One customer's side of a revision, in the words the card uses. Upgrades are described, not priced. */
  async function terms(tx: Tx, idx: Index, revisionId: string, role: 'requester' | 'affected') {
    const [rev] = await tx.select().from(s.revisions).where(eq(s.revisions.id, revisionId));
    const rows = await tx.select().from(s.revisionChanges).where(eq(s.revisionChanges.revisionId, revisionId));
    const [owner] = await tx.select().from(s.approvals).where(and(eq(s.approvals.revisionId, revisionId), eq(s.approvals.role, 'owner')));
    const card = renderOption(idx, rev!, rows, me, role, owner?.status === 'approved');
    return { revision_id: turn.ids.of('rv', rev!.id), option: card.option, terms: card.lines, needs_shop_confirmation: card.needsShop, is_alternative: card.isAlternative };
  }

  function toRequest(idx: Index, bookingId: string | null, change: z.infer<typeof Change>): { request: Request } | { error: Result } {
    const t = shopTime(idx);
    const time = (v: string | undefined, what: string) => {
      if (v === undefined) return undefined;
      const d = t.parse(v);
      if (!d) throw new Error(`bad ${what}`);
      return d;
    };
    try {
      if (change.type === 'new_booking') {
        const modelId = turn.ids.resolve('md', change.model_id);
        if (!modelId) return { error: refuse('NOT_FOUND', 'Unknown model.', 'Use search_inventory to find the model id.') };
        return { request: { kind: 'new_booking', customerId: me, modelId, startsAt: time(change.start, 'start')!, endsAt: time(change.end, 'end')! } };
      }
      if (!bookingId) return { error: refuse('NOT_FOUND', 'This change needs one of the customer’s bookings.', 'Use get_my_bookings for the booking id.') };
      if (change.type === 'extend') return { request: { kind: 'extend', bookingId, newEndsAt: time(change.new_end, 'new_end')! } };
      if (!change.new_start && !change.new_end) return { error: refuse('INVALID_STATE', 'Nothing to change.') };
      return { request: { kind: 'shift', bookingId, newStartsAt: time(change.new_start, 'new_start'), newEndsAt: time(change.new_end, 'new_end') } };
    } catch {
      return { error: refuse('INVALID_TIME', 'Times must be shop-local YYYY-MM-DDTHH:MM.', 'Resolve the date with the calendar in the context.') };
    }
  }

  const myBooking = (idx: Index, short: string | undefined) => {
    if (!short) return null;
    const id = turn.ids.resolve('bk', short);
    const b = id ? idx.bookings.get(id) : undefined;
    return b && b.customerId === me ? b : undefined;
  };

  /** Turns validator violations on the request itself into a refusal with the nearest valid times. */
  function invalid(idx: Index, violations: { rule: string; message: string }[], request: Request): Result {
    const t = shopTime(idx);
    const rule = violations[0]!.rule;
    const code = rule === 'outside_shop_hours' ? 'OUTSIDE_SHOP_HOURS' : rule === 'in_past' ? 'IN_PAST' : 'INVALID_STATE';
    const asked = request.kind === 'extend' ? request.newEndsAt : request.kind === 'new_booking' ? request.endsAt : (request.newEndsAt ?? request.newStartsAt)!;
    const nearest =
      code === 'OUTSIDE_SHOP_HOURS'
        ? { earlier: t.show(latestOpenAtOrBefore(asked, idx.snap.shop)), later: t.show(earliestOpenAtOrAfter(asked, idx.snap.shop)) }
        : undefined;
    return refuse(code, violations.map((v) => v.message).join('; '), nearest ? 'Offer the nearest valid times instead.' : 'Explain why and suggest something that works.', nearest ? { nearest } : {});
  }

  return [
    tool({
      name: 'get_my_bookings',
      description: "The customer's own bookings: id, model, unit, pickup and return, status, price paid, and whether a request currently involves it.",
      inputSchema: z.object({}),
      run: () =>
        read(async (tx, idx) => {
          const t = shopTime(idx);
          const busy = new Set((await myProposals(tx)).map((p) => p.subjectBookingId));
          return ok({
            bookings: idx.snap.bookings
              .filter((b) => b.customerId === me && (b.status === 'confirmed' || b.status === 'picked_up'))
              .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
              .map((b) => ({
                booking_id: turn.ids.of('bk', b.id), model: idx.models.get(b.modelId)?.name, unit: idx.unitLabel(b.unitId),
                pickup: t.show(b.startsAt), return: t.show(b.endsAt), status: b.status, price_paid: usd(b.priceCents), request_in_progress: busy.has(b.id),
              })),
          });
        }),
    }),

    tool({
      name: 'search_inventory',
      description: 'Models the shop carries, with daily rates and substitutes. Text match on name and category; omit the query to list everything.',
      inputSchema: z.object({ query: z.string().optional() }),
      run: async ({ query }) =>
        read(async (_tx, idx) => {
          const row = (m: (typeof idx.snap.models)[number]) => ({
            model_id: turn.ids.of('md', m.id), name: m.name, category: m.category.replace('_', ' '), daily_rate: usd(m.dailyRateCents),
            substitutes: idx.substitutesOf(m.id).map((x) => x.name),
          });
          const q = query?.toLowerCase().trim();
          const words = q?.split(/\s+/).filter((w) => w.length > 1) ?? [];
          const hits = idx.snap.models.filter((m) => !q || words.some((w) => `${m.name} ${m.category}`.toLowerCase().replace('_', ' ').includes(w)));
          if (hits.length) return ok({ models: hits.map(row) });
          // A miss still answers from data (spike gotcha 9): same kind of gear where the query hints at a category.
          const category = /gimbal|stabili[sz]er/.test(q ?? '') ? 'gimbal' : /camera|body|cinema|komodo|red|canon|nikon|sony|fuji/.test(q ?? '') ? 'camera_body' : null;
          const closest = idx.snap.models.filter((m) => !category || m.category === category);
          return ok({
            models: [], not_carried: query, closest: closest.map(row),
            hint: `The shop doesn't carry "${query}". Say so, then name the closest models from "closest" with their daily rates.`,
          });
        }),
    }),

    tool({
      name: 'check_availability',
      description: 'Whether a model is free for a time range, across its units, with the busy windows around it (anonymous). Reserves nothing.',
      inputSchema: z.object({ model_id: z.string(), start: localTime, end: localTime }),
      run: async ({ model_id, start, end }) =>
        read(async (_tx, idx) => {
          const t = shopTime(idx);
          const modelId = turn.ids.resolve('md', model_id);
          if (!modelId) return refuse('NOT_FOUND', 'Unknown model.', 'Use search_inventory for model ids.');
          const [from, to] = [t.parse(start), t.parse(end)];
          if (!from || !to || to <= from) return refuse('INVALID_TIME', 'Give a start before the end, as YYYY-MM-DDTHH:MM.');
          const buffer = idx.policy.default_buffer_minutes * 60_000;
          const freeUnits = idx.unitsOfModel(modelId).filter((u) =>
            validate(idx, { changes: [{ bookingId: null, customerId: me, after: { unitId: u.id, modelId, startsAt: from, endsAt: to, bufferEndsAt: new Date(to.getTime() + buffer) } }], requesterCustomerId: me })
              .violations.length === 0,
          );
          const window = { start: new Date(from.getTime() - 24 * 3600_000), end: new Date(to.getTime() + 24 * 3600_000) };
          const busy = idx.activeBookings
            .filter((b) => b.modelId === modelId && overlaps(occupancy(b), window))
            .map((b) => ({ from: t.display(b.startsAt), until: t.display(b.bufferEndsAt), what: b.customerId === me ? 'your booking' : 'another booking' }));
          return ok({ free: freeUnits.length > 0, free_units: freeUnits.length, busy_nearby: busy, note: 'Checks shop hours, turnaround and maintenance. Nothing is reserved.' });
        }),
    }),

    tool({
      name: 'get_fact',
      description: 'An equipment fact for a unit (label like A7IV-1) or model (name): yes, no or unknown, with its source. Never guess a fact this tool does not return as yes or no.',
      inputSchema: z.object({ subject: z.string(), key: z.string().describe('snake_case attribute, e.g. weather_sealed') }),
      run: async ({ subject, key }) =>
        read(async (_tx, idx) => {
          const k = snake(key);
          const unit = idx.snap.units.find((u) => u.label.toLowerCase() === subject.toLowerCase().trim());
          const model = idx.snap.models.find((m) => m.name.toLowerCase() === subject.toLowerCase().trim());
          if (!unit && !model) return refuse('NOT_FOUND', 'No such unit or model.', 'Use search_inventory for model names.');
          const fact = unit ? idx.fact(unit.id, k) : idx.snap.facts.find((f) => f.modelId === model!.id && f.key === k);
          const value = fact?.value ?? 'unknown';
          return ok({
            subject, key: k, value, source: fact && value !== 'unknown' ? fact.source : null,
            ...(value === 'unknown' ? { hint: 'Unknown: use ask_owner_fact and tell the customer you are checking with the shop. Do not guess.' } : {}),
          });
        }),
    }),

    tool({
      name: 'get_policy',
      description: 'Shop rules: hours, turnaround buffer, billing, cancellation refunds, what the assistant may discount, the approval timeout.',
      inputSchema: z.object({}),
      run: async () =>
        read(async (_tx, idx) => {
          const p = idx.policy;
          const h = (v: string) => v.slice(0, 5);
          return ok({
            shop_hours: `${h(idx.snap.shop.opensAt)}–${h(idx.snap.shop.closesAt)} daily; pickups and returns only within them`,
            turnaround_buffer_hours: p.default_buffer_minutes / 60,
            billing: 'Per started 24 hours at the daily rate',
            cancellation: `Full refund ${p.cancel_full_refund_hours}h or more before pickup; ${p.cancel_late_refund_pct}% within that`,
            assistant_discount_limit: `${p.discount_band_pct}% off a quote; anything more needs the shop`,
            compensation_cap: `${usd(p.compensation_cap_cents)} per customer without the shop`,
            approval_timeout_minutes: p.approval_timeout_minutes,
          });
        }),
    }),

    tool({
      name: 'preview_change',
      description: 'A dry run of request_change, for hypothetical questions only ("how much would…", "would it be possible to…"): whether it fits, would need another booking to move, or is impossible, with an indicative price. When the customer asks for the change itself, use request_change instead.',
      inputSchema: z.object({ booking_id: z.string().optional(), change: Change }),
      run: async ({ booking_id, change }) =>
        read(async (_tx, idx) => {
          const b = myBooking(idx, booking_id);
          if (b === undefined) return refuse('NOT_FOUND', 'No such booking for this customer.');
          const prepared = toRequest(idx, b?.id ?? null, change);
          if ('error' in prepared) return prepared.error;
          const { request } = prepared;
          const r = optimize(idx.snap, request);
          if (r.status === 'invalid_request') return invalid(idx, r.violations, request);
          if (r.status === 'infeasible')
            return ok({
              outcome: 'infeasible',
              nearest: r.nearest ? { terms: r.nearest.changes.filter((c) => c.isRequester).map((c) => `until ${shopTime(idx).display(c.after.endsAt)}`), price: usd(r.nearest.quote.chargeCents), price_status: 'indicative' } : null,
              hint: r.nearest ? 'Not possible as asked; offer the nearest option.' : 'Not possible, even by moving other bookings. Say so.',
            });
          const top = r.plans[0]!;
          return ok({
            outcome: r.status === 'fits' ? 'fits' : 'needs_other_changes', price: usd(top.quote.chargeCents), price_status: 'indicative',
            ...(r.status === 'needs_other_changes' ? { note: 'Another booking would need to move; that customer would be asked first.' } : {}),
          });
        }),
    }),

    tool({
      name: 'get_my_proposals',
      description: "Active requests involving the customer, as requester or affected party: state, this customer's terms, what it is waiting on (anonymous), expiry.",
      inputSchema: z.object({}),
      run: async () =>
        read(async (tx, idx) => {
          const t = shopTime(idx);
          const out = [];
          for (const p of await myProposals(tx)) {
            const role = p.requesterCustomerId === me ? 'requester' : 'affected';
            const revs = await tx.select().from(s.revisions).where(and(eq(s.revisions.proposalId, p.id), inArray(s.revisions.status, [...LIVE_REVISION_STATUSES])));
            const approvals = revs.length ? await tx.select().from(s.approvals).where(inArray(s.approvals.revisionId, revs.map((r) => r.id))) : [];
            const pending = approvals.filter((a) => a.status === 'pending');
            const waitingOn = [...new Set(pending.map((a) => (a.customerId === me ? 'you' : a.role === 'owner' ? 'the shop' : 'another customer')))];
            const shown = role === 'requester' ? revs.slice(0, 1) : revs.filter((r) => approvals.some((a) => a.revisionId === r.id && a.customerId === me));
            out.push({
              request_id: turn.ids.of('rq', p.id), role, state: p.state,
              waiting_on: p.state === 'CAPTURING' ? ['being confirmed now'] : waitingOn,
              expires: p.expiresAt ? t.display(p.expiresAt) : null,
              options: await Promise.all(shown.map((r) => terms(tx, idx, r.id, role))),
            });
          }
          return ok({ requests: out });
        }),
    }),

    tool({
      name: 'request_change',
      description: "When the customer asks for a change to one of their bookings (extend, shift) or a new booking, call this directly; don't ask permission first. It creates a request with one offer and holds nothing: nothing is charged or confirmed until the customer accepts and pays on the card, everyone involved agrees, and the shop commits it.",
      inputSchema: z.object({ booking_id: z.string().optional(), change: Change }),
      run: async ({ booking_id, change }) => {
        const prepared = await read(async (_tx, idx) => {
          const b = myBooking(idx, booking_id);
          if (b === undefined) return { error: refuse('NOT_FOUND', 'No such booking for this customer.') };
          const r = toRequest(idx, b?.id ?? null, change);
          return 'error' in r ? r : { request: r.request, idx };
        });
        if ('error' in prepared) return prepared.error;
        const r = await requestChange(db, shopId, { customerId: me, request: prepared.request });
        if (r.status === 'invalid') return invalid(prepared.idx, r.violations, prepared.request);
        if (r.status === 'refused') return refuse('INVALID_STATE', r.reason, 'Use get_my_proposals to explain what is already in progress.');
        if (r.status === 'infeasible') return refuse('INFEASIBLE', 'Not possible, even by moving other bookings.', 'Say so plainly and suggest a different time or model.');
        return read(async (tx, idx) => {
          // One offer for the requester (spike gotcha 1): any options differ only for the other customer.
          const offer = await terms(tx, idx, r.revisions[0]!.id, 'requester');
          const othersAsked = (await tx.select().from(s.revisionChanges).where(inArray(s.revisionChanges.revisionId, r.revisions.map((x) => x.id))))
            .some((c) => c.partyCustomerId !== me && c.requiresApproval);
          return ok({
            request_id: turn.ids.of('rq', r.proposal.id),
            offer: { ...offer, option: null, needs_shop_confirmation: r.revisions.every((x) => x.needsOwner), price: usd(r.chargeCents), price_status: 'offered' },
            another_customer_must_agree: othersAsked,
            expires: shopTime(idx).display(r.proposal.expiresAt!),
            hint: `${r.isAlternative ? 'This is the closest alternative, not exactly what was asked; say so. ' : ''}Call present_offer with ["${offer.revision_id}"] so the customer can accept${r.chargeCents > 0 ? ' and authorize the payment with PayPal' : ''}. ${othersAsked ? 'Another customer will be asked after they accept; say it is pending until then.' : ''}`.trim(),
          });
        });
      },
    }),

    tool({
      name: 'present_offer',
      description: 'Post an approval card in this conversation for one revision, or two sibling options. The card shows the terms and the buttons; the customer decides by clicking. At most once per turn.',
      inputSchema: z.object({ revision_ids: z.array(z.string()).min(1).max(2) }),
      run: async ({ revision_ids }) => {
        if (turn.cardsPosted >= 1) return refuse('OVER_LIMIT', 'Only one card per turn.');
        const ids = revision_ids.map((r) => turn.ids.resolve('rv', r));
        if (ids.some((x) => !x)) return refuse('NOT_FOUND', 'Unknown revision.', 'Use get_my_proposals for revision ids.');
        return turn.inOrder(() => db.transaction(async (tx) => {
          const idx = indexSnapshot(await loadSnapshot(tx, shopId));
          const revs = await tx.select().from(s.revisions).where(inArray(s.revisions.id, ids as string[]));
          if (new Set(revs.map((r) => r.proposalId)).size !== 1) return refuse('INVALID_STATE', 'Options on one card must belong to one request.');
          const [p] = await tx.select().from(s.proposals).where(and(eq(s.proposals.id, revs[0]!.proposalId), eq(s.proposals.shopId, shopId)));
          const role = p!.requesterCustomerId === me ? 'requester' : 'affected';
          const live = await tx.select().from(s.revisions).where(and(eq(s.revisions.proposalId, p!.id), inArray(s.revisions.status, [...LIVE_REVISION_STATUSES])));
          const pending = await tx
            .select()
            .from(s.approvals)
            .where(and(inArray(s.approvals.revisionId, live.map((r) => r.id)), eq(s.approvals.customerId, me), eq(s.approvals.status, 'pending')));
          // A requester's card is open while the request is a draft, even when they agreed by phone (owner-attested).
          const open = role === 'requester' ? p!.state === 'DRAFT' : p!.state === 'AWAITING_APPROVALS' && pending.length > 0;
          if (!open) return refuse('INVALID_STATE', 'This customer has no decision pending on that request.', 'Use get_my_proposals to explain what it is waiting on.');
          // The requester's card carries every sibling option; an affected party's carries the options they can pick.
          // A plan outside the envelope reaches a customer only once the owner has approved it (invariant 6).
          const ownerOk = new Set(
            (await tx.select().from(s.approvals).where(and(inArray(s.approvals.revisionId, live.map((r) => r.id)), eq(s.approvals.role, 'owner'), eq(s.approvals.status, 'approved'))))
              .map((a) => a.revisionId),
          );
          const cardIds =
            role === 'requester'
              ? live.map((r) => r.id)
              : live.filter((r) => pending.some((a) => a.revisionId === r.id) && (!r.envelopeTrips.length || ownerOk.has(r.id))).map((r) => r.id);
          if (!cardIds.length) return refuse('INVALID_STATE', 'Nothing on that request can be offered to this customer yet.', 'Say the shop is reviewing it.');
          await tx.insert(s.messages).values({ shopId, conversationId: scope.conversationId, author: 'agent', body: '', cardRevisionIds: cardIds, at: turn.nextAt(idx.snap.now) });
          turn.cardsPosted++;
          const shows = await Promise.all((role === 'requester' ? cardIds.slice(0, 1) : cardIds).map((id) => terms(tx, idx, id, role)));
          const charge = live[0]!.quote.chargeCents;
          const held = (await tx.select().from(s.paypalOrders).where(and(eq(s.paypalOrders.proposalId, p!.id), eq(s.paypalOrders.status, 'authorized')))).length > 0;
          return ok({
            card: 'posted',
            buttons: role === 'requester'
              ? [charge > 0 && !held ? `Accept and authorize ${usd(charge)} with PayPal` : 'Accept', 'Cancel my request']
              : [...shows.map((o) => (o.option ? `Accept option ${o.option}` : 'Accept')), 'Keep my booking as is'],
            shows: role === 'requester' ? { ...shows[0], option: null } : shows,
            hint: role === 'affected'
              ? 'Explain each option in a sentence; mark any needing shop confirmation as pending. If they want none of them, they tap Keep my booking as is and nothing about their booking changes. Never name the other customer.'
              : charge > 0 && !held
                ? 'Tell them to use the card. Authorizing only places a hold: nothing is charged until everything is confirmed, and the hold is released if it does not go ahead.'
                : 'Tell them to use the card.',
          });
        }));
      },
    }),

    tool({
      name: 'ask_owner_fact',
      description: "For an equipment question with no stored answer: asks the shop owner. Tell the customer you're checking.",
      inputSchema: z.object({ subject: z.string().describe('Unit label or model name'), key: z.string(), question: z.string() }),
      run: async ({ subject, key, question }) =>
        db.transaction(async (tx) => {
          const idx = indexSnapshot(await loadSnapshot(tx, shopId));
          const k = snake(key);
          const unit = idx.snap.units.find((u) => u.label.toLowerCase() === subject.toLowerCase().trim());
          const model = idx.snap.models.find((m) => m.name.toLowerCase() === subject.toLowerCase().trim());
          if (!unit && !model) return refuse('NOT_FOUND', 'No such unit or model.', 'Use search_inventory for model names.');
          let fact = unit ? idx.fact(unit.id, k) : idx.snap.facts.find((f) => f.modelId === model!.id && f.key === k);
          if (fact && fact.value !== 'unknown') return refuse('ALREADY_KNOWN', 'This fact is recorded.', 'Answer from it.', { value: fact.value });
          if (!fact)
            [fact] = await tx
              .insert(s.facts)
              .values({ shopId, unitId: unit?.id ?? null, modelId: unit ? null : model!.id, key: k, label: question, value: 'unknown', source: 'agent', setAt: idx.snap.now })
              .returning();
          const [open] = await tx.select().from(s.escalations).where(and(eq(s.escalations.factId, fact!.id), eq(s.escalations.status, 'open')));
          if (!open)
            await tx.insert(s.escalations).values({
              shopId, kind: 'fact_question', factId: fact!.id, conversationId: scope.conversationId, reasons: ['unknown_fact'],
              summary: `${idx.customerName(me)} asks about the ${unit?.label ?? model!.name}: ${question}`, at: idx.snap.now,
            });
          return ok({ asked: true, hint: "The shop will answer; the customer will hear back in a later message. Don't guess in the meantime." });
        }),
    }),

    tool({
      name: 'escalate_to_owner',
      description: 'Hand a judgment call to the shop owner: an upset customer, a request for a person, damage or a dispute, a request still unclear after one clarifying question, or a limit the tools cannot express.',
      inputSchema: z.object({
        reason: z.enum(['upset_customer', 'asks_for_person', 'dispute_or_damage', 'ambiguous_request', 'unsupported_constraint', 'other']),
        summary: z.string().describe('Two or three sentences of context for the owner'),
      }),
      run: async ({ reason, summary }) =>
        db.transaction(async (tx) => {
          const now = (await loadSnapshot(tx, shopId)).now;
          const handoff = ['upset_customer', 'asks_for_person', 'dispute_or_damage'].includes(reason);
          await tx.insert(s.escalations).values({ shopId, kind: handoff ? 'handoff' : 'customer_issue', conversationId: scope.conversationId, reasons: [reason], summary, at: now });
          if (handoff)
            await tx.update(s.conversations).set({ handedOffAt: now, handoffReason: reason, handedBackAt: null }).where(eq(s.conversations.id, scope.conversationId));
          return ok({
            escalated: true, handed_off: handoff,
            hint: handoff ? 'The conversation is now with the shop: send one short message saying a person will reply.' : 'Tell the customer the shop will follow up.',
          });
        }),
    }),

    tool({
      name: 'send_message',
      description: 'The only way to reach the customer; plain reply text is never shown. Every dollar amount must come from a tool result, the context or the policy.',
      inputSchema: z.object({ text: z.string().min(1) }),
      run: async ({ text }) => {
        const unverified = amountsIn(text).filter((c) => !turn.citable.has(c));
        if (unverified.length) {
          await logActivity(db, { shopId, at: scope.now(), actor: 'agent', kind: 'agent_message_blocked', payload: { customerId: me, text, amounts: unverified.map(usd) } });
          return refuse('UNVERIFIED_AMOUNT', `Not sent: ${unverified.map(usd).join(', ')} did not come from a tool.`, 'Remove the amount or get it from a tool, then send again.');
        }
        return turn.inOrder(() => db.transaction(async (tx) => {
          const [conversation] = await tx.select().from(s.conversations).where(eq(s.conversations.id, scope.conversationId));
          const now = (await loadSnapshot(tx, shopId)).now;
          const draft = !!conversation?.handedOffAt;
          await tx.insert(s.messages).values({ shopId, conversationId: scope.conversationId, author: 'agent', body: text, isOwnerDraft: draft, at: turn.nextAt(now) });
          turn.messagesSent++;
          return ok(draft ? { sent: false, saved_as_draft_for_owner: true } : { sent: true });
        }));
      },
    }),
  ];
}

const snake = (key: string) => key.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
