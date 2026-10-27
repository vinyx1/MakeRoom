// Customer-scope tools from docs/agent-tools.md §3, built per turn as closures bound to one customer.
// The model never passes the customer or shop; any id outside the scope is NOT_FOUND.
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import {
  addHours, COMP_CAP_CENTS, DISCOUNT_BAND_PCT, MODELS, SHOP_CLOSE, SHOP_OPEN, BUFFER_HOURS, display, time, usd, type World,
} from './world.ts';

export const MAX_TOOL_CALLS = 12;

/** Per-turn state the backend keeps while the agent runs. */
export class Turn {
  toolCalls: { name: string; input: unknown; result: any; ms: number }[] = [];
  allowedCents = new Set<number>(); // every dollar amount the agent has seen from tools, context or policy
  offersPresented = 0;
  customer: string;
  onStep: (line: string) => void;
  constructor(customer: string, onStep: (line: string) => void) {
    this.customer = customer;
    this.onStep = onStep;
  }

  allow(text: string) {
    for (const c of amountsIn(text)) this.allowedCents.add(c);
  }
}

const MONEY = /\$\s?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?/g;
export function amountsIn(text: string): number[] {
  return [...text.matchAll(MONEY)].map(m => Number(m[1].replace(/,/g, '')) * 100 + Number((m[2] ?? '0').padEnd(2, '0')));
}

const ok = (body: object) => JSON.stringify({ ok: true, ...body });
const refuse = (code: string, message: string, hint?: string, extra: object = {}) => JSON.stringify({ ok: false, code, message, hint, ...extra });
const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).describe('Shop-local time, YYYY-MM-DDTHH:MM, resolved with the calendar in the context');

