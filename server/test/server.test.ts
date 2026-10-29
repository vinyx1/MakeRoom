// The HTTP API, through Fastify's inject (and one real socket for SSE). PayPal is the stateful fake.

import { DateTime } from 'luxon';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.ts';
import { SESSION_COOKIE, buildApp } from '../src/server/app.ts';
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
    expect(res.body).toEqual({ paypalClientId: 'test-client-id', currency: 'USD', environment: 'sandbox', sandboxBuyer: null });
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
        proposalId, role: 'requester', chargeCents: 4500, expiresAt: expect.any(String),
        options: [{
          revisionId: expect.any(String), option: null, needsShop: false, isAlternative: false,
          lines: ['Keep the Sony A7 IV until Thu 10:00am', '$45.00, held on PayPal now and charged only when everything is confirmed'],
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
    expect((await owner(v)).view.proposals).toEqual([]);
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
