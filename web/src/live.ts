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
  // The clock keeps moving between server updates.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setClockTick((n) => n + 1), 20_000);
    return () => window.clearInterval(timer);
  }, []);
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

const STEP: Record<string, string> = {
  get_my_bookings: 'Looked up the bookings',
  get_my_proposals: 'Looked up open requests',
  search_inventory: 'Searched the equipment',
  check_availability: 'Checked the schedule',
  get_fact: 'Checked an equipment fact',
  get_policy: 'Read the shop policy',
  preview_change: 'Ran the optimizer',
  request_change: 'Planned the change',
  revise_terms: 'Revised the offer',
  present_offer: 'Prepared the offer',
  ask_owner_fact: 'Asked the shop',
  escalate_to_owner: 'Asked the shop',
  send_message: 'Sent a message',
};

/** The tools the assistant has finished in its current turn for this customer, oldest first, in plain words. */
export function agentSteps(activity: Activity[], customerId: string): string[] {
  if (!isTyping(activity, customerId)) return [];
  const lastTurn = activity.find((a) => a.kind === 'agent_turn' && a.payload?.customerId === customerId);
  const steps = activity.filter((a) => a.kind === 'agent_step' && a.payload?.customerId === customerId && (!lastTurn || a.seq > lastTurn.seq));
  const words = steps.reverse().map((a) => STEP[a.payload.tool as string] ?? 'Working');
  return words.filter((w, i) => w !== words[i - 1]);
}

export const shopTime = (iso: string | Date, zone: string, format = 'ccc h:mma') =>
  DateTime.fromJSDate(typeof iso === 'string' ? new Date(iso) : iso, { zone })
    .setLocale('en-US')
    .toFormat(format)
    .replace('AM', 'am')
    .replace('PM', 'pm');

export const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
