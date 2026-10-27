// Scenario 1 as agent turns (docs/agent-tools.md §7): `node scenario.ts [haiku|sonnet|opus]`.
import { runTurn, type ModelName } from './agent.ts';
import { World } from './world.ts';

const model = (process.argv[2] ?? 'haiku') as ModelName;
const world = new World();
const feed = (who: string) => (line: string) => console.log(`  ${who} ${line}`);

async function turn(customer: string, event: Parameters<typeof runTurn>[0]['event']) {
  console.log(`\n▶ ${customer}: ${event.kind === 'customer_message' ? JSON.stringify(event.text) : `event ${event.kind}`}`);
  const r = await runTurn({ world, customer, event, model, onStep: feed(customer.padEnd(5)) });
  for (const e of world.events.splice(0)) console.log(`  ⇒ ${JSON.stringify(e)}`);
  console.log(`  ⏱ ${(r.ms / 1000).toFixed(1)}s, ${r.requests} requests, ${r.toolCalls.length} tool calls, tokens in/out/cacheW/cacheR ${r.usage.input}/${r.usage.output}/${r.usage.cacheWrite}/${r.usage.cacheRead}, $${r.costUsd.toFixed(4)}`);
  return r;
}

const results = [];
results.push(await turn('alice', { kind: 'customer_message', text: 'Shoot ran over. Can I keep the camera until Thursday at 10am?' }));

const proposal = world.proposals[0];
if (proposal) {
  world.requesterAuthorizes(proposal.id); // Alice clicks Accept and authorizes $45 with PayPal
  console.log(`\n(Alice accepts and authorizes; ${proposal.id} → ${proposal.state})`);
  results.push(await turn('bob', { kind: 'offer_ready', proposalId: proposal.id }));
  results.push(await turn('bob', { kind: 'customer_message', text: 'Hmm, could I pick it up at noon instead?' }));
}

const total = results.reduce((s, r) => ({ ms: s.ms + r.ms, cost: s.cost + r.costUsd }), { ms: 0, cost: 0 });
console.log(`\nTotal (${model}): ${(total.ms / 1000).toFixed(1)}s, $${total.cost.toFixed(4)}`);
