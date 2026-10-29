// Terminal tester: plays the demo through the real HTTP API, as any customer or the owner, with the live agent.
// Start the server with `npm run dev:test-card`, then `npm run try`. Type `help` for commands.
// The session cookie is kept in server/.try-session, so restarting keeps your shop (`reset` starts it over).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { DateTime } from 'luxon';

const BASE = process.env.RENTFLOW_URL ?? 'http://127.0.0.1:3000';
const SESSION_FILE = new URL('../.try-session', import.meta.url).pathname;
let cookie = existsSync(SESSION_FILE) ? readFileSync(SESSION_FILE, 'utf8').trim() : '';

// --- HTTP ---------------------------------------------------------------------------------------------------

async function api(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) {
    cookie = set.split(';')[0]!;
    writeFileSync(SESSION_FILE, cookie);
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (res.status >= 400) throw new Error(`${res.status} ${JSON.stringify(json)}`);
  return json;
}

// --- Output -------------------------------------------------------------------------------------------------

const c = { dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', magenta: '\x1b[35m', off: '\x1b[0m' };
const rl = createInterface({ input: process.stdin, output: process.stdout });

/** Prints above the prompt without mangling what's being typed. */
function say(text: string) {
  process.stdout.write('\r\x1b[K' + text + '\n');
  rl.prompt(true);
}

// --- State --------------------------------------------------------------------------------------------------

let persona = 'owner'; // 'owner' or a customer name
let owner: any = null;
const seen = new Set<string>(); // message ids already printed
let lastSaveable: { factId: string; value: string; label: string }[] = [];

async function refreshOwner() {
  owner = await api('GET', '/api/owner');
  return owner;
}
const customerByName = (name: string) => owner.customers.find((x: any) => x.name.toLowerCase() === name.toLowerCase());
const nameOf = (id: string) => owner.customers.find((x: any) => x.id === id)?.name ?? 'someone';
const unitLabel = (id: string | null) => owner.units.find((u: any) => u.id === id)?.label ?? 'unassigned';
const modelName = (id: string) => owner.models.find((m: any) => m.id === id)?.name ?? '';
const zone = () => owner.shop.timezone;
const fmt = (iso: string) => DateTime.fromISO(iso, { zone: zone() }).setLocale('en-US').toFormat('ccc h:mma').replace('AM', 'am').replace('PM', 'pm');
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** "Fri 9" or "Fri 9:30" in the demo week → ISO. */
function demoTime(day: string, hm: string) {
  const days: Record<string, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
  const d = days[day.toLowerCase().slice(0, 3)];
  const [h, m] = hm.split(':').map(Number);
  if (d === undefined || Number.isNaN(h)) throw new Error('time must look like: Fri 9 or Fri 9:30');
  return DateTime.fromISO(owner.shop.now, { zone: zone() }).startOf('week').plus({ days: d }).set({ hour: h!, minute: m ?? 0 }).toUTC().toISO()!;
}

// --- Customer side ------------------------------------------------------------------------------------------

async function customerView(name: string) {
  const cust = customerByName(name);
  if (!cust) throw new Error(`no customer called ${name}`);
  return { cust, view: await api('GET', `/api/customers/${cust.id}`) };
}

function printMessage(name: string, m: any) {
  if (seen.has(m.id)) return;
  seen.add(m.id);
  if (m.author === 'customer') return say(`${c.bold}${name}:${c.off} ${m.body}`);
  if (m.cardRevisionIds.length && !m.body) return say(`${c.magenta}  [card posted: type \`cards\` to see it]${c.off}`);
  const who = m.author === 'owner' ? 'Shop owner' : m.author === 'system' ? 'Shop (template)' : 'Assistant';
  say(`${c.cyan}${who}:${c.off} ${m.body}`);
}

async function showChat(name: string, onlyNew = false) {
  const { view } = await customerView(name);
  if (!onlyNew) for (const m of view.messages) seen.delete(m.id);
  for (const m of view.messages) printMessage(name, m);
  if (view.handedOff) say(`${c.yellow}  (conversation handed to the shop)${c.off}`);
}

async function showCards(name: string) {
  const { view } = await customerView(name);
  if (!view.cards.length) return say(`${c.dim}  no cards waiting for ${name}${c.off}`);
  for (const card of view.cards) {
    say(`${c.magenta}${c.bold}  Card (${card.role === 'requester' ? 'your request' : "another customer's request"})${card.expiresAt ? `, expires ${fmt(card.expiresAt)}` : ''}${c.off}`);
    for (const o of card.options) {
      say(`${c.magenta}   ${o.option ? `Option ${o.option}` : 'Offer'}${o.needsShop ? ' (needs shop confirmation)' : ''}${o.isAlternative ? ' (alternative)' : ''}${c.off}`);
      for (const line of o.lines) say(`     ${line}`);
    }
    const labels = card.options.map((o: any) => o.option).filter(Boolean);
    const how =
      card.role === 'requester'
        ? '`accept` to accept' + (card.chargeCents ? ` and pay ${usd(card.chargeCents)} (sandbox test card)` : '')
        : labels.length > 1
          ? `${labels.map((l: string) => `\`pick ${l}\``).join(' or ')} to choose`
          : '`accept` (or `pick`) to accept it';
    say(`${c.dim}   ${how}${c.off}`);
  }
}

async function accept(name: string) {
  const { cust, view } = await customerView(name);
  const card = view.cards.find((x: any) => x.role === 'requester');
  if (!card) {
    // Another customer's request with a single option: accepting it is picking it.
    const affected = view.cards.find((x: any) => x.role === 'affected');
    if (affected?.options.length === 1) return pick(name, '');
    if (affected) return say(`${c.dim}  this card has options: ${affected.options.map((o: any) => `\`pick ${o.option}\``).join(' or ')}${c.off}`);
    return say(`${c.dim}  ${name} has no offer to accept${c.off}`);
  }
  if (card.chargeCents > 0) {
    const order = await api('POST', `/api/proposals/${card.proposalId}/order`, { customerId: cust.id, testCard: true });
    if (order.status !== 'ok') return say(`${c.red}  payment: ${JSON.stringify(order)}${c.off}`);
    say(`${c.green}  paid with the sandbox test card: ${usd(card.chargeCents)} held${c.off}`);
  }
  const r = await api('POST', `/api/proposals/${card.proposalId}/accept`, { customerId: cust.id });
  say(`${c.green}  → ${r.status}${r.reason ? `: ${r.reason}` : ''}${c.off}`);
}

async function pick(name: string, label: string) {
  const { cust, view } = await customerView(name);
  const card = view.cards.find((x: any) => x.role === 'affected');
  if (!card) return say(`${c.dim}  ${name} has no options to pick from; \`cards\` shows what's waiting${c.off}`);
  const options = card.options as any[];
  const option =
    options.find((o) => (o.option ?? '').toLowerCase() === label.toLowerCase()) ??
    (/^\d+$/.test(label) ? options[Number(label) - 1] : undefined) ??
    (options.length === 1 ? options[0] : undefined);
  if (!option) return say(`${c.dim}  no option "${label}"; choose ${options.map((o) => `\`pick ${o.option}\``).join(' or ')}${c.off}`);
  const r = await api('POST', `/api/proposals/${card.proposalId}/revisions/${option.revisionId}/accept`, { customerId: cust.id });
  say(`${c.green}  → ${r.status}${r.waitingOn ? ` (waiting on ${r.waitingOn.join(', ')})` : ''}${r.reason ? `: ${r.reason}` : ''}${c.off}`);
}

// --- Owner side ---------------------------------------------------------------------------------------------

async function inbox() {
  await refreshOwner();
  if (!owner.escalations.length && !owner.drafts.length) return say(`${c.dim}  nothing waiting for the owner${c.off}`);
  owner.escalations.forEach((e: any, i: number) => {
    const facts = factQuestionsOf(e);
    say(`${c.yellow}  ${i + 1}. [${e.kind}] ${e.summary}${c.off}`);
    if (e.revisionId) say(`${c.dim}     \`approve ${i + 1}${facts.length ? ' yes|no' : ''}\` or \`decline ${i + 1}\`${c.off}`);
    else if (e.kind === 'fact_question') say(`${c.dim}     \`answer ${i + 1} yes|no\` (saves the fact)${c.off}`);
  });
  owner.drafts.forEach((d: any, i: number) => {
    const b = owner.bookings.find((x: any) => x.id === d.bookingId);
    say(`${c.red}  draft ${i + 1}: ${nameOf(b?.customerId)}'s booking → ${fmt(d.proposed.startsAt)} – ${fmt(d.proposed.endsAt)} (conflict)  \`resolve ${i + 1}\`${c.off}`);
  });
}

