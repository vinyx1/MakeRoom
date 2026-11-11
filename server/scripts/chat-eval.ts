// Runs the free-form chat prompts in `evals/chat-prompts.md` against a local server and writes what the assistant said
// and did to `evals/results/chat-<time>.md`, for a person to grade against each row's "A good reply".
// Start the server with `npm run dev:test-card` (the `held` setup pays with the sandbox test card), then
// `npm run eval:chat` for every row, or `npm run eval:chat -- A2 C4` for some. Each row gets its own fresh shop.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DateTime } from 'luxon';

const BASE = process.env.MAKEROOM_URL ?? 'http://127.0.0.1:3000';
const ROOT = new URL('../../', import.meta.url);
const PARALLEL = 4;

type Row = { id: string; as: string; setup: 'none' | 'offer' | 'held'; messages: string[]; good: string };

function rows(): Row[] {
  const md = readFileSync(new URL('evals/chat-prompts.md', ROOT), 'utf8');
  return md
    .split('\n')
    .filter((l) => /^\| [A-Z]\d+ \|/.test(l))
    .map((l) => {
      const [id, as, setup, messages, good] = l.split('|').slice(1, -1).map((c) => c.trim());
      return { id: id!, as: as!, setup: setup as Row['setup'], messages: messages!.split(' // '), good: good! };
    });
}

/** One visitor: a session cookie, so one fresh demo shop. */
class Visitor {
  cookie = '';
  async api(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie().find((c) => c.startsWith('makeroom_session='));
    if (set) this.cookie = set.split(';')[0]!;
    const json = await res.json().catch(() => null);
    if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
    return json;
  }

  /** Waits until no customer has an agent turn pending and the activity log has been still for a moment. */
  async settle(timeoutMs = 90_000) {
    const start = Date.now();
    let last = -1;
    let stillSince = Date.now();
    while (Date.now() - start < timeoutMs) {
      const owner = await this.api('GET', '/api/owner');
      const top = owner.activity[0]?.seq ?? 0;
      if (top !== last) [last, stillSince] = [top, Date.now()];
      const busy = owner.customers.some((c: any) => typing(owner.activity, c.id));
      if (!busy && Date.now() - stillSince > 2500) return owner;
      await new Promise((r) => setTimeout(r, 700));
    }
    throw new Error('the assistant was still working after 90s');
  }
}

/** The same rule as the web app's typing indicator (`web/src/live.ts`). */
function typing(activity: any[], customerId: string) {
  const mine = (a: any) => a.payload?.customerId === customerId;
  const lastTurn = activity.find((a) => a.kind === 'agent_turn' && mine(a));
  const lastTrigger = activity.find((a) => mine(a) && ['customer_message', 'agent_step', 'offer_ready', 'proposal_update', 'fact_answered'].includes(a.kind));
  return !!lastTrigger && (!lastTurn || lastTurn.seq < lastTrigger.seq);
}

async function setUp(v: Visitor, row: Row) {
  const owner = await v.settle();
  const id = (name: string) => owner.customers.find((c: any) => c.name === name)!.id as string;
  if (row.setup === 'none') return owner;
  const vincent = id('Vincent');
  const booking = owner.bookings.find((b: any) => b.customerId === vincent);
  const zone = owner.shop.timezone;
  const thursday10 = DateTime.fromISO(booking.endsAt, { zone }).plus({ days: 1 }).set({ hour: 10, minute: 0 });
  await v.api('POST', '/api/requests', { customerId: vincent, request: { kind: 'extend', bookingId: booking.id, newEndsAt: thursday10.toISO() } });
  await v.settle();
  if (row.setup === 'held') {
    const view = await v.api('GET', `/api/customers/${vincent}`);
    const card = view.cards.find((c: any) => c.role === 'requester');
    if (!card) throw new Error('setup: Vincent has no offer card');
    await v.api('POST', `/api/proposals/${card.proposalId}/order`, { customerId: vincent, testCard: true });
    await v.api('POST', `/api/proposals/${card.proposalId}/accept`, { customerId: vincent });
  }
  return v.settle();
}

type Result = { row: Row; replies: { from: string; text: string }[]; tools: string[]; elsewhere: string[]; notes: string[]; error?: string; seconds: number };

