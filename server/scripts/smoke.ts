// Checks a deployed MakeRoom from the outside: `npm run smoke -- https://your-app.up.railway.app`.
// Costs one new shop (7 sandbox captures), one reset (7 more) and one agent turn (about 2 cents).
// It can't click PayPal's popup, so the buyer approving a payment stays a manual check.

import { DateTime } from 'luxon';

const base = process.argv[2]?.replace(/\/$/, '');
if (!base) {
  console.error('Usage: npm run smoke -- <url>');
  process.exit(2);
}

let cookie = '';
let failures = 0;

async function step(name: string, run: () => Promise<string | void>) {
  const t0 = Date.now();
  try {
    const detail = await run();
    console.log(`  ok    ${name}${detail ? `: ${detail}` : ''} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return true;
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}: ${(e as Error).message}`);
    return false;
  }
}

function must(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function api(method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.getSetCookie().find((c) => c.startsWith('makeroom_session='));
  if (set) cookie = set.split(';')[0]!;
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, set };
}

type Owner = { shop: { now: string; timezone: string }; bookings: { id: string; customerId: string }[]; customers: { id: string; name: string }[] };
let owner: Owner | undefined;

console.log(`Checking ${base}`);

await step('page and frontend code load', async () => {
  const page = await api('GET', '/');
  must(page.status === 200 && page.text.includes('<title>MakeRoom</title>'), `page answered ${page.status}`);
  const asset = page.text.match(/assets\/[^"]+\.js/)?.[0];
  must(asset, 'no script in the page');
  const js = await fetch(`${base}/${asset}`);
  must(js.status === 200, `${asset} answered ${js.status}`);
});

await step('config: PayPal set, test card off', async () => {
  const { json } = await api('GET', '/api/config');
  must(json?.paypalClientId, 'no PayPal client id');
  must(json.testCardEnabled === false, 'the test card is ON');
  must(json.sandboxBuyer, 'no sandbox buyer login');
  must(json.environment === 'sandbox', `PayPal environment is ${json.environment}`);
});

const seeded = await step('new visitor gets a shop at Wed 5:30pm', async () => {
  const res = await api('GET', '/api/owner');
  must(res.status === 200, `answered ${res.status}: ${res.text.slice(0, 200)}`);
  must(/HttpOnly/i.test(res.set ?? '') && /Secure/i.test(res.set ?? ''), 'session cookie is not Secure and HttpOnly');
  owner = res.json as Owner;
  must(owner.bookings.length === 7, `${owner.bookings.length} bookings`);
  const now = DateTime.fromISO(owner.shop.now, { zone: owner.shop.timezone });
  must(now.weekday === 3 && now.hour === 17, `the clock says ${now.toFormat('ccc h:mma')}`);
});

if (seeded && owner) {
  const shop = owner;
  const vincent = shop.customers.find((c) => c.name === 'Vincent')!.id;

  await step('live updates connect', async () => {
    const stream = new AbortController();
    const res = await fetch(`${base}/api/events`, { headers: { cookie }, signal: stream.signal });
    must(res.status === 200 && res.headers.get('content-type')?.includes('text/event-stream'), `answered ${res.status}`);
    const first = await res.body!.getReader().read();
    must(new TextDecoder().decode(first.value).includes('connected'), 'no first event');
    stream.abort();
  });

  await step('the agent answers a chat message', async () => {
    const sent = await api('POST', `/api/customers/${vincent}/messages`, { text: 'What are your shop hours?' });
    must(sent.status === 202, `answered ${sent.status}: ${sent.text.slice(0, 200)}`);
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const { json } = await api('GET', `/api/customers/${vincent}`);
      const reply = (json.messages as { author: string; body: string }[]).findLast((m) => m.author !== 'customer' && m.body);
      if (reply) {
        must(reply.author === 'agent', `a template answered instead of the model: "${reply.body}"`);
        return reply.body.slice(0, 60);
      }
    }
    throw new Error('no reply within 60 seconds');
  });

  await step('a request gets an offer, and PayPal makes an order', async () => {
    const thu10 = DateTime.fromISO(shop.shop.now, { zone: shop.shop.timezone }).plus({ days: 1 }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
    const booking = shop.bookings.find((b) => b.customerId === vincent)!;
    const offered = await api('POST', '/api/requests', { customerId: vincent, request: { kind: 'extend', bookingId: booking.id, newEndsAt: thu10.toISO() } });
    must(offered.json?.status === 'offered', `request answered ${offered.text.slice(0, 200)}`);
    const order = await api('POST', `/api/proposals/${offered.json.proposal.id}/order`, { customerId: vincent });
    must(order.status === 200 && order.json?.orderId, `order answered ${order.text.slice(0, 200)}`);
    return `$${offered.json.chargeCents / 100}`;
  });

  await step('reset starts the shop over', async () => {
    const reset = await api('POST', '/api/demo/reset');
    must(reset.status === 200, `answered ${reset.status}`);
    const after = await api('GET', '/api/owner');
    must(after.json?.bookings?.length === 7, 'no fresh shop after the reset');
  });
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed. The PayPal popup still needs a manual check.');
process.exit(failures ? 1 : 0);
