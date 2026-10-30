// `proposals.request` stores the optimizer's request as JSON, so a cancelled or expired proposal can be re-planned.

import type { Request } from '../optimizer/optimizer.ts';

export type StoredRequest =
  | { kind: 'extend'; bookingId: string; newEndsAt: string; forced?: boolean }
  | { kind: 'shift'; bookingId: string; newStartsAt?: string; newEndsAt?: string }
  | { kind: 'new_booking'; customerId: string; modelId: string; startsAt: string; endsAt: string };

const iso = (d: Date | undefined) => d?.toISOString();
const date = (s: string | undefined) => (s ? new Date(s) : undefined);

export function storeRequest(r: Request): StoredRequest {
  switch (r.kind) {
    case 'extend': return { ...r, newEndsAt: r.newEndsAt.toISOString() };
    case 'shift': return { kind: r.kind, bookingId: r.bookingId, newStartsAt: iso(r.newStartsAt), newEndsAt: iso(r.newEndsAt) };
    case 'new_booking': return { ...r, startsAt: r.startsAt.toISOString(), endsAt: r.endsAt.toISOString() };
  }
}

export function loadRequest(r: StoredRequest): Request {
  switch (r.kind) {
    case 'extend': return { ...r, newEndsAt: new Date(r.newEndsAt) };
    case 'shift': return { kind: r.kind, bookingId: r.bookingId, newStartsAt: date(r.newStartsAt), newEndsAt: date(r.newEndsAt) };
    case 'new_booking': return { ...r, startsAt: new Date(r.startsAt), endsAt: new Date(r.endsAt) };
  }
}
