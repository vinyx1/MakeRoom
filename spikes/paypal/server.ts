// Spike backend for the button flow (checks 1 and 9). `node server.ts`, port 5191; Vite proxies /api here.
import { createServer } from 'node:http';
import { authorizeOrder, authOf, captureAuthorization, clientId, createOrder, getAuthorization, voidAuthorization, type Result } from './paypal.ts';

const PORT = 5191;

// One authorization per order: the order id doubles as the idempotency prefix, as proposal:revision would in the app.
const routes: [string, RegExp, (m: RegExpMatchArray) => Promise<[number, unknown]>][] = [
  ['GET', /^\/api\/config$/, async () => [200, { clientId }]],
  ['POST', /^\/api\/orders$/, async () => {
    const r = await createOrder('AUTHORIZE', 4500, 'USD', `btn-${Date.now()}:order`);
    return reply(r, { orderId: r.body?.id });
  }],
  ['POST', /^\/api\/orders\/(\w+)\/authorize$/, async ([, id]) => {
    const r = await authorizeOrder(id, { requestId: `${id}:authorize` });
    const auth = authOf(r.body);
    return reply(r, auth && { authId: auth.id, status: auth.status, amount: auth.amount, expires: auth.expiration_time });
  }],
  ['GET', /^\/api\/authorizations\/(\w+)$/, async ([, id]) => {
    const r = await getAuthorization(id);
    return reply(r, { status: r.body?.status, amount: r.body?.amount });
  }],
  ['POST', /^\/api\/authorizations\/(\w+)\/capture$/, async ([, id]) => {
    const r = await captureAuthorization(id, null, 'USD', { requestId: `${id}:capture` });
    return reply(r, { captureId: r.body?.id, status: r.body?.status, amount: r.body?.amount });
  }],
  ['POST', /^\/api\/authorizations\/(\w+)\/void$/, async ([, id]) => {
    const r = await voidAuthorization(id, { requestId: `${id}:void` });
    return reply(r, { status: r.ok ? 'VOIDED' : undefined });
  }],
];

function reply(r: Result, ok: unknown): [number, unknown] {
  const detail = r.body?.details?.[0];
  return r.ok ? [200, ok] : [r.status, { error: detail?.issue ?? r.body?.name, description: detail?.description ?? r.body?.message, debugId: r.debugId }];
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  for (const [method, pattern, handler] of routes) {
    const m = url.pathname.match(pattern);
    if (req.method !== method || !m) continue;
    try {
      const [status, body] = await handler(m);
      console.log(`${req.method} ${url.pathname} → ${status} ${JSON.stringify(body)}`);
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    } catch (e) {
      console.error(`${req.method} ${url.pathname} → 500`, e);
      res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, () => console.log(`spike server on http://localhost:${PORT}`));
