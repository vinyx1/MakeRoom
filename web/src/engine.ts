// Bryntum Scheduler Pro's scheduling engine, used as a read-only second opinion on the optimizer.
//
// The optimizer (server/src/optimizer) still finds and ranks every plan, and the server still decides. Here the engine
// gets the same bookings in a hidden project of its own and is asked two things:
//
//   verifyPlan   Lay out the schedule as a plan would leave it. Each booking is a task on its unit's timeline,
//                linked to the one before it with a finish-to-start dependency (the turnaround buffer is part of the
//                task), inside a shop-hours calendar, and each unit's maintenance sits in its chain as a fixed task.
//                If the engine has to move any task to make that schedule hold, the plan has an overlap, a missed
//                turnaround, a pickup outside shop hours, or a booking that runs into maintenance.
//   solveCascade Apply only the requester's extension and let the engine propagate it: which later bookings on that
//                unit does it have to slide, and to when? That is the engine's own answer, with no optimizer involved.
//
// Nothing here is ever sent to the server or drawn as a real booking. The project is built, committed, read and
// destroyed inside one call, so the engine can't touch the schedule on screen.

import { CalendarModel, ProjectModel, TimeZoneHelper } from '@bryntum/schedulerpro';
import type { Booking, OwnerView, Proposal, Revision } from './api';

export type EnginePush = { bookingId: string; name: string; unit: string; planned: Date; engine: Date; maintenance?: boolean };

type Task = { id: string; bookingId: string | null; name: string; unitId: string; start: Date; bufferEnd: Date; end: Date; maintenance?: boolean };

const LIVE: Booking['status'][] = ['confirmed', 'picked_up'];
const ALWAYS = 'always';
const SHOP = 'shop-hours';

const nameOf = (owner: OwnerView, id: string | null | undefined) => owner.customers.find((c) => c.id === id)?.name ?? 'A customer';
const unitLabel = (owner: OwnerView, id: string) => owner.units.find((u) => u.id === id)?.label ?? 'Unassigned';
const date = (iso: string) => new Date(iso);

/** The schedule as the bookings stand now, with a plan's changes laid over it. */
function tasksFor(owner: OwnerView, changes: Revision['changes']): Task[] {
  const byBooking = new Map(changes.filter((c) => c.bookingId).map((c) => [c.bookingId!, c]));
  const tasks: Task[] = [];
  for (const b of owner.bookings) {
    if (!LIVE.includes(b.status)) continue;
    const c = byBooking.get(b.id);
    const unitId = c ? c.newUnitId : b.unitId;
    if (!unitId) continue;
    tasks.push({
      id: b.id, bookingId: b.id, name: nameOf(owner, b.customerId), unitId,
      start: date(c ? c.newStartsAt : b.startsAt), end: date(c ? c.newEndsAt : b.endsAt), bufferEnd: date(c ? c.newBufferEndsAt : b.bufferEndsAt),
    });
  }
  // A new booking the plan would add has no booking yet.
  for (const c of changes)
    if (!c.bookingId && c.newUnitId)
      tasks.push({ id: `new-${c.id}`, bookingId: null, name: nameOf(owner, c.partyCustomerId), unitId: c.newUnitId, start: date(c.newStartsAt), end: date(c.newEndsAt), bufferEnd: date(c.newBufferEndsAt) });
  // Maintenance is closed time on a unit: a task nothing else may overlap, held at its own dates.
  const used = new Set(tasks.map((t) => t.unitId));
  for (const u of owner.unavailability)
    if (used.has(u.unitId))
      tasks.push({ id: `maint-${u.id}`, bookingId: null, name: `${unitLabel(owner, u.unitId)} ${u.reason.replace('_', ' ')}`, unitId: u.unitId, start: date(u.period.start), end: date(u.period.end), bufferEnd: date(u.period.end), maintenance: true });
  return tasks;
}