/** Unknown facts the card's plan depends on. */
function factQuestionsOf(e: any) {
  const rev = owner.proposals.flatMap((p: any) => p.revisions).find((r: any) => r.id === e.revisionId);
  return (rev?.factDependencies ?? []).map((id: string) => owner.facts.find((f: any) => f.id === id)).filter((f: any) => f && f.value !== 'yes');
}

async function decide(n: number, decision: 'approve' | 'decline', answer?: string) {
  const e = owner?.escalations[n - 1];
  if (!e?.revisionId) return say(`${c.dim}  no plan card ${n}; type \`inbox\`${c.off}`);
  const facts = factQuestionsOf(e);
  if (decision === 'approve' && facts.length && answer !== 'yes' && answer !== 'no') return say(`${c.dim}  this card asks a fact question: \`approve ${n} yes\` or \`approve ${n} no\`${c.off}`);
  const factAnswers = Object.fromEntries(facts.map((f: any) => [f.id, answer]));
  const r = await api('POST', `/api/proposals/${e.proposalId}/revisions/${e.revisionId}/owner`, { decision, ...(facts.length && answer ? { factAnswers } : {}) });
  say(`${c.green}  → ${r.status}${r.waitingOn ? ` (waiting on ${r.waitingOn.join(', ')})` : ''}${r.reason ? `: ${r.reason}` : ''}${c.off}`);
  lastSaveable = r.saveableFacts ?? [];
  for (const f of lastSaveable) say(`${c.yellow}  Save "${f.label}: ${f.value}" as a fact so I don't ask again? \`save\`${c.off}`);
}

