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
import { useMemo, useRef } from 'react';
import type { OwnerView } from '../api';
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
};

const UNASSIGNED = 'unassigned';
const hoursBetween = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 3600_000);

export function Schedule({ owner, shopNow, onEdit, onResolveDraft, onCancel }: Props) {
  const project = useRef<BryntumSchedulerProProjectModel>(null);
  const tz = owner.shop.timezone;
  const nameOf = (id: string | null) => owner.customers.find((c) => c.id === id)?.name ?? 'Customer';
  const modelOf = (id: string) => owner.models.find((m) => m.id === id)?.name ?? '';
  const unitOf = (id: string | null) => (id ? (owner.units.find((u) => u.id === id)?.label ?? '?') : 'Unassigned');
  const t = (iso: string) => shopTime(iso, tz);

  const weekStart = DateTime.fromISO(owner.shop.now, { zone: tz }).startOf('week');
  // The demo week, Monday to the following Tuesday (Hank), as real instants: Bryntum converts them to shop time.
  // It ends at 10pm Tuesday, after Hank's buffer: the clocks change inside the week, so a midnight end would spill
  // an hour into Wednesday in browsers whose offset to the shop changes that week. `autoAdjustTimeAxis: false`
  // keeps Bryntum from widening the range to whole weeks.
  const view = useMemo(() => ({ start: weekStart.toJSDate(), end: weekStart.plus({ days: 8, hours: 22 }).toJSDate() }), [weekStart.toMillis()]);

  const data = useMemo(() => {
    const resources = [
      ...[...owner.units].sort((a, b) => a.label.localeCompare(b.label)).map((u) => ({ id: u.id, name: u.label, model: modelOf(u.modelId) })),
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
          draggable: !picked, resizable: picked ? 'end' : true, inRequest: touched.has(b.id), overdue: picked && !!b.overdueMarkedAt,
          tip: `${nameOf(b.customerId)} · ${modelOf(b.modelId)}\n${t(b.startsAt)} → ${t(b.endsAt)}\n${picked ? (b.overdueMarkedAt ? 'Overdue' : 'Picked up') : 'Confirmed'} · paid ${usd(b.priceCents)}${b.note ? `\n“${b.note}”` : ''}`,
        },
        b.unitId,
      );
    }

    // Ghosts: what each live plan would do. An extension shows only the added time on the same unit.
    const seen = new Set<string>();
    for (const p of owner.proposals)
      for (const r of p.revisions)
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

    const resourceTimeRanges = owner.unavailability.map((u) => ({
      id: u.id, resourceId: u.unitId, startDate: u.period.start, endDate: u.period.end, name: u.reason.replace('_', ' '),
    }));
    return { resources, events, assignments, resourceTimeRanges };
  }, [owner]);

  const timeRanges = useMemo(() => [{ id: 'now', name: '', startDate: shopNow }], [Math.floor(shopNow.getTime() / 60_000)]);

  // Bryntum keeps the config from the first render, so its handlers read the latest props from here.
  const latest = useRef({ onEdit, onResolveDraft, onCancel, tz });
  latest.current = { onEdit, onResolveDraft, onCancel, tz };
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
      forceFit: true,
      rowHeight: 42,
      barMargin: 5,
      eventStyle: 'rounded',
      columns: [
        { text: 'Unit', field: 'name', width: 104 },
        { text: 'Model', field: 'model', width: 150 },
      ],
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
      // Delete and Backspace ask to cancel the booking. Bryntum never removes a bar by itself: the server decides, and the
      // bar goes when the refreshed schedule no longer has it.
      onBeforeEventDelete({ eventRecords }: any) {
        const record = eventRecords?.[0];
        if (record?.kind === 'booking') latest.current.onCancel({ bookingId: record.bookingId, name: record.name, version: record.version, status: record.status });
        return false;
      },
      taskEditFeature: false,
      eventMenuFeature: false,
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
        if (eventRecord.kind === 'ghost') return name;
        if (eventRecord.status === 'picked_up') renderData.cls.add('picked-up');
        if (eventRecord.inRequest) renderData.cls.add('in-request');
        if (eventRecord.overdue) renderData.cls.add('overdue');
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
    <div className="schedule">
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
      <BryntumSchedulerPro project={project as any} {...(config as any)} />
    </div>
  );
}