/** What the engine makes of these tasks: where it puts each task's start once every rule holds. */
async function schedule(owner: OwnerView, tasks: Task[], floor: (t: Task) => Date): Promise<Map<string, Date>> {
  const tz = owner.shop.timezone;
  const [opens, closes] = [owner.shop.opensAt.slice(0, 5).replace(/^0/, ''), owner.shop.closesAt.slice(0, 5).replace(/^0/, '')];

  // Shop hours for bookings. Maintenance runs around the clock, so it has a calendar that never closes.
  const calendars = [
    { id: SHOP, name: 'Shop hours', unspecifiedTimeIsWorking: false, intervals: [{ recurrentStartDate: `at ${opens}`, recurrentEndDate: `at ${closes}`, recurrentDatesTimeZone: tz, isWorking: true }] },
    { id: ALWAYS, name: 'Always open', unspecifiedTimeIsWorking: true },
  ];

  const units = [...new Set(tasks.map((t) => t.unitId))];
  const events: Record<string, unknown>[] = [];
  const assignments: Record<string, unknown>[] = [];
  const dependencies: Record<string, unknown>[] = [];
  for (const unitId of units) {
    const chain = tasks.filter((t) => t.unitId === unitId).sort((a, b) => a.start.getTime() - b.start.getTime() || a.bufferEnd.getTime() - b.bufferEnd.getTime());
    chain.forEach((t, i) => {
      // A task is its rental plus its turnaround, so a finish-to-start link with no lag is the buffer rule.
      events.push({
        id: t.id, name: t.name, startDate: t.start, endDate: t.bufferEnd, constraintType: 'startnoearlierthan', constraintDate: floor(t),
        ...(t.maintenance ? { calendar: ALWAYS } : {}),
      });
      assignments.push({ id: `a-${t.id}`, eventId: t.id, resourceId: unitId });
      if (i > 0) dependencies.push({ id: `d-${chain[i - 1]!.id}-${t.id}`, fromEvent: chain[i - 1]!.id, toEvent: t.id, type: 2, lag: 0 });
    });
  }

  const project = new ProjectModel({
    timeZone: tz,
    calendar: SHOP,
    calendars: calendars as unknown as CalendarModel[],
    resources: units.map((id) => ({ id, name: unitLabel(owner, id) })) as never,
    events: events as never,
    assignments: assignments as never,
    dependencies: dependencies as never,
  });
  try {
    await project.commitAsync();
    const out = new Map<string, Date>();
    for (const t of tasks) {
      const record = project.eventStore.getById(t.id) as unknown as { startDate: Date } | null;
      if (record) out.set(t.id, TimeZoneHelper.fromTimeZone(record.startDate, tz));
    }
    return out;
  } finally {
    project.destroy();
  }
}

/** Would the engine leave this plan's schedule exactly as the plan has it? Anything it moves is a rule the plan breaks. */
export async function verifyPlan(owner: OwnerView, revision: Revision): Promise<EnginePush[]> {
  const tasks = tasksFor(owner, revision.changes);
  const placed = await schedule(owner, tasks, (t) => t.start);
  return tasks
    .map((t) => ({ t, engine: placed.get(t.id) }))
    .filter(({ t, engine }) => engine && Math.abs(engine.getTime() - t.start.getTime()) >= 60_000)
    .map(({ t, engine }) => ({ bookingId: t.bookingId ?? t.id, name: t.name, unit: unitLabel(owner, t.unitId), planned: t.start, engine: engine!, maintenance: t.maintenance }));
}

/** With only the requester's own change applied, which bookings does the engine have to slide, and to when? */
export async function solveCascade(owner: OwnerView, proposal: Proposal): Promise<EnginePush[]> {
  const first = proposal.revisions[0];
  if (!first || !proposal.requesterCustomerId) return [];
  const own = first.changes.filter((c) => c.partyCustomerId === proposal.requesterCustomerId);
  const tasks = tasksFor(owner, own);
  // Everyone else holds out for the pickup they booked: the engine may only push them later, never earlier.
  const original = new Map(owner.bookings.map((b) => [b.id, date(b.startsAt)]));
  const placed = await schedule(owner, tasks, (t) => (t.bookingId ? original.get(t.bookingId) : undefined) ?? t.start);
  return tasks
    .map((t) => ({ t, engine: placed.get(t.id), booked: t.bookingId ? original.get(t.bookingId) : undefined }))
    .filter(({ t, engine, booked }) => !t.maintenance && engine && booked && engine.getTime() - booked.getTime() >= 60_000)
    .map(({ t, engine, booked }) => ({ bookingId: t.bookingId!, name: t.name, unit: unitLabel(owner, t.unitId), planned: booked!, engine: engine! }));
}