async function edit(name: string, which: 'start' | 'end', day: string, hm: string, flags: string[]) {
  await refreshOwner();
  const cust = customerByName(name);
  const b = owner.bookings.find((x: any) => x.customerId === cust?.id);
  if (!b) return say(`${c.dim}  no active booking for ${name}${c.off}`);
  const time = demoTime(day, hm);
  const body = {
    unitId: b.unitId, startsAt: which === 'start' ? time : b.startsAt, endsAt: which === 'end' ? time : b.endsAt, basedOnVersion: b.version,
    attestedCustomerIds: flags.includes('--phone') ? [cust.id] : [], override: flags.includes('--override'),
  };
  const r = await api('POST', `/api/bookings/${b.id}/edit`, body);
  if (r.status === 'claimed')
    return say(`${c.yellow}  Warning: ${name}'s booking is part of ${r.proposals.map((p: any) => `${p.requesterName}'s pending request`).join(', ')}. Add --override to go ahead.${c.off}`);
  if (r.status === 'draft') return say(`${c.red}  Saved as a red draft: ${r.violations.map((v: any) => v.message).join('; ')}. \`inbox\` then \`resolve 1\`.${c.off}`);
  if (r.status === 'applied') {
    say(`${c.green}  applied: ${name} now ${fmt(r.booking.startsAt)} – ${fmt(r.booking.endsAt)}${c.off}`);
    for (const x of r.cancelled) say(`${c.yellow}  cancelled ${nameOf(x.requesterCustomerId)}'s request; re-plan: ${x.replan?.status ?? 'none'}${c.off}`);
    return;
  }
  say(`${c.red}  ${r.status}: ${r.reason ?? JSON.stringify(r)}${c.off}`);
}

// --- Live feed ----------------------------------------------------------------------------------------------

let verbose = false;

async function follow() {
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/events`, { headers: { cookie } });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const data = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (data) await onActivity(JSON.parse(data.slice(6))).catch(() => {});
        }
      }
    } catch {
      /* server restarting; retry */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function onActivity(a: any) {
  const p = a.payload ?? {};
  const who = p.customerId ? nameOf(p.customerId) : '';
  switch (a.kind) {
    case 'agent_step':
      return say(`${c.dim}  · assistant (${who}) → ${p.tool}${p.ok ? '' : ` ✗ ${p.code}`}${c.off}`);
    case 'agent_turn': {
      say(`${c.dim}  · turn for ${who}: ${(p.ms / 1000).toFixed(1)}s, $${p.costUsd.toFixed(4)}${p.fallback ? `, fallback: ${p.fallback}` : ''}${c.off}`);
      if (who.toLowerCase() === persona.toLowerCase()) return showChat(who, true);
      return say(`${c.cyan}  (new message for ${who}: \`as ${who.toLowerCase()}\`)${c.off}`);
    }
    case 'optimizer_run':
      say(`${c.dim}  · optimizer: ${p.status}, ${p.plans.length} plan(s)${c.off}`);
      for (const pr of p.pruned) say(`${c.dim}      pruned: ${pr.message}${c.off}`);
      return;
    case 'offer_ready':
      return say(`${c.magenta}  · offer ready for ${who}${c.off}`);
    case 'owner_approved':
    case 'owner_declined':
    case 'affected_accepted':
    case 'requester_accepted':
    case 'proposal_created':
      if (verbose) say(`${c.dim}  · ${a.kind}${c.off}`);
      await refreshOwner();
      if (persona === 'owner' && owner.escalations.length) say(`${c.yellow}  (${owner.escalations.length} card(s) for the owner: \`inbox\`)${c.off}`);
      return;
    case 'proposal_committed':
      return say(`${c.green}  · committed: the schedule is updated${c.off}`);
    case 'proposal_ended':
      return say(`${c.yellow}  · request ${p.to}: ${p.reason}${c.off}`);
    default:
      if (a.kind.startsWith('payment_')) return say(`${c.green}  · ${a.kind.replace('_', ' ')}${p.amountCents ? ` ${usd(p.amountCents)}` : ''}${c.off}`);
      if (verbose) say(`${c.dim}  · ${a.kind}${c.off}`);
  }
}

