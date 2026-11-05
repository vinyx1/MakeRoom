// The landing page. No framework: a schedule fragment drawn from the demo's real numbers, one control in the hero, and
// a how-to whose stage follows the step being read. Every figure here comes from the optimizer on the demo seed.

import './landing.css';

/** Hours from Wednesday midnight; the fragment shows Wed, Thu and Fri. */
const DAY = 24;
const SPAN = 3 * DAY;
const BUFFER = 4;

type Kind = 'booked' | 'out' | 'ghost' | 'grey';
type Bar = { name: string; row: number; start: number; end: number; kind: Kind; hidden?: boolean; noBuffer?: boolean };
type Bars = Record<string, Bar>;

function schedule(root: HTMLElement, rows: string[]) {
  // The other bookings sit on whichever row carries their unit's label.
  const fixed: Bars = {
    charlie: { name: 'Charlie', row: rows.indexOf('A7IV-2'), start: 33, end: 66, kind: 'booked' },
    maintenance: { name: 'maintenance', row: rows.indexOf('A7IV-3'), start: 9, end: 69, kind: 'grey', noBuffer: true },
  };
  root.innerHTML = `
    <div class="sched-units">${rows.map((r) => `<span>${r}</span>`).join('')}</div>
    <div class="sched-plot">
      <div class="sched-days"><span>Wed</span><span>Thu</span><span>Fri</span></div>
      <div class="sched-rows">${rows.map(() => '<i></i>').join('')}<u class="now" style="--at:${17.5 / SPAN}"></u></div>
    </div>`;
  const lane = root.querySelector<HTMLElement>('.sched-rows')!;
  const els = new Map<string, { bar: HTMLElement; buffer: HTMLElement }>();
  return (bars: Bars) => {
    for (const [id, b] of Object.entries({ ...fixed, ...bars })) {
      let el = els.get(id);
      if (!el) {
        const bar = document.createElement('b');
        const buffer = document.createElement('s');
        lane.append(buffer, bar);
        el = { bar, buffer };
        els.set(id, el);
        // Bars start where they're first drawn, then slide from there.
      }
      el.bar.className = `bar ${b.kind} ${b.hidden ? 'off' : ''}`;
      el.bar.textContent = b.name;
      place(el.bar, b.row, b.start, b.end);
      el.buffer.className = `buffer ${b.hidden || b.noBuffer ? 'off' : ''}`;
      place(el.buffer, b.row, b.end, Math.min(b.end + BUFFER, SPAN));
    }
  };
}

function place(el: HTMLElement, row: number, start: number, end: number) {
  el.style.setProperty('--row', String(row));
  el.style.left = `${(Math.max(start, 0) / SPAN) * 100}%`;
  el.style.width = `${((Math.min(end, SPAN) - Math.max(start, 0)) / SPAN) * 100}%`;
}

const vincent = (end: number, extended = true): Bars => ({
  vincent: { name: 'Vincent', row: 0, start: 0, end: 18, kind: 'out', noBuffer: end > 18 },
  vincentMore: { name: end > 18 ? `+${end - 18}h` : '', row: 0, start: 18, end, kind: extended ? 'out' : 'ghost', hidden: end <= 18 },
});
const bob = (row: number, start: number, kind: Kind = 'booked'): Bars => ({ bob: { name: 'Bob', row, start, end: 66, kind } });

// ---- The hero's one control: three return times, each with what the optimizer really returns for it. ---------------

const OUTCOMES = {
  wed: { bars: { ...vincent(21), ...bob(0, 33) }, pay: '$0.00', bob: 'Nothing changes', net: '$0.00' },
  thu: { bars: { ...vincent(34), ...bob(0, 38) }, pay: '$45.00', bob: 'Picks up at 2pm, $15.00 back', net: '+$30.00' },
  fri: { bars: { ...vincent(58), ...bob(3, 33) }, pay: '$90.00', bob: 'Free upgrade to the Sony A7R V', net: '+$50.00' },
} as const;

const drawHero = schedule(document.getElementById('hero-sched')!, ['A7IV-1', 'A7IV-2', 'A7IV-3', 'A7RV-1']);
const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-choice]')];
let touched = false;

function choose(key: keyof typeof OUTCOMES) {
  const o = OUTCOMES[key];
  drawHero(o.bars);
  document.getElementById('o-pay')!.textContent = o.pay;
  document.getElementById('o-bob')!.textContent = o.bob;
  document.getElementById('o-net')!.textContent = o.net;
  for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.choice === key));
}

for (const b of buttons)
  b.addEventListener('click', () => {
    touched = true;
    choose(b.dataset.choice as keyof typeof OUTCOMES);
  });

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Opens at the moment before anything moved, then Bob's booking slides over: the page's name, acted out.
drawHero({ ...vincent(18), ...bob(0, 33) });
for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.choice === 'thu'));
window.setTimeout(() => {
  if (!touched) choose('thu');
}, reducedMotion ? 0 : 900);

// ---- How to use: the stage follows the step being read. -------------------------------------------------------------

// Like the real schedule, the unit in contention gets a second lane for what's proposed on it.
const STAGE_ROWS = ['A7IV-1', '', 'A7IV-2', 'A7IV-3', 'A7RV-1'];
const LANE = 1;
const A7RV = 4;
const more = (shown: boolean, kind: Kind = 'ghost'): Bar => ({ name: '+16h', row: kind === 'ghost' ? LANE : 0, start: 18, end: 34, kind, hidden: !shown });
const planA = (shown: boolean): Bar => ({ name: 'Plan A: Bob', row: A7RV, start: 33, end: 66, kind: 'ghost', hidden: !shown });
const planB = (shown: boolean): Bar => ({ name: 'Plan B: Bob', row: LANE, start: 38, end: 66, kind: 'ghost', hidden: !shown });
const base: Bars = { vincent: { name: 'Vincent', row: 0, start: 0, end: 18, kind: 'out' }, bob: { name: 'Bob', row: 0, start: 33, end: 66, kind: 'booked' } };

