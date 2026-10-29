// Shop-hours arithmetic, in the shop's time zone (DST-aware via luxon).

import { DateTime } from 'luxon';

export type ShopHours = { timezone: string; opensAt: string; closesAt: string };

const STEP_MS = 15 * 60_000;
export const HOUR_MS = 3600_000;

/** `"09:00"` or `"09:00:00"` → minutes after midnight. */
const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};

const local = (t: Date, h: ShopHours) => DateTime.fromJSDate(t, { zone: h.timezone });

const atMinutes = (d: DateTime, minutes: number) =>
  d.set({ hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0, millisecond: 0 });

/** Pickups and returns happen only within shop hours, both ends inclusive (9:00 and 21:00 are fine). */
export function isWithinShopHours(t: Date, h: ShopHours) {
  const d = local(t, h);
  const minutes = d.hour * 60 + d.minute + (d.second * 1000 + d.millisecond) / 60_000;
  return minutes >= toMinutes(h.opensAt) && minutes <= toMinutes(h.closesAt);
}

/** The first quarter-hour at or after `t` that falls within shop hours. */
export function earliestOpenAtOrAfter(t: Date, h: ShopHours): Date {
  const rounded = new Date(Math.ceil(t.getTime() / STEP_MS) * STEP_MS);
  if (isWithinShopHours(rounded, h)) return rounded;
  const d = local(rounded, h);
  const open = atMinutes(d, toMinutes(h.opensAt));
  return (d < open ? open : open.plus({ days: 1 })).toJSDate();
}

/** The last quarter-hour at or before `t` that falls within shop hours. */
export function latestOpenAtOrBefore(t: Date, h: ShopHours): Date {
  const rounded = new Date(Math.floor(t.getTime() / STEP_MS) * STEP_MS);
  if (isWithinShopHours(rounded, h)) return rounded;
  const d = local(rounded, h);
  const close = atMinutes(d, toMinutes(h.closesAt));
  return (d > close ? close : close.minus({ days: 1 })).toJSDate();
}

/** Owner-facing time, e.g. "Thu 2:00pm". */
export const formatShopTime = (t: Date, h: ShopHours) =>
  local(t, h).setLocale('en-US').toFormat('ccc h:mma').replace('AM', 'am').replace('PM', 'pm');
