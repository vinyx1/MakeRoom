// The HTTP API, through Fastify's inject (and one real socket for SSE). PayPal is the stateful fake.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.ts';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema.ts';
import { SESSION_COOKIE, buildApp } from '../src/server/app.ts';
import { cleanupStaleShops, sessionKeyOf } from '../src/server/shops.ts';
import { fakeGateway } from './fake-gateway.ts';

const { db, pool } = createDb();
const gateway = fakeGateway();
const app = buildApp({ db, gateway, paypalClientId: 'test-client-id', ssePollMs: 50 });
afterAll(async () => {
  await app.close();
  await pool.end();
});

/** A browser: keeps its session cookie across requests. */
function visitor() {
  let token: string | undefined;
  const call = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, payload: payload as object, cookies: token ? { [SESSION_COOKIE]: token } : {} });
    const set = res.cookies.find((c) => c.name === SESSION_COOKIE);
    if (set) token = set.value;
    return { status: res.statusCode, body: res.json(), cookieSet: !!set };
  };
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, payload: unknown = {}) => call('POST', url, payload),
    get token() {
      return token;
    },
  };
}

type OwnerView = {
  shop: { now: string; timezone: string };
  customers: { id: string; name: string }[];
  bookings: { id: string; customerId: string; version: number; startsAt: string; endsAt: string; unitId: string }[];
  units: { id: string; label: string }[];
  escalations: { summary: string }[];
  proposals: { id: string; state: string }[];
  activity: { seq: number; kind: string }[];
};

async function owner(v: ReturnType<typeof visitor>) {
  const res = await v.get('/api/owner');
  expect(res.status).toBe(200);
  const view = res.body as OwnerView;
  const customer = (name: string) => view.customers.find((c) => c.name === name)!.id;
  const booking = (name: string) => view.bookings.find((b) => b.customerId === customer(name))!;
  const at = (day: 'Thu' | 'Fri', hour: number) =>
    DateTime.fromISO(view.shop.now, { zone: view.shop.timezone }).startOf('week').plus({ days: day === 'Thu' ? 3 : 4 }).set({ hour }).toUTC().toISO()!;
  return { view, customer, booking, at };
}

describe('sessions', () => {
  it('config needs no session', async () => {
    const v = visitor();
    const res = await v.get('/api/config');
    expect(res.body).toEqual({ paypalClientId: 'test-client-id', currency: 'USD', environment: 'sandbox', sandboxBuyer: null, testCardEnabled: false });
    expect(res.cookieSet).toBe(false);
  });

  it('a first visit gets a cookie and a freshly seeded, prepaid shop; the cookie keeps it', async () => {
    const v = visitor();
    const first = await v.get('/api/owner');
    expect(first.cookieSet).toBe(true);
    expect((first.body as OwnerView).bookings).toHaveLength(7);
    const again = await v.get('/api/owner');
    expect(again.cookieSet).toBe(false);
    expect((again.body as OwnerView).bookings.map((b) => b.id)).toEqual((first.body as OwnerView).bookings.map((b) => b.id));
  });

  it('two visitors get separate shops, and can’t touch each other’s', async () => {
    const [a, b] = [visitor(), visitor()];
    const shopA = await owner(a);
    const shopB = await owner(b);
    expect(shopA.booking('Alice').id).not.toBe(shopB.booking('Alice').id);
    const offered = await a.post('/api/requests', { customerId: shopA.customer('Alice'), request: { kind: 'extend', bookingId: shopA.booking('Alice').id, newEndsAt: shopA.at('Thu', 10) } });
    const intrusion = await b.post(`/api/proposals/${offered.body.proposal.id}/accept`, { customerId: shopA.customer('Alice') });
    expect(intrusion.body).toEqual({ status: 'refused', reason: 'request not found' });
  });

  it('rejects malformed input with 400', async () => {
    const v = visitor();
    const { customer, booking } = await owner(v);
    const res = await v.post('/api/requests', { customerId: customer('Alice'), request: { kind: 'extend', bookingId: booking('Alice').id, newEndsAt: 'thursday-ish' } });
    expect(res.status).toBe(400);
    expect((await v.post('/api/proposals/not-a-uuid/accept', {})).status).toBe(400);
  });
});