const STEPS: Record<number, { bars: Bars; who: 'Vincent' | 'Bob'; focus: 'customer' | 'owner' }> = {
  1: { bars: { ...base, vincentMore: more(false), planA: planA(false), planB: planB(false) }, who: 'Vincent', focus: 'customer' },
  2: { bars: { ...base, vincentMore: more(true), planA: planA(true), planB: planB(true) }, who: 'Vincent', focus: 'owner' },
  3: { bars: { ...base, vincentMore: more(true), planA: planA(true), planB: planB(true) }, who: 'Vincent', focus: 'customer' },
  4: { bars: { ...base, vincentMore: more(true), planA: planA(false), planB: planB(true) }, who: 'Bob', focus: 'customer' },
  5: { bars: { ...base, vincentMore: more(true), planA: planA(false), planB: planB(true) }, who: 'Bob', focus: 'owner' },
  6: { bars: { vincent: { ...base.vincent!, noBuffer: true }, bob: { name: 'Bob', row: 0, start: 38, end: 66, kind: 'booked' }, vincentMore: more(true, 'out'), planA: planA(false), planB: planB(false) }, who: 'Bob', focus: 'owner' },
};

/** Wires one stage to the steps: on a wide screen a single pinned stage, on a narrow one a copy inside each step. */
function makeStage(root: HTMLElement) {
  const draw = schedule(root.querySelector<HTMLElement>('.stage-sched')!, STAGE_ROWS);
  const shows = [...root.querySelectorAll<HTMLElement>('[data-show]')];
  return (n: number) => {
    const s = STEPS[n]!;
    root.dataset.step = String(n);
    root.dataset.focus = s.focus;
    draw(s.bars);
    root.querySelector('.who-name')!.textContent = s.who;
    root.querySelector('.who-dot')!.textContent = s.who[0]!;
    for (const el of shows) {
      const [from, to] = el.dataset.show!.split('-').map(Number) as [number, number];
      el.classList.toggle('on', n >= from && n <= to);
    }
  };
}

const stage = document.getElementById('stage')!;
const steps = [...document.querySelectorAll<HTMLElement>('.step')];
// Each step's copy starts one step back, so arriving at it plays the change.
const copies = new Map<number, (n: number) => void>();
for (const el of steps) {
  const n = Number(el.dataset.step);
  const copy = stage.cloneNode(true) as HTMLElement;
  copy.removeAttribute('id');
  copy.classList.add('step-stage');
  copy.querySelector('.sched')!.innerHTML = '';
  el.append(copy);
  const go = makeStage(copy);
  go(Math.max(n - 1, 1));
  copies.set(n, go);
}
const goMain = makeStage(stage);

function goTo(n: number) {
  goMain(n);
  copies.get(n)?.(n);
  for (const el of steps) el.classList.toggle('on', Number(el.dataset.step) === n);
}

goTo(1);
const stepObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) if (e.isIntersecting) goTo(Number((e.target as HTMLElement).dataset.step));
  },
  // The step crossing the middle band of the window is the one being read.
  { rootMargin: '-45% 0px -45% 0px' },
);
for (const el of steps) stepObserver.observe(el);

// ---- The app's real screens. ----------------------------------------------------------------------------------------

const NOTES = [
  "Bookings, turnaround time and maintenance run on Bryntum Scheduler Pro. The customer's phone sits beside it, so you can watch one cause the other.",
  'Each plan the optimizer rejects stays in the activity feed. Click one and it appears on the schedule, with the booking it hits outlined and the reason beside it.',
];
const shots = [...document.querySelectorAll<HTMLImageElement>('.shot')];
const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-shot]')];
for (const tab of tabs)
  tab.addEventListener('click', () => {
    const i = Number(tab.dataset.shot);
    tabs.forEach((t, j) => t.setAttribute('aria-selected', String(i === j)));
    shots.forEach((s, j) => s.classList.toggle('on', i === j));
    document.getElementById('shot-note')!.textContent = NOTES[i]!;
  });

// ---- Parts rise as their section arrives. Without script, or with reduced motion, they're simply there. --------------

if (!reducedMotion) {
  const parts = document.querySelectorAll<HTMLElement>('.how-steps > h2, .how-intro, .real-side > *, .real-stage, .rules-head > *, .tiles > li, .close > *, .foot .mark-big');
  document.documentElement.classList.add('will-rise');
  const riseObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries)
        if (e.isIntersecting) {
          e.target.classList.add('risen');
          riseObserver.unobserve(e.target);
        }
    },
    { rootMargin: '0px 0px -8% 0px' },
  );
  parts.forEach((el) => {
    const siblings = el.parentElement ? [...el.parentElement.children] : [];
    el.style.setProperty('--delay', `${Math.min(siblings.indexOf(el), 5) * 70}ms`);
    riseObserver.observe(el);
  });
}

// ---- The hero's orange square drops in, then steps along the stripe. With reduced motion it stays where it landed. ----

if (!reducedMotion) {
  const squares = [...document.querySelectorAll<HTMLElement>('.stripe i')];
  let lit = squares.findIndex((el) => el.classList.contains('moved'));
  window.setTimeout(() => {
    window.setInterval(() => {
      squares[lit]!.classList.remove('moved', 'lit');
      lit = (lit + 1) % squares.length;
      squares[lit]!.classList.add('lit');
    }, 800);
  }, 2400); // the drop-in has finished by now
}
