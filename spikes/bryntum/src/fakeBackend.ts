// Stand-in for the backend's validator. The real one runs server-side under the per-shop lock.

import { NOW, SHOP_CLOSE_HOUR, SHOP_OPEN_HOUR } from './seed';

export type Span = { id: string; resourceId: string; start: Date; end: Date; status: string };
export type Blocked = { resourceId: string; start: Date; end: Date; reason: string };

export type Verdict =
  | { result: 'accept' }
  | { result: 'refuse'; reason: string }
  | { result: 'draft'; reason: string };

const BUFFER_MS = 4 * 3600_000;

const inShopHours = (t: Date) => {
  const h = t.getHours() + t.getMinutes() / 60;
  return h >= SHOP_OPEN_HOUR && h <= SHOP_CLOSE_HOUR;
};

export function validateEdit(edit: Span, original: Span, others: Span[], blocked: Blocked[]): Verdict {
  if (edit.end <= edit.start) return { result: 'refuse', reason: 'Return must be after pickup' };
  if (original.status === 'picked_up' && edit.resourceId !== original.resourceId)
    return { result: 'refuse', reason: 'Picked-up rentals never change unit' };
  if (original.status === 'picked_up' && edit.end < original.end)
    return { result: 'refuse', reason: 'Only the owner can shorten a picked-up rental (manual edit flow)' };
  if (original.status !== 'picked_up' && edit.start < NOW) return { result: 'refuse', reason: 'Pickup is in the past' };
  if (!inShopHours(edit.start) || !inShopHours(edit.end))
    return { result: 'refuse', reason: `Pickups and returns are ${SHOP_OPEN_HOUR}:00–${SHOP_CLOSE_HOUR}:00` };
  if (edit.resourceId === 'unassigned') return { result: 'accept' };

  const occupied = (s: Span) => [s.start.getTime(), s.end.getTime() + BUFFER_MS] as const;
  const [a0, a1] = occupied(edit);
  for (const o of others) {
    if (o.id === edit.id || o.resourceId !== edit.resourceId) continue;
    const [b0, b1] = occupied(o);
    if (a0 < b1 && b0 < a1) return { result: 'draft', reason: `Overlaps ${o.id} (incl. 4h buffer)` };
  }
  for (const b of blocked) {
    if (b.resourceId !== edit.resourceId) continue;
    if (a0 < b.end.getTime() && b.start.getTime() < a1) return { result: 'draft', reason: `Unit unavailable: ${b.reason}` };
  }
  return { result: 'accept' };
}

export const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