describe('Scenario 1 over HTTP', () => {
  it('runs from Alice’s request to commit, with cards rendered by the backend', async () => {
    const v = visitor();
    const { customer, booking, at } = await owner(v);
    const [alice, bob] = [customer('Alice'), customer('Bob')];

    const offered = await v.post('/api/requests', { customerId: alice, request: { kind: 'extend', bookingId: booking('Alice').id, newEndsAt: at('Thu', 10) } });
    expect(offered.body.status).toBe('offered');
    const proposalId: string = offered.body.proposal.id;

    // Alice's card: one offer, $45 held.
    const aliceView = await v.get(`/api/customers/${alice}`);
    expect(aliceView.body.cards).toEqual([
      {
        proposalId, role: 'requester', chargeCents: 4500, heldCents: 0, expiresAt: expect.any(String),
        options: [{
          revisionId: expect.any(String), option: null, needsShop: false, isAlternative: false,
          lines: ['Keep the Sony A7 IV until Thu 10:00am', '$45.00, only charged if it goes ahead', expect.stringContaining('Held on your PayPal account first')],
        }],
      },
    ]);
    expect((await v.get(`/api/customers/${bob}`)).body.cards).toEqual([]); // nothing reaches Bob before Alice pays

    expect((await v.post(`/api/proposals/${proposalId}/order`, { customerId: alice })).body.status).toBe('ok');
    expect((await v.post(`/api/proposals/${proposalId}/accept`, { customerId: alice })).body.status).toBe('awaiting_approvals');

    // Bob's card: two options; B needs the shop.
    const bobCard = (await v.get(`/api/customers/${bob}`)).body.cards[0];
    expect(bobCard.role).toBe('affected');
    expect(bobCard.options.map((o: { option: string; lines: string[]; needsShop: boolean }) => [o.option, o.lines, o.needsShop])).toEqual([
      ['A', ['Free upgrade to the Sony A7R V, same times (Thu 9:00am → Fri 6:00pm)'], false],
      ['B', ['Pickup moves from Thu 9:00am to Thu 2:00pm', '$15.00 refunded to your original payment'], true],
    ]);

    const planB = bobCard.options[1].revisionId;
    expect((await v.post(`/api/proposals/${proposalId}/revisions/${planB}/accept`, { customerId: bob })).body).toEqual({ status: 'awaiting_approvals', waitingOn: ['owner'] });
    const { view } = await owner(v);
    expect(view.escalations.map((e) => e.summary)).toEqual(["Bob's booking shortened by 5h (now Thu 2:00pm → Fri 6:00pm), $15 refund. Net +$30."]);

    const done = await v.post(`/api/proposals/${proposalId}/revisions/${planB}/owner`, { decision: 'approve' });
    expect(done.body.status).toBe('committed');
    const after = await owner(v);
    expect(new Date(after.booking('Bob').startsAt)).toEqual(new Date(at('Thu', 14)));
    expect(after.view.proposals).toEqual([]);
    expect(after.view.escalations).toEqual([]);
  });
});

describe('Scenario 6 over HTTP', () => {
  it('warns on a claimed booking, and the override cancels Alice’s request', async () => {
    const v = visitor();
    const { customer, booking, at } = await owner(v);
    const offered = await v.post('/api/requests', { customerId: customer('Alice'), request: { kind: 'extend', bookingId: booking('Alice').id, newEndsAt: at('Thu', 10) } });
    const proposalId = offered.body.proposal.id;
    await v.post(`/api/proposals/${proposalId}/order`, { customerId: customer('Alice') });
    await v.post(`/api/proposals/${proposalId}/accept`, { customerId: customer('Alice') });

    const bob = booking('Bob');
    const edit = { unitId: bob.unitId, startsAt: at('Thu', 14), endsAt: bob.endsAt, basedOnVersion: bob.version, attestedCustomerIds: [customer('Bob')] };
    const warned = await v.post(`/api/bookings/${bob.id}/edit`, edit);
    expect(warned.body).toMatchObject({ status: 'claimed', proposals: [{ id: proposalId, requesterName: 'Alice' }] });
    const overridden = await v.post(`/api/bookings/${bob.id}/edit`, { ...edit, override: true });
    expect(overridden.body.status).toBe('applied');
    expect(overridden.body.cancelled[0].replan.status).toBe('offered');
  });
});

