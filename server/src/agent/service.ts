// When agent turns run (docs/agent-tools.md "Events that start a turn"). Customer messages start one directly;
// backend events are read from the activity log, so every path that changes a proposal (clicks, owner edits,
// the expiry sweep) reaches customers the same way. Turns for one customer run one at a time, in order.

import { and, asc, eq, gt, inArray, max } from 'drizzle-orm';
import { logActivity } from '../activity.ts';
import type { Db } from '../db/client.ts';
import * as s from '../db/schema.ts';
import { type AgentConfig, type AgentEvent, type TurnReport, conversationOf, runTurn } from './turn.ts';

const TRIGGERS = ['offer_ready', 'proposal_update', 'proposal_ended', 'fact_answered', 'affected_refused', 'fallback_planned'] as const;

export function createAgentService(
  db: Db,
  config: AgentConfig,
  log: (msg: string) => void = () => {},
  /** Only dispatch events of this shop (tests, which share one database across parallel files). */
  scope: { shopId?: string } = {},
  /** Judge mode: called after an affected customer's offer turn, to let a scripted customer answer it. */
  autoReply?: (offer: { shopId: string; customerId: string; proposalId: string; revisionIds: string[] }) => Promise<unknown>,
) {
  const queues = new Map<string, Promise<unknown>>();
  const pending = new Set<Promise<unknown>>();
  let cursor: number | null = null;
  let timer: NodeJS.Timeout | null = null;
  let polling = false;

  /** Runs a turn after any earlier turn for the same customer finishes. */
  function enqueue(shopId: string, customerId: string, event: AgentEvent): Promise<TurnReport | null> {
    const key = `${shopId}:${customerId}`;
    const run = (queues.get(key) ?? Promise.resolve())
      .then(() => runTurn(db, config, { shopId, customerId, event }, (line) => log(`[agent ${customerId.slice(0, 8)}] ${line}`)))
      .catch((e) => {
        log(`agent turn failed: ${String(e)}`);
        return null;
      });
    queues.set(key, run);
    pending.add(run);
    void run.finally(() => {
      pending.delete(run);
      if (queues.get(key) === run) queues.delete(key);
    });
    return run;
  }

  /** A customer typed in the chat: store it, then answer it. */
  async function customerMessage(shopId: string, customerId: string, text: string) {
    const [shop] = await db.select().from(s.shops).where(eq(s.shops.id, shopId));
    const at = new Date(Date.now() + shop!.clockOffsetMs);
    const conversation = await conversationOf(db, shopId, customerId, at);
    const [message] = await db.insert(s.messages).values({ shopId, conversationId: conversation.id, author: 'customer', body: text, at }).returning();
    await logActivity(db, { shopId, at, actor: `customer:${customerId}`, kind: 'customer_message', payload: { customerId, text } });
    return { message: message!, turn: enqueue(shopId, customerId, { kind: 'customer_message', text }) };
  }

  /** Reads new trigger events from the activity log and starts the turns they call for. */
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      if (cursor === null) {
        const [row] = await db.select({ seq: max(s.activityLog.seq) }).from(s.activityLog);
        cursor = row?.seq ?? 0;
      }
      const rows = await db
        .select()
        .from(s.activityLog)
        .where(and(gt(s.activityLog.seq, cursor), inArray(s.activityLog.kind, [...TRIGGERS]), ...(scope.shopId ? [eq(s.activityLog.shopId, scope.shopId)] : [])))
        .orderBy(asc(s.activityLog.seq))
        .limit(100);
      for (const row of rows) {
        cursor = row.seq;
        // Claim the event first: another server process on the same database may be reading it too.
        const claimed = await db.insert(s.agentDispatches).values({ activitySeq: row.seq }).onConflictDoNothing().returning();
        if (!claimed.length) continue;
        for (const [customerId, event] of await eventsFor(row)) {
          const turn = enqueue(row.shopId, customerId, event);
          if (autoReply && event.kind === 'offer_ready' && event.role === 'affected') {
            const reply = turn
              .then(() => autoReply({ shopId: row.shopId, customerId, proposalId: event.proposalId, revisionIds: event.revisionIds }))
              .catch((e) => log(`auto-reply failed: ${String(e)}`));
            pending.add(reply);
            void reply.finally(() => pending.delete(reply));
          }
        }
      }
    } finally {
      polling = false;
    }
  }

  async function eventsFor(row: typeof s.activityLog.$inferSelect): Promise<[string, AgentEvent][]> {
    const payload = row.payload as Record<string, unknown>;
    if (row.kind === 'fact_answered')
      return [[payload.customerId as string, { kind: 'owner_answered', factId: payload.factId as string, value: payload.value as 'yes' | 'no' }]];
    const proposalId = row.proposalId;
    if (!proposalId) return [];
    if (row.kind === 'offer_ready')
      return [[payload.customerId as string, {
        kind: 'offer_ready', proposalId, revisionIds: payload.revisionIds as string[],
        role: payload.role === 'requester' ? 'requester' : 'affected', replanOf: (payload.replanOf as string) ?? null, repriced: !!payload.repriced,
        fallback: !!payload.fallback, holdReleased: !!payload.holdReleased,
      }]];
    if (row.kind === 'affected_refused') return [[payload.customerId as string, { kind: 'kept_booking', proposalId }]];
    // The shop is trying another plan: the requester hears their request is still on, and their hold stands.
    if (row.kind === 'fallback_planned') {
      const [p] = await db.select().from(s.proposals).where(eq(s.proposals.id, proposalId));
      return p?.requesterCustomerId ? [[p.requesterCustomerId, { kind: 'request_progress', proposalId }]] : [];
    }
    if (row.kind === 'proposal_update')
      return [[payload.customerId as string, { kind: 'proposal_update', proposalId, outcome: 'COMMITTED' }]];
    // An ended request reaches its requester and everyone who was asked about it, except those who kept their
    // booking: they were told already.
    const [p] = await db.select().from(s.proposals).where(eq(s.proposals.id, proposalId));
    const asked = await db.selectDistinct({ customerId: s.approvals.customerId }).from(s.approvals).where(eq(s.approvals.proposalId, proposalId));
    const kept = new Set((await db.select().from(s.proposalExclusions).where(eq(s.proposalExclusions.proposalId, proposalId))).map((e) => e.customerId));
    const parties = new Set([p?.requesterCustomerId, ...asked.map((a) => a.customerId)].filter((x): x is string => !!x && (x === p?.requesterCustomerId || !kept.has(x))));
    const event: AgentEvent = { kind: 'proposal_update', proposalId, outcome: payload.to as 'REJECTED', reason: (payload.reason as string) ?? null };
    return [...parties].map((c) => [c, event]);
  }

  return {
    enqueue,
    customerMessage,
    poll,
    start(intervalMs = 1000) {
      timer = setInterval(() => void poll().catch((e) => log(`agent dispatcher: ${String(e)}`)), intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** Waits until every queued turn has finished (tests, shutdown). */
    async drain() {
      while (pending.size) await Promise.all([...pending]);
    },
  };
}

export type AgentService = ReturnType<typeof createAgentService>;
