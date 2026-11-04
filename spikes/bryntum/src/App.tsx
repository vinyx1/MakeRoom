import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BryntumSchedulerPro } from '@bryntum/schedulerpro-react';
import { EventModel, StringHelper } from '@bryntum/schedulerpro';
import { assignments, events, NOW, resources, resourceTimeRanges, VIEW_END, VIEW_START } from './seed';
import { delay, validateEdit, type Span } from './fakeBackend';

// Booking events carry what the UI needs to style and restrict them.
class BookingModel extends EventModel {
  static override get fields() {
    return [
      { name: 'kind', defaultValue: 'booking' }, // booking | ghost | draft
      { name: 'status', defaultValue: 'confirmed' }, // confirmed | picked_up
      { name: 'reason' }, // why a draft is red
      { name: 'sourceId' }, // booking a draft or ghost stands for
    ];
  }
}

const d = (day: number, hour: number) => new Date(2026, 9, day, hour);

export default function App() {
  const ref = useRef<BryntumSchedulerPro>(null);
  const [log, setLog] = useState<string[]>([]);
  const say = useCallback((line: string) => {
    setLog(l => [`${new Date().toLocaleTimeString()}  ${line}`, ...l].slice(0, 40));
    console.log('[spike]', line);
  }, []);

  const scheduler = () => (ref.current as any)?.instance;
  useEffect(() => { (window as any).sched = scheduler(); }); // spike-only handle for automated checks

  // Everything the fake backend validates against: real bookings only.
  const snapshot = (): { spans: Span[]; blocked: any[] } => {
    const s = scheduler();
    const spans: Span[] = s.eventStore.records
      .filter((e: any) => e.kind === 'booking')
      .map((e: any) => ({ id: e.id, resourceId: e.resource?.id, start: e.startDate, end: e.endDate, status: e.status }));
    const blocked = s.project.resourceTimeRangeStore.records.map((r: any) => ({
      resourceId: r.resourceId, start: r.startDate, end: r.endDate, reason: r.name,
    }));
    return { spans, blocked };
  };

  const addDraft = (record: any, resourceId: string, start: Date, end: Date, reason: string) => {
    const s = scheduler();
    const id = `draft-${record.id}`;
    s.eventStore.getById(id)?.remove();
    const [draft] = s.eventStore.add({
      id, name: `Draft: ${record.name}`, kind: 'draft', reason, sourceId: record.id,
      startDate: start, endDate: end, manuallyScheduled: true, postamble: '4h',
      draggable: false, resizable: false, cls: 'draft',
    });
    s.assignmentStore.add({ eventId: draft.id, resourceId });
  };

  // Q4: every owner edit goes to the backend before Bryntum applies it.
  const decide = async (record: any, resourceId: string, start: Date, end: Date, finalize: (ok: boolean) => void) => {
    const { spans, blocked } = snapshot();
    const original = spans.find(x => x.id === record.id)!;
    say(`→ backend: ${record.name} to ${resourceId} ${start.toLocaleString()} - ${end.toLocaleString()}`);
    await delay(300);
    const verdict = validateEdit({ ...original, resourceId, start, end }, original, spans, blocked);
    if (verdict.result === 'accept') {
      finalize(true);
      say(`← accepted`);
    } else if (verdict.result === 'refuse') {
      finalize(false);
      say(`← refused: ${verdict.reason}`);
    } else {
      finalize(false);
      addDraft(record, resourceId, start, end, verdict.reason);
      say(`← conflict, kept as red draft: ${verdict.reason}`);
    }
  };

  const props = useMemo(() => ({
    startDate: VIEW_START,
    endDate: VIEW_END,
    viewPreset: 'dayAndWeek',
    tickSize: 150,
    rowHeight: 56,
    barMargin: 6,
    eventStyle: 'colored',
    columns: [
      { text: 'Unit', field: 'name', width: 110 },
      { text: 'Model', field: 'model', width: 130 },
    ],
    project: {
      eventModelClass: BookingModel,
      resources,
      events,
      assignments,
      resourceTimeRanges,
      timeRanges: [{ id: 'now', name: 'Now (demo)', startDate: NOW }],
    },
    // The React wrapper takes one `<name>Feature` prop per feature, not a `features` object.
    eventBufferFeature: { showDuration: true },
    resourceTimeRangesFeature: true,
    timeRangesFeature: true,
    eventDragFeature: { constrainDragToTimeline: true },
    eventDragCreateFeature: false,
    taskEditFeature: false,
    eventMenuFeature: false,
    scheduleMenuFeature: false,
    cellEditFeature: false,
    dependenciesFeature: false,
    eventRenderer({ eventRecord, renderData }: any) {
      const name = StringHelper.encodeHtml(eventRecord.name);
      if (eventRecord.kind === 'draft') {
        renderData.cls.add('draft');
        const reason = StringHelper.encodeHtml(eventRecord.reason ?? '');
        return `<div class="draft-body"><b>${name}</b><span>${reason}</span>` +
          `<button class="resolve-btn" data-draft="${StringHelper.encodeHtml(eventRecord.id)}">Resolve with agent</button></div>`;
      }
      if (eventRecord.kind === 'ghost') {
        renderData.cls.add('ghost');
        return `<i>${name}</i>`;
      }
      if (eventRecord.status === 'picked_up') renderData.cls.add('picked-up');
      return eventRecord.status === 'picked_up' ? `🔒 ${name}` : name;
    },
    onBeforeEventDropFinalize({ context }: any) {
      context.async = true;
      const resourceId = context.newResource?.id ?? context.resourceRecord?.id;
      decide(context.eventRecord, resourceId, context.startDate, context.endDate, context.finalize);
    },
    onBeforeEventResizeFinalize(event: any) {
      event.async = true;
      decide(event.eventRecord, event.eventRecord.resource?.id, event.startDate, event.endDate, event.finalize);
    },
    onEventClick({ eventRecord, event }: any) {
      if ((event.target as HTMLElement).closest('.resolve-btn')) say(`Resolve with agent clicked for ${eventRecord.sourceId}`);
    },
  }), [say]);

  // Q5: ghost events for Scenario 1 Plan B, then commit or roll back.
  const ghostIds = ['ghost-vincent', 'ghost-bob'];
  const showGhosts = () => {
    const s = scheduler();
    clearGhosts(false);
    const ghosts = s.eventStore.add([
      { id: 'ghost-vincent', name: 'Vincent keeps it (proposed)', kind: 'ghost', sourceId: 'vincent', startDate: d(28, 18), endDate: d(29, 10), manuallyScheduled: true, draggable: false, resizable: false },
      { id: 'ghost-bob', name: 'Bob 2pm pickup (proposed)', kind: 'ghost', sourceId: 'bob', startDate: d(29, 14), endDate: d(30, 18), manuallyScheduled: true, postamble: '4h', draggable: false, resizable: false },
    ]);
    s.assignmentStore.add([
      { eventId: ghosts[0].id, resourceId: 'A7IV-1' },
      { eventId: ghosts[1].id, resourceId: 'A7IV-1' },
    ]);
    say('Ghost events shown for Plan B');
  };
  const clearGhosts = (announce = true) => {
    const s = scheduler();
    s.eventStore.remove(ghostIds.map(id => s.eventStore.getById(id)).filter(Boolean));
    if (announce) say('Ghosts rolled back; real bookings untouched');
  };
  const commitGhosts = () => {
    const s = scheduler();
    clearGhosts(false);
    s.eventStore.getById('vincent').endDate = d(29, 10);
    s.eventStore.getById('bob').startDate = d(29, 14);
    say('Committed: Vincent to Thu 10am, Bob from Thu 2pm');
  };

  // Q5b: state tracking manager, apply then reject.
  const stmTry = async () => {
    const s = scheduler();
    const stm = s.project.stm;
    stm.enable();
    stm.startTransaction('preview');
    const eve = s.eventStore.getById('eve');
    eve.startDate = d(29, 18);
    await s.project.commitAsync();
    say(`STM: applied preview, Eve starts ${eve.startDate.toLocaleString()}`);
    await delay(800);
    stm.rejectTransaction();
    await s.project.commitAsync();
    say(`STM: rejected, Eve starts ${eve.startDate.toLocaleString()}`);
  };

  // Q9: changes arriving from outside (SSE stand-in), no reload.
  const simulateSse = () => {
    const s = scheduler();
    const instanceBefore = s.id;
    const eve = s.eventStore.getById('eve');
    eve.endDate = new Date(eve.endDate.getTime() + 2 * 3600_000);
    if (!s.eventStore.getById('frank')) {
      const [frank] = s.eventStore.add({ id: 'frank', name: 'Frank', kind: 'booking', status: 'confirmed', startDate: d(31, 9), endDate: d(32, 12), manuallyScheduled: true, postamble: '4h' });
      s.assignmentStore.add({ eventId: frank.id, resourceId: 'A7RV-1' });
    }
    say(`SSE patch applied (Eve +2h, Frank added); same instance: ${instanceBefore === scheduler().id}`);
  };

  return (
    <div className="page">
      <header>
        <b>Bryntum spike</b>
        <button onClick={showGhosts}>Show Plan B ghosts</button>
        <button onClick={commitGhosts}>Commit Plan B</button>
        <button onClick={() => clearGhosts()}>Roll back ghosts</button>
        <button onClick={stmTry}>STM preview + reject</button>
        <button onClick={simulateSse}>Simulate SSE update</button>
      </header>
      <div className="scheduler">
        <BryntumSchedulerPro ref={ref} {...(props as any)} />
      </div>
      <pre className="log" data-testid="log">{log.join('\n')}</pre>
    </div>
  );
}
