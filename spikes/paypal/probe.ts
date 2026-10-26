// Quick probe: can the server authorize a sandbox card in USD with no buyer click?
import { authOf, createCardOrder } from './paypal.ts';

const currency = process.argv[2] ?? 'USD';
const r = await createCardOrder('AUTHORIZE', 4500, currency, { requestId: `probe-${Date.now()}` });
const auth = authOf(r.body);
console.log(JSON.stringify({ status: r.status, orderStatus: r.body?.status, auth: auth && { id: auth.id, status: auth.status, amount: auth.amount, expires: auth.expiration_time }, error: r.ok ? undefined : r.body, debugId: r.debugId }, null, 2));