// --- Commands -----------------------------------------------------------------------------------------------

const HELP = `
${c.bold}Who you are${c.off}
  as <name>            be a customer (alice, bob, charlie, dana, eve, gina, hank)
  as owner             be the shop owner
${c.bold}As a customer${c.off}
  <any text>           chat with the assistant
  cards                show the approval cards waiting for you
  accept               accept your offer (pays with the sandbox test card)
  pick A | pick B      choose an option on another customer's request (a single option: \`pick\` or \`accept\`)
  chat                 show the whole conversation
${c.bold}As the owner${c.off}
  inbox                owner cards and red drafts
  approve <n> [yes|no] approve card n (answer its fact question if it asks one)
  decline <n>          decline card n
  save                 save the facts you just answered ("Save as fact")
  answer <n> yes|no    answer a customer's equipment question (saves the fact)
  extend <name> <Day> <H[:MM]> [--phone] [--override]   drag the end of their booking
  move <name> <Day> <H[:MM]> [--phone] [--override]     drag the pickup
  resolve <n>          "Resolve with agent" on red draft n
  reply <name> <text>  write in a customer's chat;  handback <name>  ends a handoff
${c.bold}Anywhere${c.off}
  schedule             everyone's bookings        ff <minutes>  fast-forward the shop clock
  reset                start the demo over        verbose       toggle extra feed lines
  quit
${c.dim}Scenario 1: as alice → "Shoot ran over. Can I keep the camera until Thursday at 10am?" → accept → as bob → cards → pick B → as owner → inbox → approve 1
Scenario 2: as owner → extend dana Fri 9 --phone → inbox → resolve 1 → approve 1 yes → save → as dana → accept → as eve → cards → accept
Scenario 6: Scenario 1 up to Alice's accept → as owner → move bob Thu 14 --phone → again with --override${c.off}
`;