describe('judge-mode controls', () => {
  it('fast-forward expires a waiting request and voids its hold', async () => {
    const v = visitor();
    const { customer, booking, at } = await owner(v);
    const offered = await v.post('/api/requests', { customerId: customer('Alice'), request: { kind: 'extend', bookingId: booking('Alice').id, newEndsAt: at('Thu', 10) } });
    await v.post(`/api/proposals/${offered.body.proposal.id}/order`, { customerId: customer('Alice') });
    await v.post(`/api/proposals/${offered.body.proposal.id}/accept`, { customerId: customer('Alice') });

    const ff = await v.post('/api/demo/fast-forward', { minutes: 31 });
    expect(ff.body.expired).toEqual([offered.body.proposal.id]);
    // The request is gone; what's left is the closest alternative, offered to the requester.
    expect((await owner(v)).view.proposals.map((p: { id: string; state: string }) => [p.id === offered.body.proposal.id, p.state])).toEqual([[false, 'DRAFT']]);
    expect((await v.post('/api/demo/fast-forward', { minutes: 0 })).status).toBe(400);
  });

  it('reset voids open holds and reseeds the same session', async () => {
    const v = visitor();
    const before = await owner(v);
    const offered = await v.post('/api/requests', { customerId: before.customer('Alice'), request: { kind: 'extend', bookingId: before.booking('Alice').id, newEndsAt: before.at('Thu', 10) } });
    await v.post(`/api/proposals/${offered.body.proposal.id}/order`, { customerId: before.customer('Alice') });
    await v.post(`/api/proposals/${offered.body.proposal.id}/accept`, { customerId: before.customer('Alice') });
    const voidsBefore = gateway.calls.filter((c) => c.method === 'voidAuthorization').length;

    const tokenBefore = v.token;
    const reset = await v.post('/api/demo/reset');
    expect(reset.body.status).toBe('reset');
    expect(v.token).toBe(tokenBefore);
    expect(gateway.calls.filter((c) => c.method === 'voidAuthorization').length).toBe(voidsBefore + 1);

    const after = await owner(v);
    expect(after.view.bookings).toHaveLength(7);
    expect(after.booking('Alice').id).not.toBe(before.booking('Alice').id);
    expect(after.view.proposals).toEqual([]);
  });
});

describe('live activity feed (SSE)', () => {
  it('streams the shop’s activity from a given point, then new events as they happen', async () => {
    const v = visitor();
    const { customer, booking, at } = await owner(v);
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const controller = new AbortController();
    const res = await fetch(`${address}/api/events?after=0`, { headers: { cookie: `${SESSION_COOKIE}=${v.token}` }, signal: controller.signal });
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) text += decoder.decode((await reader.read()).value);
    };
    await readUntil('prepayments_seeded'); // history from seq 0

    await v.post('/api/requests', { customerId: customer('Alice'), request: { kind: 'extend', bookingId: booking('Alice').id, newEndsAt: at('Thu', 10) } });
    await readUntil('proposal_created'); // and live events
    expect(text).toMatch(/id: \d+\nevent: activity\ndata: \{/);
    controller.abort();
  });
});

describe('hosting', () => {
  it('shutting down does not wait for an open SSE stream', async () => {
    const hosted = buildApp({ db, gateway, ssePollMs: 50 });
    const url = await hosted.listen({ port: 0, host: '127.0.0.1' });
    const stream = await fetch(`${url}/api/events`);
    expect(stream.status).toBe(200);
    const closed = await Promise.race([hosted.close().then(() => 'closed'), new Promise((r) => setTimeout(() => r('hung'), 3000))]);
    expect(closed).toBe('closed');
  });

  it('serves the built frontend, without touching a shop', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rentflow-web-'));
    writeFileSync(join(root, 'index.html'), '<title>RentFlow</title>');
    const hosted = buildApp({ db, gateway, webRoot: root });
    const page = await hosted.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('RentFlow');
    expect(page.headers['set-cookie']).toBeUndefined();
    await hosted.close();
    rmSync(root, { recursive: true });
  });
});

