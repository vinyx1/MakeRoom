// The owner's schedule (Bryntum Scheduler Pro). Read spikes/bryntum/FINDINGS.md before changing it.
//
// The backend is the source of truth: everything here is derived from the owner view, and Bryntum never saves on
// its own. Bookings are `manuallyScheduled` so the engine never moves one; ghosts (pending plans) and red drafts are
// read-only events in the same store, flagged by `kind`. Owner drags and resizes are held (async finalize) until
// `onEdit` has asked the backend.
//
// Times: the project runs in the shop's time zone, so Bryntum shows shop time whatever the browser's zone. Dates
// coming back from a drag are in Bryntum's converted form; `TimeZoneHelper.fromTimeZone` turns them back into
// real instants before they go to the server.

import { EventModel, StringHelper, TimeZoneHelper } from '@bryntum/schedulerpro';
import { BryntumSchedulerPro, BryntumSchedulerProProjectModel } from '@bryntum/schedulerpro-react';
import { DateTime } from 'luxon';
import { useEffect, useMemo, useRef } from 'react';
import type { OwnerView, RejectedPlan } from '../api';
import { onHighlightRequest, onScheduleToToday } from '../highlight';
import { shopTime, usd } from '../live';

class ScheduleEvent extends EventModel {
  static override get fields() {
    return [
      { name: 'kind', defaultValue: 'booking' }, // booking | ghost | draft
      { name: 'status' },
      { name: 'bookingId' },
      { name: 'draftId' },
      { name: 'version', type: 'number' },
      { name: 'inRequest', type: 'boolean' }, // a pending request would change this booking
      { name: 'overdue', type: 'boolean' }, // picked up and not back on time
      { name: 'dueBack', type: 'boolean' }, // picked up and past its return time, whether or not it's marked overdue
      { name: 'litUp', type: 'boolean' }, // a rejected plan being shown would have overlapped this booking
      { name: 'tip' }, // tooltip text, already composed
    ];
  }
}

export type EditRequest = { bookingId: string; name: string; unitId: string | null; startsAt: Date; endsAt: Date; version: number };

type Props = {
  owner: OwnerView;
  shopNow: Date;
  onEdit: (edit: EditRequest) => Promise<boolean>;
  onResolveDraft: (draftId: string) => void;
  onCancel: (booking: { bookingId: string; name: string; version: number; status: string }) => void;
  onReturned: (bookingId: string) => void;
  onMarkOverdue: (bookingId: string) => void;
  rejected: RejectedPlan | null;
  onClearRejected: () => void;
};

const UNASSIGNED = 'unassigned';
const hoursBetween = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 3600_000);

/**
 * The models with no unit left at some moment in this stretch of opening hours, by the prefix of their unit labels.
 * Counts confirmed bookings with their turnaround, and unavailable units; a plan that's only proposed holds nothing here.
 */
/** Like equipment together: the biggest category first, each from its smallest model up. */
function unitOrder(owner: OwnerView) {
  const modelOf = (u: OwnerView['units'][number]) => owner.models.find((m) => m.id === u.modelId)!;
  const size = (category: string) => owner.units.filter((u) => modelOf(u).category === category).length;
  return (a: OwnerView['units'][number], b: OwnerView['units'][number]) => {
    const [x, y] = [modelOf(a), modelOf(b)];
    return size(y.category) - size(x.category) || x.category.localeCompare(y.category) || x.tier - y.tier || a.label.localeCompare(b.label);
  };
}

