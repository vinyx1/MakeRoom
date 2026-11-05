// The HTTP API. Thin: parse and check input, find the visitor's shop, call the domain function, return its
// result. Domain outcomes (refused, stale, expired…) come back as 200 with a `status`; bad input is 400.
// Routes act for whoever the role switcher says (owner, Vincent, Bob…): judge mode has no auth beyond the session,
// and every id is checked against the session's shop.

import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { scriptedAnswer } from '../demo/auto-reply.ts';
import { and, eq, gt, inArray, max, sql } from 'drizzle-orm';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import { withShopLock } from '../db/lock.ts';
import * as s from '../db/schema.ts';
import { discardDraft, ownerCancelBooking, ownerEditBooking, undoOwnerEdit } from '../owner/edit-booking.ts';
import type { AgentService } from '../agent/service.ts';
import { conversationOf } from '../agent/turn.ts';
import type { PaymentGateway } from '../payments/gateway.ts';
import { saveFact } from '../owner/facts.ts';
import {
  affectedAccept, affectedRefuse, counterDiscard, counterSend, createRequesterOrder, expireDue, markOverdue, markReturned, ownerDecision, ownerSetPrice, requestChange, requesterAccept,
  requesterCancel, resolveDraft,
} from '../proposals/flow.ts';
import { createRateLimiter, limitFor } from './rate-limit.ts';
import { resetShop, shopForSession, newSessionToken } from './shops.ts';
import { customerView, ownerView } from './views.ts';

type Shop = typeof s.shops.$inferSelect;

declare module 'fastify' {
  interface FastifyRequest {
    shop: Shop;
  }
}

export const SESSION_COOKIE = 'makeroom_session';
/** Which demo shop the visitor has open. It only chooses between that visitor's own shops. */
export const SCENARIO_COOKIE = 'makeroom_scenario';

export type AppOptions = {
  db: Db;
  gateway: PaymentGateway;
  /** PayPal client id for the browser button; public by design (spikes/paypal/FINDINGS.md gotcha 5). */
  paypalClientId?: string;
  /** The PayPal sandbox buyer account, shown beside the PayPal button for judges. Sandbox only, so not a secret. */
  sandboxBuyer?: { email: string; password: string };
  /** Set the cookie's Secure flag (behind HTTPS). */
  secureCookies?: boolean;
  /**
   * Development only: lets the order route pay with the sandbox test card, so a terminal client can accept without
   * the PayPal popup. Never on in production (see main.ts).
   */
  allowTestCard?: boolean;
  /** Runs agent turns for chat messages; without it, the chat routes answer 503. */
  agent?: AgentService;
  /** How often the SSE stream checks for new activity. */
  ssePollMs?: number;
  /** New shops one IP may create per hour; each makes real sandbox payments. Unset: no limit. */
  shopsPerIpPerHour?: number;
  /** Limit chat, payment and reset requests per session (`rate-limit.ts`). */
  rateLimit?: boolean;
  /** How many proxies sit in front of the server, so `req.ip` is the visitor's and a forged header can't change it. */
  trustedProxies?: number;
  /** The built frontend (web/dist), served from `/` in production. In development Vite serves it. */
  webRoot?: string;
  logger?: boolean;
};

const isoDate = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
const id = z.uuid();
const CustomerBody = z.object({ customerId: id });
const RequestBody = z.object({
  customerId: id,
  request: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('extend'), bookingId: id, newEndsAt: isoDate }),
    z.object({ kind: z.literal('shift'), bookingId: id, newStartsAt: isoDate.optional(), newEndsAt: isoDate.optional() }),
    z.object({ kind: z.literal('new_booking'), modelId: id, startsAt: isoDate, endsAt: isoDate }),
  ]),
});
const OwnerDecisionBody = z.object({
  decision: z.enum(['approve', 'decline']),
  /** Answers to the plan's unknown facts, by fact id (demo Scenario 2). */
  factAnswers: z.record(z.uuid(), z.enum(['yes', 'no'])).optional(),
});
const EditBody = z.object({
  unitId: id,
  startsAt: isoDate,
  endsAt: isoDate,
  basedOnVersion: z.number().int().positive(),
  attestedCustomerIds: z.array(id).default([]),
  override: z.boolean().default(false),
});
const TextBody = z.object({ text: z.string().trim().min(1).max(2000) });
const CustomerParams = z.object({ customerId: id });
const FastForwardBody = z.object({ minutes: z.number().int().min(1).max(7 * 24 * 60) });
const ProposalParams = z.object({ proposalId: id });
const RevisionParams = z.object({ proposalId: id, revisionId: id });