describe('protecting the public URL', () => {
  const cookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.find((c) => c.name === SESSION_COOKIE)?.value;

  it('limits new shops per IP, ignoring a forged header, and leaves existing shops alone', async () => {
    const limited = buildApp({ db, gateway, shopsPerIpPerHour: 2, trustedProxies: 1 });
    // Railway's edge appends the visitor's real address last; anything before it came from the visitor.
    const ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
    const visit = (forged: string, cookies = {}) =>
      limited.inject({ method: 'GET', url: '/api/owner', cookies, headers: { 'x-forwarded-for': `${forged}, ${ip}` } });

    const first = await visit('1.1.1.1');
    expect(first.statusCode).toBe(200);
    expect((await visit('2.2.2.2')).statusCode).toBe(200);
    const third = await visit('3.3.3.3');
    expect(third.statusCode).toBe(429);
    expect(third.json().error).toMatch(/Too many new demo shops/);
    const before = (await db.select({ id: s.shops.id }).from(s.shops)).length;
    expect((await visit('4.4.4.4')).statusCode).toBe(429);
    expect((await db.select({ id: s.shops.id }).from(s.shops)).length).toBeLessThanOrEqual(before + 8);

    // The visitor who already has a shop keeps it.
    expect((await visit('1.1.1.1', { [SESSION_COOKIE]: cookieOf(first)! })).statusCode).toBe(200);
    // Someone else on another network isn't affected.
    const other = await limited.inject({ method: 'GET', url: '/api/owner', headers: { 'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}` } });
    expect(other.statusCode).toBe(200);
    await limited.close();
  });

  it('a burst of new visitors from one IP can only make the limit', async () => {
    const limited = buildApp({ db, gateway, shopsPerIpPerHour: 2, trustedProxies: 1 });
    const ip = `192.0.2.${Math.floor(Math.random() * 250) + 1}`;
    const results = await Promise.all(Array.from({ length: 6 }, () => limited.inject({ method: 'GET', url: '/api/owner', headers: { 'x-forwarded-for': ip } })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 429, 429, 429, 429]);
    await limited.close();
  });

  it('limits chat and resets per session, and one session\'s limit doesn\'t touch another', async () => {
    const limited = buildApp({ db, gateway, rateLimit: true });
    const first = await limited.inject({ method: 'GET', url: '/api/owner' });
    const cookies = { [SESSION_COOKIE]: cookieOf(first)! };
    const alice = (first.json() as { customers: { id: string; name: string }[] }).customers.find((c) => c.name === 'Alice')!.id;
    const chat = () => limited.inject({ method: 'POST', url: `/api/customers/${alice}/messages`, cookies, payload: { text: 'hi' } });
    // No agent here, so an accepted message answers 503; the limit answers 429 before that.
    for (let i = 0; i < 20; i++) expect((await chat()).statusCode).toBe(503);
    const over = await chat();
    expect(over.statusCode).toBe(429);
    expect(over.json().error).toMatch(/Too many messages/);

    const second = await limited.inject({ method: 'GET', url: '/api/owner' });
    const bob = (second.json() as { customers: { id: string; name: string }[] }).customers.find((c) => c.name === 'Alice')!.id;
    const other = await limited.inject({ method: 'POST', url: `/api/customers/${bob}/messages`, cookies: { [SESSION_COOKIE]: cookieOf(second)! }, payload: { text: 'hi' } });
    expect(other.statusCode).toBe(503);
    await limited.close();
  });

  it('cleans up shops unseen for 48 hours, voiding holds first, and keeps recent ones', async () => {
    const v = visitor();
    const { customer, booking, at } = await owner(v);
    const offered = await v.post('/api/requests', { customerId: customer('Alice'), request: { kind: 'extend', bookingId: booking('Alice').id, newEndsAt: at('Thu', 10) } });
    await v.post(`/api/proposals/${offered.body.proposal.id}/order`, { customerId: customer('Alice') });
    await v.post(`/api/proposals/${offered.body.proposal.id}/accept`, { customerId: customer('Alice') });
    const shopOf = async (x: ReturnType<typeof visitor>) => (await db.select().from(s.shops).where(eq(s.shops.sessionKey, sessionKeyOf(x.token!))))[0];
    const staleId = (await shopOf(v))!.id;
    const other = visitor();
    await owner(other);
    const before = gateway.calls.length;

    await db.update(s.shops).set({ lastSeenAt: new Date(Date.now() - 49 * 3600_000) }).where(eq(s.shops.id, staleId));
    expect(await cleanupStaleShops(db, gateway)).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(s.shops).where(eq(s.shops.id, staleId))).toEqual([]);
    expect(gateway.calls.slice(before).map((c) => c.method)).toContain('voidAuthorization');
    expect(await shopOf(other)).toBeDefined();

    // Coming back after cleanup gets a new shop, with the same cookie.
    await owner(v);
    expect((await shopOf(v))!.id).not.toBe(staleId);
  });
});
