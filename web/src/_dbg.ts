import { ProjectModel, TimeZoneHelper } from '@bryntum/schedulerpro';

const TZ = 'America/Los_Angeles';
export async function mk(variant: string, startIso: string, endIso: string) {
  const shop = { recurrentStartDate: 'at 9:00', recurrentEndDate: 'at 21:00', recurrentDatesTimeZone: TZ, isWorking: true };
  const maint = { startDate: '2026-11-11T17:00:00Z', endDate: '2026-11-14T05:00:00Z', isWorking: false };
  const calendars: any[] = [{ id: 'shop', name: 'shop', unspecifiedTimeIsWorking: false, intervals: [shop] }];
  const events: any = { id: 'e1', name: 'E', startDate: startIso, endDate: endIso };
  if (variant === 'combinedEventCal') {
    calendars.push({ id: 'unit', name: 'unit', unspecifiedTimeIsWorking: false, intervals: [shop, maint] });
    events.calendar = 'unit';
  }
  if (variant === 'combinedEventCalPriority') {
    calendars.push({ id: 'unit', name: 'unit', unspecifiedTimeIsWorking: false, intervals: [shop, { ...maint, priority: 100 }] });
    events.calendar = 'unit';
  }
  const p: any = new ProjectModel({
    timeZone: TZ, calendar: 'shop', calendarsData: calendars,
    resourcesData: [{ id: 'r1', name: 'R1' }], eventsData: [events], assignmentsData: [{ id: 'a1', eventId: 'e1', resourceId: 'r1' }],
  });
  await p.commitAsync();
  const e = p.eventStore.getById('e1');
  const out = { start: TimeZoneHelper.fromTimeZone(e.startDate, TZ).toISOString(), end: TimeZoneHelper.fromTimeZone(e.endDate, TZ).toISOString(), eff: e.effectiveCalendar?.id };
  p.destroy();
  return out;
}