class BadRequest extends Error {
  issues: unknown;
  constructor(issues: unknown) {
    super('bad request');
    this.issues = issues;
  }
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new BadRequest(z.treeifyError(r.error));
  return r.data;
}

export function buildApp(opts: AppOptions) {
  const { db, gateway } = opts;
  // Close open connections on shutdown: the SSE stream never ends by itself, so a browser tab would hold it up forever.
  const app = Fastify({ logger: opts.logger ?? false, forceCloseConnections: true, trustProxy: opts.trustedProxies ? (_addr: string, hop: number) => hop < opts.trustedProxies! : false });
  const limiter = createRateLimiter();
  app.register(cookie);
  if (opts.webRoot) app.register(fastifyStatic, { root: opts.webRoot, redirect: true }); // /demo → /demo/
  app.decorateRequest('shop', null as unknown as Shop);
  app.decorateRequest('sessionToken', '');
  const newShopLimit = (req: FastifyRequest) => (opts.shopsPerIpPerHour ? { ip: req.ip, perHour: opts.shopsPerIpPerHour } : undefined);

  // Every /api route except config acts on the visitor's own shop, seeded on first visit.
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/config')) return;
    let token = req.cookies[SESSION_COOKIE];
    if (!token || !/^[\w-]{43}$/.test(token)) {
      token = newSessionToken();
      reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: opts.secureCookies ?? false, maxAge: 7 * 24 * 3600 });
    }
    req.sessionToken = token;
    const scenario = isScenario(req.cookies[SCENARIO_COOKIE]) ? req.cookies[SCENARIO_COOKIE] : 'camera';
    req.shop = await shopForSession(db, gateway, token, newShopLimit(req), scenario);
    // Cleanup deletes shops nobody has opened lately. Hourly is precise enough for a 48-hour window.
    if (Date.now() - req.shop.lastSeenAt.getTime() > 3600_000)
      await db.update(s.shops).set({ lastSeenAt: new Date() }).where(eq(s.shops.id, req.shop.id));

    const limit = opts.rateLimit && req.method === 'POST' ? limitFor(req.routeOptions.url ?? '') : null;
    if (limit && !limiter.allow(`${req.shop.id}:${limit.name}`, limit.max, limit.windowMs))
      return reply.code(429).send({ error: limit.message });
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof BadRequest) return reply.code(400).send({ error: 'bad_request', issues: err.issues });
    req.log.error(err);
    // Fastify's own client errors (bad JSON, wrong content type) keep their 4xx.
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    return reply.code(500).send({ error: 'internal_error' });
  });

  app.get('/api/config', async () => ({
    paypalClientId: opts.paypalClientId ?? null,
    currency: 'USD',
    environment: 'sandbox',
    sandboxBuyer: opts.sandboxBuyer ?? null,
    /** Development only: the UI may offer "pay with the sandbox test card" instead of the PayPal popup. */
    testCardEnabled: !!opts.allowTestCard,
  }));

  // --- Views ------------------------------------------------------------------------------------------------

  app.get('/api/owner', async (req) => db.transaction((tx) => ownerView(tx, req.shop.id)));

  app.get('/api/customers/:customerId', async (req, reply) => {
    const { customerId } = parse(CustomerBody, req.params);
    const view = await db.transaction((tx) => customerView(tx, req.shop.id, customerId));
    return view ?? reply.code(404).send({ error: 'not_found' });
  });

  // --- Customer actions -------------------------------------------------------------------------------------

  app.post('/api/requests', async (req) => {
    const { customerId, request } = parse(RequestBody, req.body);
    return requestChange(db, req.shop.id, {
      customerId,
      request: request.kind === 'new_booking' ? { ...request, customerId } : request,
    });
  });

  // The PayPal button's createOrder: returns the order id the button approves.
  app.post('/api/proposals/:proposalId/order', async (req, reply) => {
    const { proposalId } = parse(ProposalParams, req.params);
    const { customerId, testCard } = parse(CustomerBody.extend({ testCard: z.boolean().optional() }), req.body);
    if (testCard && !opts.allowTestCard) return reply.code(403).send({ error: 'test_card_disabled' });
    return createRequesterOrder(db, gateway, req.shop.id, { proposalId, customerId, testCard });
  });

  // The PayPal button's onApprove, or Accept when nothing is owed.
  app.post('/api/proposals/:proposalId/accept', async (req) => {
    const { proposalId } = parse(ProposalParams, req.params);
    const { customerId } = parse(CustomerBody, req.body);
    return requesterAccept(db, gateway, req.shop.id, { proposalId, customerId });
  });

  app.post('/api/proposals/:proposalId/revisions/:revisionId/accept', async (req) => {
    const { proposalId, revisionId } = parse(RevisionParams, req.params);
    const { customerId } = parse(CustomerBody, req.body);
    return affectedAccept(db, gateway, req.shop.id, { proposalId, customerId, revisionId });
  });

  // A customer's own counter-offer: Send is their approval of it (docs/conflict-model.md §4).
  app.post('/api/proposals/:proposalId/revisions/:revisionId/send', async (req) => {
    const { proposalId, revisionId } = parse(RevisionParams, req.params);
    const { customerId } = parse(CustomerBody, req.body);
    return counterSend(db, gateway, req.shop.id, { proposalId, customerId, revisionId });
  });

  app.post('/api/proposals/:proposalId/revisions/:revisionId/discard', async (req) => {
    const { proposalId, revisionId } = parse(RevisionParams, req.params);
    const { customerId } = parse(CustomerBody, req.body);
    return counterDiscard(db, req.shop.id, { proposalId, customerId, revisionId });
  });

  // "Keep my booking as is" (affected party) and "Cancel my request" (requester): refusals are clicks too.
  // Judge mode: the customer answers their own offer, from a button on their card.
  app.post('/api/proposals/:proposalId/scripted-answer', async (req) => {
    const { proposalId } = req.params as { proposalId: string };
    const { customerId } = parse(z.object({ customerId: z.string().uuid() }), req.body);
    return (await scriptedAnswer(db, gateway, { shopId: req.shop.id, customerId, proposalId })) ?? { status: 'already_decided' };
  });

  app.post('/api/proposals/:proposalId/keep', async (req) => {
    const { proposalId } = parse(ProposalParams, req.params);
    const { customerId } = parse(CustomerBody, req.body);
    return affectedRefuse(db, gateway, req.shop.id, { proposalId, customerId });
  });

  app.post('/api/proposals/:proposalId/cancel', async (req) => {
    const { proposalId } = parse(ProposalParams, req.params);
    const { customerId } = parse(CustomerBody, req.body);
    return requesterCancel(db, gateway, req.shop.id, { proposalId, customerId });
  });

  // --- Chat -------------------------------------------------------------------------------------------------

  /** Finds the customer in the session's shop, or answers 404. */
  async function customerOf(req: FastifyRequest, reply: FastifyReply) {
    const { customerId } = parse(CustomerParams, req.params);
    const [customer] = await db.select().from(s.customers).where(and(eq(s.customers.id, customerId), eq(s.customers.shopId, req.shop.id)));
    if (!customer) reply.code(404).send({ error: 'not_found' });
    return customer;
  }

  // The customer types; the agent answers in the background, and its steps and messages arrive over SSE.
  app.post('/api/customers/:customerId/messages', async (req, reply) => {
    const customer = await customerOf(req, reply);
    if (!customer) return reply;
    const { text } = parse(TextBody, req.body);
    if (!opts.agent) return reply.code(503).send({ error: 'agent_unavailable' });
    const { message } = await opts.agent.customerMessage(req.shop.id, customer.id, text);
    return reply.code(202).send({ status: 'accepted', messageId: message.id });
  });

  // The owner writes in a customer's thread (after a handoff, or any time).
  app.post('/api/customers/:customerId/owner-message', async (req, reply) => {
    const customer = await customerOf(req, reply);
    if (!customer) return reply;
    const { text } = parse(TextBody, req.body);
    const at = new Date(Date.now() + req.shop.clockOffsetMs);
    const conversation = await conversationOf(db, req.shop.id, customer.id, at);
    const [message] = await db.insert(s.messages).values({ shopId: req.shop.id, conversationId: conversation.id, author: 'owner', body: text, at }).returning();
    await db.insert(s.activityLog).values({ shopId: req.shop.id, at, actor: 'owner', kind: 'owner_message', payload: { customerId: customer.id, text } });
    // The owner has stepped in, so the assistant stops talking over them until they hand the chat back.
    if (!conversation.handedOffAt) {
      await db.update(s.conversations).set({ handedOffAt: at, handoffReason: 'owner_replied', handedBackAt: null }).where(eq(s.conversations.id, conversation.id));
      await db.insert(s.activityLog).values({ shopId: req.shop.id, at, actor: 'owner', kind: 'owner_took_over', payload: { customerId: customer.id } });
    }
    return { status: 'sent', messageId: message!.id };
  });

  // Ends a handoff: the agent resumes messaging this customer (judge D11).
  app.post('/api/customers/:customerId/hand-back', async (req, reply) => {
    const customer = await customerOf(req, reply);
    if (!customer) return reply;
    const at = new Date(Date.now() + req.shop.clockOffsetMs);
    await db.update(s.conversations).set({ handedOffAt: null, handedBackAt: at }).where(eq(s.conversations.customerId, customer.id));
    await db.insert(s.activityLog).values({ shopId: req.shop.id, at, actor: 'owner', kind: 'handed_back', payload: { customerId: customer.id } });
    return { status: 'ok' };
  });

  // --- Owner actions ----------------------------------------------------------------------------------------

  app.post('/api/proposals/:proposalId/revisions/:revisionId/owner', async (req) => {
    const { proposalId, revisionId } = parse(RevisionParams, req.params);
    const { decision, factAnswers } = parse(OwnerDecisionBody, req.body);
    return ownerDecision(db, gateway, req.shop.id, { proposalId, revisionId, decision, factAnswers });
  });

  // The owner sets what the requester pays, before they've paid (an owner modification: a new revision).
  app.post('/api/proposals/:proposalId/price', async (req) => {
    const { proposalId } = parse(ProposalParams, req.params);
    const { priceCents } = parse(z.object({ priceCents: z.number().int().min(0) }), req.body);
    return ownerSetPrice(db, req.shop.id, { proposalId, priceCents });
  });

  // "Resolve with agent" on a red draft.
  app.post('/api/drafts/:draftId/resolve', async (req) => {
    const { draftId } = parse(z.object({ draftId: id }), req.params);
    const { agreedByPhone } = parse(z.object({ agreedByPhone: z.boolean().default(false) }), req.body ?? {});
    return resolveDraft(db, req.shop.id, { draftId, agreedByPhone });
  });

  app.post('/api/drafts/:draftId/discard', async (req) => {
    const { draftId } = parse(z.object({ draftId: id }), req.params);
    return discardDraft(db, req.shop.id, { draftId });
  });

  // "Save as fact": the owner's answer is stored, so the question isn't asked again.
  app.post('/api/facts/:factId', async (req) => {
    const { factId } = parse(z.object({ factId: id }), req.params);
    const { value } = parse(z.object({ value: z.enum(['yes', 'no']) }), req.body);
    return saveFact(db, req.shop.id, { factId, value });
  });

  app.post('/api/bookings/:bookingId/edit', async (req) => {
    const { bookingId } = parse(z.object({ bookingId: id }), req.params);
    const body = parse(EditBody, req.body);
    return ownerEditBooking(db, gateway, req.shop.id, { bookingId, ...body });
  });

  // A late return: re-plan the next renters around the expected time.
  app.post('/api/bookings/:bookingId/cancel', async (req) => {
    const { bookingId } = parse(z.object({ bookingId: id }), req.params);
    const body = parse(z.object({ basedOnVersion: z.number().int().positive(), agreedByPhone: z.boolean().default(false), override: z.boolean().default(false) }), req.body);
    return ownerCancelBooking(db, gateway, req.shop.id, { bookingId, ...body });
  });

  app.post('/api/bookings/:bookingId/overdue', async (req) => {
    const { bookingId } = parse(z.object({ bookingId: id }), req.params);
    const { expectedReturnAt } = parse(z.object({ expectedReturnAt: isoDate }), req.body);
    return markOverdue(db, gateway, req.shop.id, { bookingId, expectedReturnAt });
  });

  app.post('/api/bookings/:bookingId/returned', async (req) => {
    const { bookingId } = parse(z.object({ bookingId: id }), req.params);
    return markReturned(db, gateway, req.shop.id, { bookingId });
  });

  app.post('/api/bookings/:bookingId/undo', async (req) => {
    const { bookingId } = parse(z.object({ bookingId: id }), req.params);
    return undoOwnerEdit(db, req.shop.id, { bookingId });
  });

  // --- Judge-mode controls ----------------------------------------------------------------------------------

  app.post('/api/demo/reset', async (req) => {
    const shop = await resetShop(db, gateway, req.shop.id);
    return { status: 'reset', shopId: shop.id };
  });

  // Opens the visitor's other demo shop, seeding it here so the switch waits rather than the next page load.
  app.post('/api/demo/scenario', async (req, reply) => {
    const { scenario } = parse(z.object({ scenario: z.enum(SCENARIOS) }), req.body);
    const shop = await shopForSession(db, gateway, req.sessionToken, newShopLimit(req), scenario);
    reply.setCookie(SCENARIO_COOKIE, scenario, { path: '/', httpOnly: true, sameSite: 'lax', secure: opts.secureCookies ?? false, maxAge: 7 * 24 * 3600 });
    return { status: 'switched', scenario, name: shop.name };
  });

  // Judge mode: scripted customers answer affected-party offers by themselves.
  app.post('/api/demo/auto-reply', async (req) => {
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    await db.update(s.shops).set({ autoReplyCustomers: enabled }).where(eq(s.shops.id, req.shop.id));
    await db.insert(s.activityLog).values({ shopId: req.shop.id, at: new Date(Date.now() + req.shop.clockOffsetMs), actor: 'owner', kind: 'auto_reply_toggled', payload: { enabled } });
    return { status: 'ok', enabled };
  });

  app.post('/api/demo/fast-forward', async (req) => {
    const { minutes } = parse(FastForwardBody, req.body);
    const shopId = req.shop.id;
    const now = await withShopLock(db, shopId, async (tx) => {
      const [shop] = await tx
        .update(s.shops)
        .set({ clockOffsetMs: sql`${s.shops.clockOffsetMs} + ${minutes * 60_000}` })
        .where(eq(s.shops.id, shopId))
        .returning();
      const at = new Date(Date.now() + shop!.clockOffsetMs);
      await tx.insert(s.activityLog).values({ shopId, at, actor: 'owner', kind: 'clock_fast_forwarded', payload: { minutes } });
      return at;
    });
    const expired = await expireDue(db, gateway, shopId);
    return { status: 'ok', now, expired };
  });

  // --- Live activity feed (SSE) -----------------------------------------------------------------------------

  // Streams the shop's activity log from `Last-Event-ID` (or `?after=`), else from now. Polls the table: one
  // process, a handful of shops, and it survives restarts with nothing to wire up.
  app.get('/api/events', async (req, reply) => {
    const shopId = req.shop.id;
    const query = parse(z.object({ after: z.coerce.number().int().nonnegative().optional() }), req.query);
    const header = Number(req.headers['last-event-id']);
    let after = Number.isFinite(header) && header > 0 ? header : query.after;
    if (after === undefined) {
      const [row] = await db.select({ seq: max(s.activityLog.seq) }).from(s.activityLog).where(eq(s.activityLog.shopId, shopId));
      after = row?.seq ?? 0;
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    let open = true;
    req.raw.on('close', () => (open = false));
    let lastWrite = Date.now();
    while (open) {
      const rows = await db
        .select()
        .from(s.activityLog)
        .where(and(eq(s.activityLog.shopId, shopId), gt(s.activityLog.seq, after)))
        .orderBy(s.activityLog.seq)
        .limit(200);
      for (const row of rows) {
        res.write(`id: ${row.seq}\nevent: activity\ndata: ${JSON.stringify(row)}\n\n`);
        after = row.seq;
        lastWrite = Date.now();
      }
      if (Date.now() - lastWrite > 15_000) {
        res.write(': ping\n\n');
        lastWrite = Date.now();
      }
      await new Promise((r) => setTimeout(r, opts.ssePollMs ?? 500));
    }
    res.end();
  });

  return app;
}

/** Expires overdue proposals in every shop that has one waiting. Run on an interval (approval timeouts). */
export async function sweepExpiries(db: Db, gateway: PaymentGateway) {
  const rows = await db
    .selectDistinct({ shopId: s.proposals.shopId })
    .from(s.proposals)
    .where(inArray(s.proposals.state, ['DRAFT', 'AWAITING_APPROVALS']));
  const expired: string[] = [];
  for (const { shopId } of rows) expired.push(...(await expireDue(db, gateway, shopId)));
  return expired;
}