export function fullyBooked(owner: OwnerView, start: Date, end: Date): string[] {
  const zone = owner.shop.timezone;
  const opens = Number(owner.shop.opensAt.slice(0, 2));
  const closes = Number(owner.shop.closesAt.slice(0, 2));
  const day = DateTime.fromJSDate(start, { zone });
  const from = Math.max(start.getTime(), day.set({ hour: opens }).toMillis());
  const to = Math.min(end.getTime(), day.set({ hour: closes }).toMillis());
  if (to <= from) return [];
  return owner.models.flatMap((model) => {
    const units = owner.units.filter((u) => u.modelId === model.id);
    const busy = (unitId: string) => [
      ...owner.bookings.filter((b) => b.unitId === unitId).map((b) => [new Date(b.startsAt).getTime(), new Date(b.bufferEndsAt).getTime()]),
      ...owner.unavailability.filter((u) => u.unitId === unitId).map((u) => [new Date(u.period.start).getTime(), new Date(u.period.end).getTime()]),
    ].filter(([a, b]) => a! < to && b! > from) as [number, number][];
    const spans = units.map((u) => busy(u.id));
    // Each unit busy at the same instant: it's enough to test the moments a span begins.
    const moments = [from, ...spans.flat().map(([a]) => a).filter((a) => a >= from && a < to)];
    const full = units.length > 0 && moments.some((t) => spans.every((s) => s.some(([a, b]) => a <= t && t < b)));
    return full ? [units[0]!.label.split('-')[0]!] : [];
  });
}