export function makeTools(world: World, turn: Turn) {
  const me = turn.customer;

  // Every tool goes through this: call cap, activity feed, and harvesting amounts for the money lint.
  const tool = <S extends z.ZodType>(def: { name: string; description: string; inputSchema: S; run: (input: z.infer<S>) => string }) =>
    betaZodTool({
      ...def,
      run: async (input: z.infer<S>) => {
        const t0 = Date.now();
        let result: string;
        if (turn.toolCalls.length >= MAX_TOOL_CALLS) result = refuse('OVER_LIMIT', `Tool call limit (${MAX_TOOL_CALLS}) reached for this turn.`, 'Send one final message and stop.');
        else result = def.run(input);
        if (def.name !== 'send_message') turn.allow(result);
        turn.toolCalls.push({ name: def.name, input, result: JSON.parse(result), ms: Date.now() - t0 });
        turn.onStep(`${def.name}(${JSON.stringify(input)}) → ${result.length > 160 ? result.slice(0, 160) + '…' : result}`);
        return result;
      },
    });

  const myProposalIds = () => world.proposals.filter(p => p.requester === me || p.revisions.some(r => r.affected?.customer === me)).map(p => p.id);
  const findRevision = (id: string) => world.proposals.flatMap(p => p.revisions).find(r => r.id === id && myProposalIds().includes(r.proposalId));

  return [
    tool({
      name: 'get_my_bookings',
      description: "The customer's own bookings: id, model, unit, times, status, price paid, and whether a request currently involves it.",
      inputSchema: z.object({}),
      run: () => ok({
        bookings: world.bookingsOf(me).map(b => ({
          booking_id: b.id, model: MODELS.find(m => m.id === b.model)!.name, unit: b.unit,
          pickup: time(b.start), return: time(b.end), status: b.status, price_paid: usd(b.priceCents),
          active_request: !!world.activeProposalFor(b.id),
        })),
      }),
    }),

    tool({
      name: 'search_inventory',
      description: 'Models the shop carries, with daily rates and substitutes. Text match on name and category; omit query to list everything.',
      inputSchema: z.object({ query: z.string().optional() }),
      run: ({ query }) => {
        const q = query?.toLowerCase().trim();
        const hits = MODELS.filter(m => !q || `${m.name} ${m.category}`.toLowerCase().includes(q));
        return ok({
          models: hits.map(m => ({ model_id: m.id, name: m.name, category: m.category, daily_rate: usd(m.rateCents), substitutes: m.substitutes.map(s => MODELS.find(x => x.id === s)!.name) })),
          ...(hits.length ? {} : { note: 'No match. The shop carries only the models listed by an empty query.' }),
        });
      },
    }),

    tool({
      name: 'get_fact',
      description: 'An equipment fact for a unit or model: yes, no or unknown. Never guess a fact this tool does not return as yes or no.',
      inputSchema: z.object({ subject: z.string().describe('Unit label (A7IV-1) or model name'), key: z.string().describe('snake_case attribute, e.g. weather_sealed') }),
      run: ({ subject, key }) => {
        const f = world.facts.find(x => x.subject.toLowerCase() === subject.toLowerCase() && x.key === key);
        return ok({ subject, key, value: f?.value ?? 'unknown', source: f?.source ?? null, ...(f?.value === 'yes' || f?.value === 'no' ? {} : { hint: 'Unknown: use ask_owner_fact and tell the customer you will check with the shop.' }) });
      },
    }),

    tool({
      name: 'get_policy',
      description: 'Shop rules: hours, turnaround buffer, cancellation refunds, what the assistant may discount, approval timeout.',
      inputSchema: z.object({}),
      run: () => ok({
        shop_hours: `${SHOP_OPEN}am–${SHOP_CLOSE - 12}pm daily; pickups and returns only within them`,
        turnaround_buffer_hours: BUFFER_HOURS,
        cancellation: 'Full refund 24h or more before pickup; 50% within 24h',
        assistant_discount_limit: `${DISCOUNT_BAND_PCT}% off a quote; anything more needs the shop`,
        compensation_cap: `${usd(COMP_CAP_CENTS)} per customer without the shop`,
        approval_timeout_minutes: 30,
        billing: 'Per started 24h at the daily rate',
      }),
    }),

    tool({
      name: 'get_my_proposals',
      description: "Active requests involving the customer, as requester or affected party: state, current terms from this customer's side, and who it is waiting on (anonymous).",
      inputSchema: z.object({}),
      run: () => ok({
        proposals: world.proposals.filter(p => myProposalIds().includes(p.id)).map(p => ({
          proposal_id: p.id, role: p.requester === me ? 'requester' : 'affected', state: p.state,
          waiting_on: p.pendingFrom.map(c => (c === me ? 'you' : 'another customer')),
          revisions: p.revisions.map(r => world.view(r, me)),
        })),
      }),
    }),

    tool({
      name: 'request_change',
      description: "Ask to change one of the customer's own bookings. Only extensions are supported in this build. Creates a request; prices come back as offers, nothing is confirmed until every party agrees.",
      inputSchema: z.object({ booking_id: z.string(), change: z.object({ type: z.literal('extend'), new_end: localTime }) }),
      run: ({ booking_id, change }) => JSON.stringify(world.extend(me, booking_id, change.new_end)),
    }),

    tool({
      name: 'revise_terms',
      description: "A counter-offer from this customer on a request they are part of: the requester may ask for a different price; an affected customer may ask for a different pickup time or compensation. Records nothing for the customer until they click Send on the card.",
      inputSchema: z.object({
        proposal_id: z.string(),
        new_price_usd: z.number().optional().describe('Requester only: the price they are asking for'),
        new_pickup: localTime.optional().describe('Affected customer only'),
        compensation_usd: z.number().optional().describe('Affected customer only: the compensation they are asking for'),
      }),
      run: ({ proposal_id, new_price_usd, new_pickup, compensation_usd }) => {
        const p = world.proposals.find(x => x.id === proposal_id && myProposalIds().includes(x.id));
        if (!p) return refuse('NOT_FOUND', 'No such request for this customer.');
        const isRequester = p.requester === me;
        if (isRequester && (new_pickup || compensation_usd !== undefined)) return refuse('INVALID_STATE', 'The requester can only change their own price.');
        if (!isRequester && new_price_usd !== undefined) return refuse('INVALID_STATE', "An affected customer can't change the requester's price.");
        if (new_pickup) {
          const earliest = addHours(p.newEnd, BUFFER_HOURS);
          const bad = world.checkTime(new_pickup);
          if (bad) return refuse(bad.code, 'That time is outside shop hours or in the past.', `Offer ${display(bad.nearest)} instead.`);
          if (new_pickup < earliest) return refuse('INFEASIBLE', `The unit isn't free until ${display(earliest)} (return plus the ${BUFFER_HOURS}h turnaround).`, `No new revision. Explain and offer ${display(earliest)}.`, { nearest: time(earliest) });
        }
        const base = p.revisions[p.revisions.length - 1];
        const needsOwner: string[] = [];
        let price = base.requesterPriceCents;
        if (new_price_usd !== undefined) {
          price = Math.round(new_price_usd * 100);
          const floor = Math.round(base.requesterPriceCents * (1 - DISCOUNT_BAND_PCT / 100));
          if (price < floor) needsOwner.push('discount_over_band');
        }
        const comp = compensation_usd !== undefined ? Math.round(compensation_usd * 100) : base.affected?.compensationCents ?? 0;
        if (comp > COMP_CAP_CENTS) needsOwner.push('compensation_over_cap');
        const rv = { ...base, id: world.id('rv'), option: null, status: needsOwner.length ? 'needs_owner' as const : 'offered' as const, requesterPriceCents: price,
          affected: base.affected && { ...base.affected, compensationCents: comp, change: new_pickup ? `Pickup moves to ${display(new_pickup)}` : base.affected.change },
          needsOwner: [...base.needsOwner, ...needsOwner] };
        p.revisions.push(rv);
        world.events.push({ kind: 'revision_created', id: rv.id, needsOwner: rv.needsOwner });
        return ok({ revision: world.view(rv, me), hint: needsOwner.length
          ? `Beyond what the assistant can agree (${needsOwner.join(', ')}): sent to the shop. Tell the customer it needs shop confirmation; do not promise it.`
          : 'Call present_offer with this revision so the customer can click Send.' });
      },
    }),

    tool({
      name: 'present_offer',
      description: 'Post an approval card in this conversation for one revision, or two sibling options. The card shows the terms; the customer decides by clicking its buttons. At most once per turn.',
      inputSchema: z.object({ revision_ids: z.array(z.string()).min(1).max(2) }),
      run: ({ revision_ids }) => {
        if (turn.offersPresented >= 1) return refuse('OVER_LIMIT', 'Only one card per turn.');
        const revs = revision_ids.map(findRevision);
        if (revs.some(r => !r)) return refuse('NOT_FOUND', 'Unknown revision for this customer.');
        if (new Set(revs.map(r => r!.proposalId)).size > 1) return refuse('INVALID_STATE', 'Options on one card must belong to one request.');
        const p = world.proposals.find(x => x.id === revs[0]!.proposalId)!;
        if (!p.pendingFrom.includes(me)) return refuse('INVALID_STATE', 'This customer has no pending decision on that request.', 'Use get_my_proposals to explain what it is waiting on.');
        turn.offersPresented++;
        const role = p.requester === me ? 'requester' : 'affected';
        world.events.push({ kind: 'card_posted', to: me, revisionIds: revision_ids, role });
        return ok({ card: 'posted', buttons: role === 'requester' ? ['Accept and authorize with PayPal', 'Not now'] : [...revs.map(r => `Accept option ${r!.option ?? ''}`.trim()), 'Keep my booking as is'],
          shows: revs.map(r => world.view(r!, me)) });
      },
    }),

    tool({
      name: 'ask_owner_fact',
      description: "For an equipment question with no stored answer: asks the shop. Tell the customer you're checking.",
      inputSchema: z.object({ subject: z.string(), key: z.string(), question: z.string() }),
      run: ({ subject, key, question }) => {
        const f = world.facts.find(x => x.subject.toLowerCase() === subject.toLowerCase() && x.key === key);
        if (f && f.value !== 'unknown') return refuse('ALREADY_KNOWN', 'This fact is already recorded.', undefined, { value: f.value });
        world.events.push({ kind: 'fact_question', subject, key, question, from: me });
        return ok({ asked: true, hint: "The shop will answer; you'll be told in a later turn." });
      },
    }),

    tool({
      name: 'escalate_to_owner',
      description: 'Hand a judgment call to the shop owner: upset customer, asks for a person, damage or dispute, a request still unclear after one clarifying question, or anything else outside these tools.',
      inputSchema: z.object({
        reason: z.enum(['upset_customer', 'asks_for_person', 'dispute_or_damage', 'ambiguous_request', 'unsupported_constraint', 'other']),
        summary: z.string().describe('Short context for the owner'),
      }),
      run: ({ reason, summary }) => {
        world.events.push({ kind: 'escalation', reason, summary, from: me });
        const handoff = ['upset_customer', 'asks_for_person', 'dispute_or_damage'].includes(reason);
        return ok({ escalated: true, handed_off: handoff, hint: handoff ? 'The conversation is now with the shop. Send one short message saying a person will reply.' : 'Tell the customer the shop will follow up.' });
      },
    }),

    tool({
      name: 'send_message',
      description: 'The only way to reach the customer; plain reply text is discarded. Every dollar amount must come from a tool result, the context or the policy.',
      inputSchema: z.object({ text: z.string() }),
      run: ({ text }) => {
        const unverified = amountsIn(text).filter(c => !turn.allowedCents.has(c));
        if (unverified.length) {
          world.events.push({ kind: 'message_blocked', to: me, text, amounts: unverified.map(usd) });
          return refuse('UNVERIFIED_AMOUNT', `Not sent: ${unverified.map(usd).join(', ')} did not come from a tool.`, 'Remove the amount or get it from a tool, then send again.');
        }
        world.events.push({ kind: 'message_sent', to: me, text });
        return ok({ sent: true });
      },
    }),
  ];
}