async function run(line: string) {
  const [cmd = '', ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(' ');
  const isOwner = persona === 'owner';
  switch (cmd.toLowerCase()) {
    case '':
      return;
    case 'help':
      return say(HELP);
    case 'quit':
    case 'exit':
      process.exit(0);
    case 'as': {
      await refreshOwner();
      if (arg.toLowerCase() === 'owner') persona = 'owner';
      else if (customerByName(arg)) persona = customerByName(arg).name;
      else return say(`${c.dim}  who? owner, ${owner.customers.map((x: any) => x.name.toLowerCase()).join(', ')}${c.off}`);
      rl.setPrompt(`${c.bold}${persona}>${c.off} `);
      if (!isOwnerName(persona)) await showChat(persona);
      return isOwnerName(persona) ? inbox() : undefined;
    }
    case 'schedule': {
      await refreshOwner();
      for (const b of [...owner.bookings].sort((x: any, y: any) => x.startsAt.localeCompare(y.startsAt)))
        say(`  ${unitLabel(b.unitId).padEnd(9)} ${nameOf(b.customerId).padEnd(8)} ${fmt(b.startsAt)} – ${fmt(b.endsAt)}  ${modelName(b.modelId)}${b.status === 'picked_up' ? ' (picked up)' : ''}`);
      for (const p of owner.proposals) say(`${c.yellow}  pending: ${nameOf(p.requesterCustomerId)}'s request (${p.state})${c.off}`);
      say(`${c.dim}  shop time: ${fmt(owner.shop.now)}${c.off}`);
      return;
    }
    case 'ff': {
      const r = await api('POST', '/api/demo/fast-forward', { minutes: Number(arg) });
      return say(`${c.green}  shop time is now ${fmt(r.now)}${r.expired.length ? `; expired ${r.expired.length} request(s)` : ''}${c.off}`);
    }
    case 'reset':
      say(`${c.dim}  resetting (about 4s: fresh prepayments in the sandbox)…${c.off}`);
      await api('POST', '/api/demo/reset');
      seen.clear();
      await refreshOwner();
      return say(`${c.green}  fresh shop; shop time ${fmt(owner.shop.now)}${c.off}`);
    case 'verbose':
      verbose = !verbose;
      return say(`  verbose ${verbose ? 'on' : 'off'}`);
  }

  if (isOwner) {
    switch (cmd.toLowerCase()) {
      case 'inbox':
        return inbox();
      case 'approve':
        return decide(Number(rest[0]), 'approve', rest[1]?.toLowerCase());
      case 'decline':
        return decide(Number(rest[0]), 'decline');
      case 'save':
        if (!lastSaveable.length) return say(`${c.dim}  nothing to save${c.off}`);
        for (const f of lastSaveable) {
          await api('POST', `/api/facts/${f.factId}`, { value: f.value });
          say(`${c.green}  saved: ${f.label}: ${f.value} (source: owner)${c.off}`);
        }
        lastSaveable = [];
        return;
      case 'answer': {
        const e = owner?.escalations[Number(rest[0]) - 1];
        if (e?.kind !== 'fact_question' || !['yes', 'no'].includes(rest[1] ?? '')) return say(`${c.dim}  \`answer <n> yes|no\` on a fact question; type \`inbox\`${c.off}`);
        await api('POST', `/api/facts/${e.factId}`, { value: rest[1] });
        return say(`${c.green}  saved; the customer will be told${c.off}`);
      }
      case 'extend':
      case 'move':
        return edit(rest[0] ?? '', cmd === 'extend' ? 'end' : 'start', rest[1] ?? '', rest[2] ?? '', rest.slice(3));
      case 'resolve': {
        const d = owner?.drafts[Number(rest[0]) - 1];
        if (!d) return say(`${c.dim}  no draft ${rest[0]}; type \`inbox\`${c.off}`);
        const r = await api('POST', `/api/drafts/${d.id}/resolve`);
        if (r.status !== 'resolved') return say(`${c.red}  ${r.status}: ${r.reason ?? ''}${c.off}`);
        say(`${c.green}  resolved into a request with ${r.revisions.length} plan(s)${c.off}`);
        return inbox();
      }
      case 'reply': {
        const cust = customerByName(rest[0] ?? '');
        if (!cust) return say(`${c.dim}  reply <name> <text>${c.off}`);
        await api('POST', `/api/customers/${cust.id}/owner-message`, { text: rest.slice(1).join(' ') });
        return say(`${c.green}  sent to ${cust.name}${c.off}`);
      }
      case 'handback': {
        const cust = customerByName(rest[0] ?? '');
        if (!cust) return say(`${c.dim}  handback <name>${c.off}`);
        await api('POST', `/api/customers/${cust.id}/hand-back`);
        return say(`${c.green}  the assistant is back on ${cust.name}'s chat${c.off}`);
      }
      default:
        return say(`${c.dim}  owner commands: inbox, approve, decline, save, answer, extend, move, resolve, reply, handback (\`help\`)${c.off}`);
    }
  }

  switch (cmd.toLowerCase()) {
    case 'cards':
      return showCards(persona);
    case 'accept':
      return accept(persona);
    case 'pick':
      return pick(persona, arg);
    case 'chat':
      return showChat(persona);
    default: {
      const cust = customerByName(persona);
      await api('POST', `/api/customers/${cust.id}/messages`, { text: line.trim() });
      seen.clear();
      for (const m of (await customerView(persona)).view.messages) seen.add(m.id); // don't reprint history
      say(`${c.dim}  · sent; the assistant is replying…${c.off}`);
    }
  }
}

const isOwnerName = (p: string) => p === 'owner';

// --- Main ---------------------------------------------------------------------------------------------------

try {
  process.stdout.write(`${c.dim}Connecting to ${BASE} (a first visit seeds your shop, ~4s)…${c.off}\n`);
  await refreshOwner();
  await api('GET', '/api/config');
} catch (e) {
  console.error(`Can't reach the server at ${BASE}: start it with \`npm run dev:test-card\` in server/. (${String(e)})`);
  process.exit(1);
}
say(`${c.bold}RentFlow terminal tester${c.off}  shop time ${fmt(owner.shop.now)}. Type \`help\`.`);
rl.setPrompt(`${c.bold}owner>${c.off} `);
rl.prompt();
void follow();
let busy = Promise.resolve();
rl.on('line', (line) => {
  busy = busy.then(() => run(line)).catch((e) => say(`${c.red}  ${String(e.message ?? e)}${c.off}`)).then(() => rl.prompt());
});
rl.on('close', () => process.exit(0));