async function run(row: Row): Promise<Result> {
  const t0 = Date.now();
  const v = new Visitor();
  const out: Result = { row, replies: [], tools: [], elsewhere: [], notes: [], seconds: 0 };
  try {
    let owner = await setUp(v, row);
    const me = owner.customers.find((c: any) => c.name === row.as)!;
    const before = owner.activity[0]?.seq ?? 0;
    const seenMessages = new Set<string>();
    for (const c of owner.conversations) for (const m of c.messages) seenMessages.add(m.id);
    for (const text of row.messages) {
      out.replies.push({ from: row.as, text });
      await v.api('POST', `/api/customers/${me.id}/messages`, { text });
      owner = await v.settle();
      for (const conv of owner.conversations) {
        for (const m of [...conv.messages].sort((a: any, b: any) => a.at.localeCompare(b.at) || 0)) {
          if (seenMessages.has(m.id) || m.author === 'customer') continue;
          seenMessages.add(m.id);
          const who = owner.customers.find((c: any) => c.id === conv.customerId)?.name;
          const body = `${m.body}${m.cardRevisionIds?.length ? ' [card]' : ''}`;
          if (who === row.as) out.replies.push({ from: m.author === 'agent' ? 'Assistant' : m.author, text: body });
          else out.elsewhere.push(`${who}: ${body}`);
        }
      }
    }
    for (const a of [...owner.activity].reverse()) {
      if (a.seq <= before) continue;
      if (a.kind === 'agent_step') out.tools.push(`${a.payload.tool}${a.payload.ok ? '' : ` ✗ ${a.payload.code}`}`);
      else if (a.kind === 'agent_turn' && a.payload.customerId === me.id)
        out.notes.push(
          `turn ${(a.payload.ms / 1000).toFixed(1)}s $${Number(a.payload.costUsd).toFixed(3)}${a.payload.nudged ? ' nudged' : ''}${a.payload.fallback ? ` fallback: ${a.payload.fallback}` : ''}${a.payload.error ? ` error: ${a.payload.error}` : ''}`,
        );
      else if (['agent_message_blocked', 'fact_question', 'proposal_created', 'request_corrected', 'proposal_ended'].includes(a.kind)) out.notes.push(`${a.kind}${a.kind === 'agent_message_blocked' ? `: ${JSON.stringify(a.payload).slice(0, 160)}` : ''}`);
    }
  } catch (e) {
    out.error = (e as Error).message;
  }
  out.seconds = (Date.now() - t0) / 1000;
  return out;
}

const wanted = process.argv.slice(2);
const all = rows().filter((r) => !wanted.length || wanted.includes(r.id));
console.log(`Running ${all.length} prompt${all.length === 1 ? '' : 's'} against ${BASE}, ${PARALLEL} at a time`);
const results: Result[] = [];
const queue = [...all];
await Promise.all(
  Array.from({ length: PARALLEL }, async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      const r = await run(row);
      results.push(r);
      console.log(`  ${r.error ? 'ERROR' : 'done '} ${row.id} (${r.seconds.toFixed(0)}s)${r.error ? `: ${r.error}` : ''}`);
    }
  }),
);
results.sort((a, b) => all.indexOf(a.row) - all.indexOf(b.row));

const md = [
  `# Chat eval, ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
  '',
  `Server: ${BASE}. Grade each against "A good reply" in \`evals/chat-prompts.md\`.`,
  '',
  ...results.flatMap((r) => [
    `## ${r.row.id} · ${r.row.as} · setup ${r.row.setup}`,
    '',
    `**Good reply:** ${r.row.good}`,
    '',
    ...(r.error ? [`**Error:** ${r.error}`, ''] : []),
    ...r.replies.map((m) => `> **${m.from}:** ${m.text.replaceAll('\n', '\n> ')}\n>`),
    '',
    `Tools: ${r.tools.join(', ') || 'none'}`,
    ...(r.notes.length ? [`Notes: ${r.notes.join('; ')}`] : []),
    ...(r.elsewhere.length ? [`**Sent to others:** ${r.elsewhere.join(' | ')}`] : []),
    '',
  ]),
].join('\n');
mkdirSync(new URL('evals/results/', ROOT), { recursive: true });
const file = new URL(`evals/results/chat-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`, ROOT);
writeFileSync(file, md);
console.log(`Report: ${file.pathname}`);
