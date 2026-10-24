# Bryntum spike: findings

Bryntum Scheduler Pro **7.3.7 trial** with the React wrapper, on React 19 + Vite 8. Seed and "now" (Wed 28 Oct 2026, 2pm) from `demo script.md`. The fake backend (`src/fakeBackend.ts`) stands in for the real validator.

Verified by `check.mjs`, which drives headless Chrome with real mouse drags and resizes (`npm run dev`, then `npm run check`). `screenshot.png` shows ghosts, a red draft, buffers, the maintenance block and the now line.

## Results

| # | Question | Result | How |
|---|---|---|---|
| 1 | Install trial + render in React/Vite | **Yes** | Public npm, no login: `"@bryntum/schedulerpro": "npm:@bryntum/schedulerpro-trial@7.3.7"` + `@bryntum/schedulerpro-react@7.3.7`. Approve two postinstall scripts (they stamp a trial licence id into Bryntum's own files; no network). |
| 2 | 4h buffer per booking | **Yes** | `eventBufferFeature` + per-event `postamble: '4h'`. Drawn after each bar with a "4h" label. |
| 3 | Maintenance greyed out on a unit | **Yes (display)** | `resourceTimeRangesFeature` + `resourceTimeRanges` on the project. Bryntum doesn't refuse drops onto it by itself; our validator turned such a drop into a red draft. A client-side `eventDragFeature.validatorFn` could also show "invalid" while dragging (not tested). |
| 4 | Intercept owner drags before they save | **Yes** | `onBeforeEventDropFinalize`: set `context.async = true`, ask the backend, then `context.finalize(true/false)`. Resizes: `onBeforeEventResizeFinalize`, but there `async` and `finalize` are on the event object itself, not `context`. Verified accept (Gina to A7RV-1), refuse (Bob into the past) and conflict → draft (Charlie onto maintenance, Alice's extension into Bob). |
| 5 | Ghost events for a proposal, then commit or roll back | **Yes** | Ghosts are ordinary events in the event store with `kind: 'ghost'`, read-only, dashed style. Roll back = remove them; commit = remove them and update the real bookings. |
| 5b | State tracking (STM) apply + reject | **Yes** | `project.stm.enable()`, `startTransaction()`, change, `rejectTransaction()` restored Eve's start. Not needed for ghosts, but available. |
| 6 | Red conflict with a Resolve with agent button | **Yes** | Draft event with `kind: 'draft'`; `eventRenderer` returns HTML (escaped with `StringHelper.encodeHtml`) including a button; `onEventClick` checks `event.target.closest('.resolve-btn')`. |
| 7 | Unassigned row | **Yes** | A normal resource with id `unassigned` and its own style. Ivy's unassigned booking shows there. |
| 8 | Picked-up: no move, end can extend | **Yes** | Per event `draggable: false`, `resizable: 'end'`. Dragging Alice did nothing; resizing her end went through the backend. |
| 9 | Patch the schedule from outside (SSE) | **Yes** | Setting fields and `eventStore.add` / `assignmentStore.add` on the live instance updates in place; same instance, no reload. |

## Gotchas (must carry into the real build)

1. **Feature config in React is one prop per feature**: `eventBufferFeature`, `resourceTimeRangesFeature`, `timeRangesFeature`, `taskEditFeature={false}`, … A `features: {…}` prop is silently ignored, so nothing errors and features just don't appear.
2. **Scheduler Pro's engine can move events** to fit calendars. Every booking is `manuallyScheduled: true`, and unavailability is shown with resource time ranges rather than Pro resource calendars, so Bryntum never changes a booking's times on its own. The backend stays the source of truth.
3. **Use `<BryntumSchedulerProProjectModel>`** (or a `ProjectModel` instance) in the real app. Passing inline stores through the `project` prop works but logs a development warning.
4. **Custom fields** (`kind`, `status`, `reason`, `sourceId`) need an `EventModel` subclass passed as `project.eventModelClass`.
5. **The trial shows a "Bryntum Trial Version" watermark** across the schedule and logs a trial banner in the console. Fine for building; the demo video and judged deployment need a licence or must accept the watermark. Check what happens when the 45-day trial ends.
6. **Short bars truncate their label** (an 8h unassigned booking shows "Iv"; a draft's reason gets cut off). The real UI should put details in the tooltip and keep bar text short.
7. The test's drag target must be the inner `.b-sch-event`, not the `[data-event-id]` wrapper, which includes the buffer.

## Design changes

- `docs/data-model.md` §10: ghosts and drafts live in Bryntum's event store as flagged events (they are still never written to `bookings`); unavailability uses resource time ranges; bookings are `manuallyScheduled`.
- `CLAUDE.md` "Bryntum's role": unavailability is shown with resource time ranges, not Pro calendars.

Nothing else in the design needs to change.
