import { chromium } from 'playwright-core';

// Usage: npm run dev (port 5180) in one terminal, then npm run check. Writes PNGs to the given folder.
const OUT = process.argv[2];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const consoleLines = [];
page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => consoleLines.push(`[pageerror] ${e.message}`));

const results = {};
const shot = name => page.screenshot({ path: `${OUT}/${name}.png` });
const log = () => page.locator('[data-testid=log]').innerText();
const wait = ms => page.waitForTimeout(ms);
const box = async sel => (await page.locator(sel).first().boundingBox());
const eventSel = id => `[data-event-id="${id}"]`;

async function dragBy(sel, dx, dy) {
  const b = await box(sel);
  if (!b) return 'no element';
  const x = b.x + Math.min(30, b.width / 2), y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x + (dx * i) / 10, y + (dy * i) / 10);
  await page.mouse.up();
  await wait(700);
  return 'done';
}

async function rowY(resourceId) {
  const b = await box(`.b-grid-row[data-id="${resourceId}"]`);
  return b ? b.y + b.height / 2 : null;
}

await page.goto('http://localhost:5180/');
await page.waitForSelector('.b-sch-event', { timeout: 15000 });
await wait(1000);
await shot('01-initial');

results.q1_events = await page.evaluate(() => window.sched?.eventStore.count);
results.q1_eventEls = await page.locator('.b-sch-event').count();
results.q2_bufferEls = await page.evaluate(() =>
  [...document.querySelectorAll('[class*="buffer"]')].map(e => e.className).slice(0, 4));
results.q3_rangeEls = await page.locator('.b-sch-resourcetimerange').count();
results.q7_unassigned = await page.evaluate(() => {
  const s = window.sched; const r = s.resourceStore.getById('unassigned');
  return { row: !!r, events: r?.events.map(e => e.name) };
});
results.dataEventIds = await page.evaluate(() => [...document.querySelectorAll('[data-event-id]')].map(e => e.dataset.eventId));

// Q8: Vincent is picked up: drag should not move them.
const vincentBefore = await page.evaluate(() => window.sched.eventStore.getById('vincent').startDate.toISOString());
results.q8_dragVincent = await dragBy(eventSel('vincent'), 0, 120);
results.q8_vincentAfter = await page.evaluate(() => ({
  start: window.sched.eventStore.getById('vincent').startDate.toISOString(),
  resource: window.sched.eventStore.getById('vincent').resource.id,
}));
results.q8_vincentStartUnchanged = results.q8_vincentAfter.start === vincentBefore;

// Q8 + Q4: resize Vincent's end into Bob's slot (Thu 10am) → backend → draft.
const vincentBox = await box(`${eventSel('vincent')} .b-sch-event`);
const tick = 150; // px per day
if (vincentBox) {
  const x = vincentBox.x + vincentBox.width - 2, y = vincentBox.y + vincentBox.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  const dx = tick * (16 / 24);
  for (let i = 1; i <= 10; i++) await page.mouse.move(x + (dx * i) / 10, y);
  await page.mouse.up(); await wait(900);
}
results.q4_resizeLog = (await log()).split('\n').slice(0, 3);
await shot('02-vincent-resize');

// Q4: drag Gina (A7IV-2, Sat) to A7RV-1 same time → accept.
const yA7RV = await rowY('A7RV-1'), ginaBox = await box(eventSel('gina'));
if (yA7RV && ginaBox) await dragBy(eventSel('gina'), 0, yA7RV - (ginaBox.y + ginaBox.height / 2));
results.q4_ginaLog = (await log()).split('\n').slice(0, 2);
results.q4_ginaResource = await page.evaluate(() => window.sched.eventStore.getById('gina').resource.id);

// Q4/Q6: drag Charlie (A7IV-2) onto A7IV-3 (maintenance) → red draft.
const yA7IV3 = await rowY('A7IV-3'), charlieBox = await box(eventSel('charlie'));
if (yA7IV3 && charlieBox) await dragBy(eventSel('charlie'), 0, yA7IV3 - (charlieBox.y + charlieBox.height / 2));
results.q4_charlieLog = (await log()).split('\n').slice(0, 2);
results.q4_charlieResource = await page.evaluate(() => window.sched.eventStore.getById('charlie').resource.id);
results.q6_drafts = await page.locator('.b-sch-event.draft').count();
await shot('03-drafts');

// Q6: click Resolve with agent.
const btn = page.locator('.resolve-btn').first();
if (await btn.count()) { await btn.click(); await wait(300); }
results.q6_resolveLog = (await log()).split('\n')[0];

// Q4: refused edit: drag Bob into the past (Mon).
await dragBy(eventSel('bob'), -tick * 3, 0);
results.q4_bobPastLog = (await log()).split('\n').slice(0, 2);

// Q5: ghosts, commit.
await page.getByRole('button', { name: 'Show Plan B ghosts' }).click(); await wait(500);
results.q5_ghostEls = await page.locator('.b-sch-event.ghost').count();
await shot('04-ghosts');
await page.getByRole('button', { name: 'Roll back ghosts' }).click(); await wait(300);
await wait(800); results.q5_ghostsAfterRollback = { dom: await page.locator('.b-sch-event.ghost').count(), store: await page.evaluate(() => window.sched.eventStore.query(e => e.kind === 'ghost').length) };
await page.getByRole('button', { name: 'Show Plan B ghosts' }).click(); await wait(300);
await page.getByRole('button', { name: 'Commit Plan B' }).click(); await wait(500);
results.q5_afterCommit = await page.evaluate(() => ({
  vincentEnd: window.sched.eventStore.getById('vincent').endDate.toString(),
  bobStart: window.sched.eventStore.getById('bob').startDate.toString(),
  ghosts: document.querySelectorAll('.b-sch-event.ghost').length,
}));
await shot('05-committed');

// Q5b: STM.
await page.getByRole('button', { name: 'STM preview + reject' }).click(); await wait(2200);
results.q5b_stmLog = (await log()).split('\n').slice(0, 2);

// Q9: SSE.
await page.getByRole('button', { name: 'Simulate SSE update' }).click(); await wait(500);
results.q9_log = (await log()).split('\n')[0];
results.q9_frankEl = await page.locator(eventSel('frank')).count();
await shot('06-sse');

results.console = consoleLines.filter(l => !l.startsWith('[log] [spike]')).slice(0, 30);
console.log(JSON.stringify(results, null, 2));
await browser.close();