export function Schedule({ owner, shopNow, onEdit, onResolveDraft, onCancel, onReturned, onMarkOverdue, rejected, onClearRejected }: Props) {
  const project = useRef<BryntumSchedulerProProjectModel>(null);
  const tz = owner.shop.timezone;
  const nameOf = (id: string | null) => owner.customers.find((c) => c.id === id)?.name ?? 'Customer';
  const modelOf = (id: string) => owner.models.find((m) => m.id === id)?.name ?? '';
  const unitOf = (id: string | null) => (id ? (owner.units.find((u) => u.id === id)?.label ?? '?') : 'Unassigned');
  const t = (iso: string) => shopTime(iso, tz);

  const weekStart = DateTime.fromISO(owner.shop.now, { zone: tz }).startOf('week');
  // A scrollable month around the demo week, as real instants: Bryntum converts them to shop time. It ends at 10pm:
  // when the clocks change inside the range, a midnight end would spill an hour into the next day in browsers whose
  // offset to the shop changes. `autoAdjustTimeAxis: false` keeps Bryntum from widening the range to whole weeks.
  const view = useMemo(() => ({ start: weekStart.minus({ days: 7 }).toJSDate(), end: weekStart.plus({ days: 21, hours: 22 }).toJSDate() }), [weekStart.toMillis()]);

  const data = useMemo(() => {
    const resources = [
      ...[...owner.units].sort(unitOrder(owner)).map((u) => ({ id: u.id, name: u.label, model: modelOf(u.modelId) })),
      { id: UNASSIGNED, name: 'Unassigned', model: '', cls: 'unassigned-row' },
    ];
    const events: Record<string, unknown>[] = [];
    const assignments: Record<string, unknown>[] = [];
    const place = (event: Record<string, unknown>, unitId: string | null) => {
      events.push(event);
      assignments.push({ id: `a-${event.id}`, eventId: event.id, resourceId: unitId ?? UNASSIGNED });
    };

    // Bookings a pending request would change get an outline, so the conflict is visible before anything commits.
    const touched = new Set(owner.proposals.flatMap((p) => p.revisions.flatMap((r) => r.changes.map((c) => c.bookingId))).filter(Boolean));
    for (const b of owner.bookings) {
      const picked = b.status === 'picked_up';
      place(
        {
          id: b.id, name: nameOf(b.customerId), kind: 'booking', status: b.status, bookingId: b.id, version: b.version,
          startDate: b.startsAt, endDate: b.endsAt, manuallyScheduled: true, postamble: `${hoursBetween(b.endsAt, b.bufferEndsAt)}h`,
          draggable: !picked, resizable: picked ? 'end' : true, inRequest: touched.has(b.id), overdue: picked && !!b.overdueMarkedAt, dueBack: picked && new Date(b.endsAt) <= new Date(owner.shop.now), litUp: !!rejected?.conflictsWith.includes(b.id),
          tip: `${nameOf(b.customerId)} · ${modelOf(b.modelId)}\n${t(b.startsAt)} → ${t(b.endsAt)}\n${picked ? (b.overdueMarkedAt ? 'Overdue' : 'Picked up') : 'Confirmed'} · paid ${usd(b.priceCents)}${b.note ? `\n“${b.note}”` : ''}`,
        },
        b.unitId,
      );
    }

    // Ghosts: what each live plan would do. An extension shows only the added time on the same unit.
    const seen = new Set<string>();
    for (const p of owner.proposals) {
      // Once the affected customer has picked, only their pick is still the plan on the table.
      const picked = p.revisions.find((r) => r.approvals.some((a) => a.role === 'affected' && a.status === 'approved'));
      for (const r of picked ? [picked] : p.revisions)
        for (const c of r.changes) {
          const key = `${c.bookingId}|${c.newUnitId}|${c.newStartsAt}|${c.newEndsAt}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const who = nameOf(c.partyCustomerId);
          const plan = r.optionLabel ? `Plan ${r.optionLabel}: ` : '';
          const extension = c.before && c.before.unitId === c.newUnitId && c.before.startsAt === c.newStartsAt && c.newEndsAt > c.before.endsAt;
          place(
            {
              id: `ghost-${r.id}-${c.id}`, kind: 'ghost', manuallyScheduled: true, draggable: false, resizable: false,
              name: extension ? `${who} +${hoursBetween(c.before!.endsAt, c.newEndsAt)}h` : `${plan}${who}`,
              startDate: extension ? c.before!.endsAt : c.newStartsAt, endDate: c.newEndsAt,
              postamble: `${hoursBetween(c.newEndsAt, c.newBufferEndsAt)}h`,
              tip: `Proposed (${p.state === 'DRAFT' ? 'not yet accepted' : 'waiting for approvals'})\n${plan}${who}: ${modelOf(c.newModelId)} on ${unitOf(c.newUnitId)}\n${t(c.newStartsAt)} → ${t(c.newEndsAt)}`,
            },
            c.newUnitId,
          );
        }
    }

    // Red drafts: owner edits that conflict. They hold nothing and block nothing.
    for (const d of owner.drafts) {
      const b = owner.bookings.find((x) => x.id === d.bookingId);
      if (!b || !d.proposed.startsAt || !d.proposed.endsAt) continue;
      place(
        {
          id: `draft-${d.id}`, kind: 'draft', draftId: d.id, name: `${nameOf(b.customerId)} (draft)`, manuallyScheduled: true,
          draggable: false, resizable: false, startDate: d.proposed.startsAt, endDate: d.proposed.endsAt,
          tip: `Owner draft: conflicts with another booking\n${t(d.proposed.startsAt)} → ${t(d.proposed.endsAt)}\nResolve with agent to find a plan`,
        },
        d.proposed.unitId ?? b.unitId,
      );
    }

    // A ruled-out plan the owner is looking at: read-only, and nothing about it reaches the server.
    if (rejected)
      place(
        {
          id: 'rejected', kind: 'rejected', manuallyScheduled: true, draggable: false, resizable: false, name: `Ruled out: ${nameOf(rejected.customerId)}`,
          startDate: rejected.after.startsAt, endDate: rejected.after.endsAt, postamble: `${hoursBetween(rejected.after.endsAt, rejected.after.bufferEndsAt)}h`,
          tip: rejected.message,
        },
        rejected.after.unitId,
      );

    // What each request touches, for the highlight when its card is pointed at.
    const byRequest = new Map<string, string[]>();
    for (const p of owner.proposals) {
      const ghostPrefixes = p.revisions.map((r) => `ghost-${r.id}-`);
      const bookingIds = p.revisions.flatMap((r) => r.changes.map((c) => c.bookingId));
      byRequest.set(p.id, events.map((e) => String(e.id)).filter((id) => bookingIds.includes(id) || ghostPrefixes.some((g) => id.startsWith(g))));
    }

    const resourceTimeRanges = owner.unavailability.map((u) => ({
      id: u.id, resourceId: u.unitId, startDate: u.period.start, endDate: u.period.end, name: u.reason.replace('_', ' '),
    }));
    return { resources, events, assignments, resourceTimeRanges, byRequest };
  }, [owner, rejected]);

  const root = useRef<HTMLDivElement>(null);
  const wraps = (ids: string[]) =>
    ids.flatMap((id) => [...(root.current?.querySelectorAll<HTMLElement>(`.b-sch-event-wrap[data-event-id="${CSS.escape(id)}"]`) ?? [])]);

  // Pointing at a request's card lights up what it would change.
  const byRequest = useRef(data.byRequest);
  byRequest.current = data.byRequest;
  useEffect(
    () =>
      onHighlightRequest((proposalId) => {
        root.current?.querySelectorAll('.b-sch-event-wrap.highlighted').forEach((el) => el.classList.remove('highlighted'));
        if (proposalId) wraps(byRequest.current.get(proposalId) ?? []).forEach((el) => el.classList.add('highlighted'));
      }),
    [],
  );

  // A bar that appears or moves pulses once, so a click in a chat or on a card shows its effect on the schedule.
  const lastSeen = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    const placed = new Map(data.assignments.map((a) => [String(a.eventId), String(a.resourceId)]));
    const seen = new Map(data.events.map((e) => [String(e.id), `${e.startDate}|${e.endDate}|${placed.get(String(e.id))}`]));
    const before = lastSeen.current;
    lastSeen.current = seen;
    const changed = before ? [...seen].filter(([id, was]) => before.get(id) !== was).map(([id]) => id) : [];
    // No shared bar means a reset or a first load: everything is new, and nothing was caused by a click.
    if (!before || !changed.length || ![...seen.keys()].some((id) => before.has(id))) return;
    const show = window.setTimeout(() => wraps(changed).forEach((el) => el.classList.add('pulse')), 250);
    const clear = window.setTimeout(() => wraps(changed).forEach((el) => el.classList.remove('pulse')), 2850);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(clear);
      wraps(changed).forEach((el) => el.classList.remove('pulse'));
    };
  }, [data]);

  // The current-time line. Bryntum's own (`showCurrentTimeLine`) follows the browser's clock, not the shop's demo
  // clock. Replacing this prop after the first render makes the line vanish, so the prop stays fixed and the record
  // moves; a value set on a record is in the project's time zone, so it's converted first.
  const timeRanges = useMemo(() => [{ id: 'now', name: '', startDate: shopNow }], []);
  const scheduler = useRef<BryntumSchedulerPro>(null);
  const shopMinute = Math.floor(shopNow.getTime() / 60_000);
  useEffect(() => {
    const line = (project.current as any)?.instance?.timeRangeStore?.getById('now');
    if (line) line.startDate = TimeZoneHelper.toTimeZone(shopNow, tz);
  }, [shopMinute, tz]);

  // Opens on the current time, and comes back to it from the Today button.
  const nowRef = useRef(shopNow);
  nowRef.current = shopNow;
  const showToday = (animate: boolean) =>
    void (scheduler.current as any)?.instance?.scrollToDate(TimeZoneHelper.toTimeZone(nowRef.current, tz), { block: 'center', animate });
  // Bring a ruled-out plan into view when it's chosen.
  useEffect(() => {
    if (!rejected) return;
    const date = TimeZoneHelper.toTimeZone(new Date(rejected.after.startsAt), tz);
    void (scheduler.current as any)?.instance?.scrollToDate(date, { block: 'center', animate: true });
  }, [rejected, tz]);

  useEffect(() => {
    const opening = window.setTimeout(() => showToday(false), 0);
    const off = onScheduleToToday(() => showToday(true));
    return () => {
      window.clearTimeout(opening);
      off();
    };
  }, [tz]);

  // Bryntum keeps the config from the first render, so its handlers read the latest props from here.
  const latest = useRef({ onEdit, onResolveDraft, onCancel, onReturned, onMarkOverdue, tz, owner });
  latest.current = { onEdit, onResolveDraft, onCancel, onReturned, onMarkOverdue, tz, owner };
  const submit = (record: any, resourceId: string, start: Date, end: Date, finalize: (ok: boolean) => void) => {
    if (record.kind !== 'booking') return finalize(false);
    const real = (d: Date) => TimeZoneHelper.fromTimeZone(d, latest.current.tz);
    latest.current
      .onEdit({
        bookingId: record.bookingId, name: record.name, unitId: resourceId === UNASSIGNED ? null : resourceId,
        startsAt: real(start), endsAt: real(end), version: record.version,
      })
      .then(finalize, () => finalize(false));
  };

  const config = useMemo(
    () => ({
      startDate: view.start,
      endDate: view.end,
      viewPreset: 'dayAndWeek',
      weekStartDay: 1, // Monday, like the demo week
      autoAdjustTimeAxis: false,
      // Drags and resizes land on whole hours, so an owner edit doesn't miss shop hours by a few minutes.
      timeResolution: { unit: 'hour', increment: 1 },
      snap: true,
      // Wide enough to read a booking; the range scrolls instead of being squeezed into the window.
      tickSize: 150,
      rowHeight: 36,
      barMargin: 4,
      eventStyle: 'rounded',
      // Units of one model sit under one merged cell, which groups them without adding rows.
      columns: [
        { text: 'Model', field: 'model', width: owner.units.length > 12 ? 190 : 118, mergeCells: true, sum: 'count', summaryRenderer: () => 'Fully booked' },
        { text: 'Unit', field: 'name', width: 104 },
      ],
      mergeCellsFeature: { sortedOnly: false },
      // Under each day, what the shop has run out of, from confirmed bookings and unavailable units.
      summaryFeature: {
        renderer({ startDate, endDate }: any) {
          const { owner: view, tz: zone } = latest.current;
          const full = fullyBooked(view, TimeZoneHelper.fromTimeZone(startDate, zone), TimeZoneHelper.fromTimeZone(endDate, zone));
          if (!full.length) return '<span class="day-free">Room</span>';
          const names = StringHelper.encodeHtml(full.join(', '));
          return `<span class="day-full" title="${names}">${full.length > 2 ? `${full.length} models out` : names}</span>`;
        },
      },
      // The React wrapper takes one `<name>Feature` prop per feature (spike gotcha 1).
      eventBufferFeature: { showDuration: true },
      resourceTimeRangesFeature: true,
      timeRangesFeature: { showCurrentTimeLine: false },
      eventDragFeature: { constrainDragToTimeline: true },
      // Bryntum's own delete stays off, so it can never remove a bar: the server decides, and the bar goes when the
      // refreshed schedule no longer has it. Delete and Backspace ask to cancel the booking instead.
      enableDeleteKey: false,
      onEventKeyDown({ eventRecords, event }: any) {
        const record = eventRecords?.[0];
        if ((event.key !== 'Delete' && event.key !== 'Backspace') || record?.kind !== 'booking') return;
        event.preventDefault();
        latest.current.onCancel({ bookingId: record.bookingId, name: record.name, version: record.version, status: record.status });
      },
      eventDragCreateFeature: false,
      scheduleTooltipFeature: false,
      // Delete and Backspace ask to cancel the booking. Bryntum never removes a bar by itself: the server decides, and the
      // bar goes when the refreshed schedule no longer has it.
      onBeforeEventDelete({ eventRecords }: any) {
        const record = eventRecords?.[0];
        if (record?.kind === 'booking') latest.current.onCancel({ bookingId: record.bookingId, name: record.name, version: record.version, status: record.status });
        return false;
      },
      taskEditFeature: false,
      // Clicking a booking opens its actions. Each one goes to the same backend action as the rest of the app, and
      // Bryntum's own items stay off, so the schedule never changes a booking by itself.
      eventMenuFeature: {
        triggerEvent: 'click',
        items: { editEvent: false, cutEvent: false, copyEvent: false, deleteEvent: false, unassignEvent: false, splitEvent: false, renameSegment: false },
        processItems({ eventRecord, items }: any) {
          if (eventRecord.kind !== 'booking') return false;
          if (eventRecord.status === 'picked_up') {
            items.markReturned = { text: 'Mark returned', icon: 'fa fa-check', weight: 100, onItem: () => latest.current.onReturned(eventRecord.bookingId) };
            if (eventRecord.dueBack)
              items.markOverdue = { text: eventRecord.overdue ? 'Update expected return…' : 'Mark overdue…', icon: 'fa fa-clock', weight: 110, onItem: () => latest.current.onMarkOverdue(eventRecord.bookingId) };
          } else {
            items.cancelBooking = {
              text: 'Delete booking…', icon: 'fa fa-trash', weight: 100,
              onItem: () => latest.current.onCancel({ bookingId: eventRecord.bookingId, name: eventRecord.name, version: eventRecord.version, status: eventRecord.status }),
            };
          }
        },
      },
      scheduleMenuFeature: false,
      cellEditFeature: false,
      dependenciesFeature: false,
      eventTooltipFeature: {
        template: ({ eventRecord }: any) => `<div class="tip">${StringHelper.encodeHtml(eventRecord.tip ?? eventRecord.name)}</div>`,
      },
      eventRenderer({ eventRecord, renderData }: any) {
        const name = StringHelper.encodeHtml(eventRecord.name);
        renderData.cls.add(`kind-${eventRecord.kind}`);
        if (eventRecord.kind === 'draft')
          return `<span class="draft-name">${name}</span><button class="resolve-btn" type="button">Resolve with agent</button>`;
        if (eventRecord.kind === 'ghost' || eventRecord.kind === 'rejected') return name;
        if (eventRecord.status === 'picked_up') renderData.cls.add('picked-up');
        if (eventRecord.inRequest) renderData.cls.add('in-request');
        if (eventRecord.overdue) renderData.cls.add('overdue');
        if (eventRecord.litUp) renderData.cls.add('lit-up');
        return eventRecord.status === 'picked_up' ? `<span class="lock">●</span> ${name}` : name;
      },
      onBeforeEventDropFinalize({ context }: any) {
        context.async = true;
        const resourceId = (context.newResource ?? context.resourceRecord)?.id;
        submit(context.eventRecord, resourceId, context.startDate, context.endDate, context.finalize);
      },
      // On resizes, `async` and `finalize` sit on the event itself, not `context` (spike result 4).
      onBeforeEventResizeFinalize(event: any) {
        event.async = true;
        submit(event.eventRecord, event.eventRecord.resource?.id, event.startDate, event.endDate, event.finalize);
      },
      onEventClick({ eventRecord, event }: any) {
        if (eventRecord.kind === 'draft' && (event.target as HTMLElement).closest('.resolve-btn')) latest.current.onResolveDraft(eventRecord.draftId);
      },
    }),
    [view],
  );

  return (
    <div className="schedule" ref={root}>
      {rejected && (
        <div className="replay-note">
          <span>{rejected.message}</span>
          <button className="link" onClick={onClearRejected}>Clear</button>
        </div>
      )}
      <BryntumSchedulerProProjectModel
        ref={project}
        timeZone={tz}
        eventModelClass={ScheduleEvent as any}
        resources={data.resources}
        events={data.events as any}
        assignments={data.assignments as any}
        resourceTimeRanges={data.resourceTimeRanges as any}
        timeRanges={timeRanges as any}
      />
      <BryntumSchedulerPro ref={scheduler} project={project as any} {...(config as any)} />
    </div>
  );
}
