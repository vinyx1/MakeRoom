// Demo seed from `demo script.md`, pinned to a concrete week: Mon 26 Oct 2026.
// Demo "now" is Wed 2pm.

const d = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);

export const NOW = d(28, 14);
export const VIEW_START = d(26, 0);
export const VIEW_END = d(35, 0); // Wed 4 Nov
export const BUFFER = '4h';
export const SHOP_OPEN_HOUR = 9;
export const SHOP_CLOSE_HOUR = 21;

export const resources = [
  { id: 'A7IV-1', name: 'A7IV-1', model: 'Sony A7 IV' },
  { id: 'A7IV-2', name: 'A7IV-2', model: 'Sony A7 IV' },
  { id: 'A7IV-3', name: 'A7IV-3', model: 'Sony A7 IV' },
  { id: 'A7RV-1', name: 'A7RV-1', model: 'Sony A7R V' },
  { id: 'RS3-1', name: 'RS3-1', model: 'DJI RS3' },
  { id: 'CRANE4-1', name: 'CRANE4-1', model: 'Zhiyun Crane 4' },
  { id: 'unassigned', name: 'Unassigned', model: 'needs a unit', cls: 'unassigned-row' },
];

type Booking = {
  id: string;
  name: string;
  resourceId: string;
  startDate: Date;
  endDate: Date;
  status: 'confirmed' | 'picked_up';
};

const bookings: Booking[] = [
  { id: 'alice', name: 'Alice', resourceId: 'A7IV-1', startDate: d(26, 9), endDate: d(28, 18), status: 'picked_up' },
  { id: 'bob', name: 'Bob', resourceId: 'A7IV-1', startDate: d(29, 9), endDate: d(30, 18), status: 'confirmed' },
  { id: 'charlie', name: 'Charlie', resourceId: 'A7IV-2', startDate: d(29, 9), endDate: d(30, 18), status: 'confirmed' },
  { id: 'gina', name: 'Gina', resourceId: 'A7IV-2', startDate: d(31, 9), endDate: d(32, 18), status: 'confirmed' },
  { id: 'hank', name: 'Hank', resourceId: 'A7IV-2', startDate: d(33, 9), endDate: d(34, 18), status: 'confirmed' },
  { id: 'dana', name: 'Dana', resourceId: 'RS3-1', startDate: d(27, 9), endDate: d(29, 9), status: 'picked_up' },
  { id: 'eve', name: 'Eve', resourceId: 'RS3-1', startDate: d(29, 14), endDate: d(31, 18), status: 'confirmed' },
  { id: 'ivy', name: 'Ivy (A7 IV)', resourceId: 'unassigned', startDate: d(31, 10), endDate: d(31, 18), status: 'confirmed' },
];

export const events = bookings.map(({ resourceId, ...b }) => ({
  ...b,
  kind: 'booking',
  manuallyScheduled: true,
  postamble: BUFFER,
  // Picked-up rentals: no moving to another unit, only extending the end.
  draggable: b.status !== 'picked_up',
  resizable: b.status === 'picked_up' ? 'end' : true,
}));

export const assignments = bookings.map(b => ({ id: `as-${b.id}`, eventId: b.id, resourceId: b.resourceId }));

export const resourceTimeRanges = [
  { id: 'maint-a7iv3', resourceId: 'A7IV-3', startDate: d(28, 9), endDate: d(30, 21), name: 'Maintenance', timeRangeColor: 'gray' },
];
