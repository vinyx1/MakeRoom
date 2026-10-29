// The shop as the browser sees it: the owner view, kept current by the server's SSE activity stream. Every event
// bumps `tick` (customer panes refetch on it) and schedules one owner-view refresh.

import { DateTime } from 'luxon';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type Activity, type OwnerView, api } from './api';

export function useShop() {
  const [owner, setOwner] = useState<OwnerView | null>(null);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [activity, setActivity] = useState<Activity[]>([]);
  const [tick, setTick] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const view = await api.owner();
    setOwner(view);
    setFetchedAt(Date.now());
    return view;
  }, []);

  useEffect(() => {
    let source: EventSource | null = null;
    let closed = false;
    (async () => {
      try {
        const view = await refresh();
        if (closed) return;
        setActivity(view.activity);
        setError(null);
        source = new EventSource(`/api/events?after=${view.activity[0]?.seq ?? 0}`);
        source.addEventListener('activity', (e) => {
          const row = JSON.parse((e as MessageEvent).data) as Activity;
          setActivity((prev) => (prev.some((a) => a.seq === row.seq) ? prev : [row, ...prev].slice(0, 400)));
          setTick((t) => t + 1);
          if (pending.current) window.clearTimeout(pending.current);
          pending.current = window.setTimeout(() => void refresh().catch(() => {}), 200);
        });
      } catch (e) {
        setError(String((e as Error).message ?? e));
      }
    })();
    return () => {
      closed = true;
      source?.close();
    };
  }, [epoch, refresh]);

  /** Reset demo: the shop is reseeded under a new id, so the stream reconnects. */
  const reset = useCallback(async () => {
    setOwner(null);
    await api.reset();
    setActivity([]);
    setEpoch((x) => x + 1);
  }, []);

  /** The shop clock, ticking: the server's "now" plus the time since it was fetched. */
  const shopNow = owner ? new Date(new Date(owner.shop.now).getTime() + (Date.now() - fetchedAt)) : null;

  return { owner, activity, tick, refresh, reset, shopNow, error };
}

/** Whether the assistant is busy on a customer's thread: a trigger newer than their last finished turn. */
export function isTyping(activity: Activity[], customerId: string) {
  const forCustomer = (a: Activity) => a.payload?.customerId === customerId;
  const lastTurn = activity.find((a) => a.kind === 'agent_turn' && forCustomer(a));
  const lastTrigger = activity.find(
    (a) => forCustomer(a) && ['customer_message', 'agent_step', 'offer_ready', 'proposal_update', 'fact_answered'].includes(a.kind),
  );
  if (!lastTrigger) return false;
  // Activity times are on the shop clock, so order by sequence, not by time.
  return !lastTurn || lastTurn.seq < lastTrigger.seq;
}

export const shopTime = (iso: string | Date, zone: string, format = 'ccc h:mma') =>
  DateTime.fromJSDate(typeof iso === 'string' ? new Date(iso) : iso, { zone })
    .setLocale('en-US')
    .toFormat(format)
    .replace('AM', 'am')
    .replace('PM', 'pm');

export const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
