// Layout: a sidebar and top bar around one sheet. On the sheet, the schedule across the top; below it the owner's
// decisions, the owner's messages, and one customer's chat (switchable), so cause and effect are in one frame.

import { DateTime } from 'luxon';
import { PayPalProvider } from '@paypal/react-paypal-js/sdk-v6';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type Config, type Outcome, type OwnerView, api } from './api';
import { ChatPane } from './components/ChatPane';
import { EditDialog, type EditPrompt, EquipmentDrawer, Help, Mark, Sidebar, type Toast, Toasts, TopBar } from './components/Chrome';
import { OwnerMessages } from './components/OwnerMessages';
import { OwnerPanel } from './components/OwnerPanel';
import { type EditRequest, Schedule } from './components/Schedule';
import { isTyping, shopTime, usd, useShop } from './live';

export function App() {
  const [config, setConfig] = useState<Config | null>(null);
  useEffect(() => {
    void api.config().then(setConfig);
  }, []);
  const shop = useShop();

  if (shop.error)
    return (
      <main className="splash">
        <h1><Mark /> MakeRoom</h1>
        <div className="error">Can't load the demo: {shop.error}</div>
      </main>
    );
  if (!config || !shop.owner)
    return (
      <main className="splash">
        <h1><Mark /> MakeRoom</h1>
        <div>Setting up your demo shop…</div>
        <div className="muted">The demo bookings are being prepaid in the PayPal sandbox. This takes a few seconds.</div>
      </main>
    );
  const page = <Shop config={config} shop={shop} />;
  // The PayPal button needs the SDK; without a client id the rest of the demo still works.
  return config.paypalClientId ? (
    <PayPalProvider clientId={config.paypalClientId} environment="sandbox" components={['paypal-payments']} pageType="checkout">
      {page}
    </PayPalProvider>
  ) : (
    page
  );
}

const WAITING_ON: Record<string, string> = { owner: 'the shop', affected: 'the other customer', requester: 'the customer to accept and pay' };

/** What this customer is to the schedule right now, in the words on their chat's header. */
function roleIn(owner: OwnerView, customerId: string): string {
  const open = owner.proposals.filter((p) => p.revisions.length > 0);
  if (open.some((p) => p.requesterCustomerId === customerId)) return 'Asking for a change';
  if (open.some((p) => p.revisions.some((r) => r.changes.some((c) => c.partyCustomerId === customerId))))
    return 'Affected by a request';
  return 'Customer';
}

/** Other customers with a card asking them to decide, in the same terms as their own chat shows it. */
function waitingOn(owner: OwnerView, playing: string) {
  const ids = new Set<string>();
  for (const p of owner.proposals) {
    if (p.state === 'DRAFT' && p.requesterCustomerId) ids.add(p.requesterCustomerId);
    if (p.state !== 'AWAITING_APPROVALS') continue;
    const approvals = p.revisions.flatMap((r) => r.approvals.filter((a) => a.role === 'affected'));
    const answered = new Set(approvals.filter((a) => a.status === 'approved').map((a) => a.customerId));
    for (const r of p.revisions) {
      const ownerOk = r.approvals.some((a) => a.role === 'owner' && a.status === 'approved');
      if (r.envelopeTrips.length && !ownerOk) continue;
      for (const a of r.approvals) if (a.role === 'affected' && a.status === 'pending' && a.customerId && !answered.has(a.customerId)) ids.add(a.customerId);
    }
  }
  ids.delete(playing);
  return owner.customers.filter((c) => ids.has(c.id));
}

function describe(o: Outcome): Omit<Toast, 'id'> {
  switch (o.status) {
    case 'committed':
      return { kind: 'ok', text: 'Confirmed: the schedule is updated.' };
    case 'awaiting_approvals':
      return { kind: 'ok', text: `Done. Waiting on ${(o.waitingOn ?? ['the others']).map((w: string) => WAITING_ON[w] ?? w).join(' and ')}.` };
    case 'already_accepted':
    case 'already_decided':
      return { kind: 'ok', text: 'Already done.' };
    case 'kept':
      return {
        kind: 'ok',
        text: {
          other_options: 'Booking kept as is. The other options stay open.',
          fallback: 'Booking kept as is. The assistant is trying another plan.',
          alternative: 'Booking kept as is. The requester gets the closest alternative.',
          ended: 'Booking kept as is. The request is closed and its payment hold released.',
        }[o.next as string] ?? 'Booking kept as is.',
      };
    case 'resolved':
      return { kind: 'ok', text: 'The assistant found a plan: review it under Owner.' };
    case 'repriced':
      return { kind: 'ok', text: `New price sent: ${usd(o.chargeCents)}. The customer gets a fresh card.` };
    case 'saved':
      return { kind: 'ok', text: 'Saved as a fact.' };
    case 'applied':
      return { kind: 'ok', text: 'Booking changed. Undo it from the Owner column if you need to.' };
    case 'undone':
      return { kind: 'ok', text: 'Change undone: the booking is back where it was.' };
    case 'discarded':
      return { kind: 'ok', text: 'Draft discarded. Nothing changed.' };
    case 'extended':
      return { kind: 'ok', text: 'Marked overdue. Nothing else is affected, so the booking now runs to the expected return.' };
    case 'planned':
      return { kind: 'ok', text: 'Marked overdue. The next booking is affected: review the plans under Owner.' };
    case 'no_plan':
      return { kind: 'warn', text: "Marked overdue, but nothing makes room for the next booking. You'll need to contact that customer." };
    case 'returned':
      return { kind: 'ok', text: o.ended ? 'Marked returned. The plan made around the late return is no longer needed.' : 'Marked returned.' };
    case 'rejected':
      return { kind: 'warn', text: 'Declined: nothing changes, and any payment hold is released.' };
    case 'cancelled':
      return { kind: 'warn', text: o.reason ?? 'Cancelled.' };
    default:
      return { kind: o.status === 'error' ? 'error' : 'warn', text: o.reason ?? o.status.replaceAll('_', ' ') };
  }
}

function Shop({ config, shop }: { config: Config; shop: ReturnType<typeof useShop> }) {
  const owner = shop.owner!;
  const customers = owner.customers;
  const byName = (n: string) => customers.find((c) => c.name === n)?.id ?? customers[0]!.id;
  const [playing, setPlaying] = useState(() => byName('Alice'));
  const [ownerThread, setOwnerThread] = useState<string | null>(null);
  const [equipment, setEquipment] = useState(false);
  const [help, setHelp] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [prompt, setPrompt] = useState<EditPrompt | null>(null);
  const nextToast = useRef(0);

  // After a reset the customers have new ids; point the panes at the same names again.
  useEffect(() => {
    if (!customers.some((c) => c.id === playing)) setPlaying(byName('Alice'));
    if (ownerThread && !customers.some((c) => c.id === ownerThread)) setOwnerThread(null);
  }, [customers]);

  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++nextToast.current;
    setToasts((all) => [...all, { ...t, id }]);
    window.setTimeout(() => setToasts((all) => all.filter((x) => x.id !== id)), t.kind === 'ok' ? 3500 : 7000);
  }, []);
  const onOutcome = useCallback((o: Outcome) => {
    toast(describe(o));
    void shop.refresh();
  }, [shop.refresh, toast]);

  // Owner drag or resize: ask "agreed by phone?", send it, and handle the pending-request warning.
  const onEdit = useCallback(
    async (edit: EditRequest): Promise<boolean> => {
      const zone = owner.shop.timezone;
      if (!edit.unitId) {
        toast({ kind: 'warn', text: "A booking can't be moved to Unassigned by hand." });
        return false;
      }
      const unit = owner.units.find((u) => u.id === edit.unitId)?.label;
      const summary = `${unit}: ${shopTime(edit.startsAt, zone)} → ${shopTime(edit.endsAt, zone)}`;
      const answer = await new Promise<{ agreed: boolean } | null>((resolve) => setPrompt({ step: 'confirm', name: edit.name, summary, resolve }));
      setPrompt(null);
      if (!answer) return false;
      const customerId = owner.bookings.find((b) => b.id === edit.bookingId)?.customerId;
      const body = {
        unitId: edit.unitId, startsAt: edit.startsAt.toISOString(), endsAt: edit.endsAt.toISOString(), basedOnVersion: edit.version,
        attestedCustomerIds: answer.agreed && customerId ? [customerId] : [],
      };
      let result = await api.editBooking(edit.bookingId, body);
      if (result.status === 'claimed') {
        const override = await new Promise<boolean>((resolve) =>
          setPrompt({ step: 'claimed', name: edit.name, requesters: (result.proposals ?? []).map((p) => p.requesterName ?? 'Another customer'), resolve }),
        );
        setPrompt(null);
        if (!override) return false;
        result = await api.editBooking(edit.bookingId, { ...body, override: true });
      }
      if (result.status === 'draft') toast({ kind: 'warn', text: `Kept as a red draft: ${(result.violations ?? []).map((v) => v.message).join('; ')}. Use Resolve with agent.` });
      else toast(describe(result));
      void shop.refresh();
      return result.status === 'applied';
    },
    [owner, shop.refresh, toast],
  );

  // Delete on a booking: confirm, with the customer's agreement, then the pending-request warning if one needs it.
  const onCancelBooking = useCallback(
    async ({ bookingId, name, version, status }: { bookingId: string; name: string; version: number; status: string }) => {
      if (status === 'picked_up') {
        toast({ kind: 'warn', text: `${name}'s rental is out with them: mark it returned instead of cancelling it.` });
        return;
      }
      const booking = owner.bookings.find((b) => b.id === bookingId);
      if (!booking) return;
      const zone = owner.shop.timezone;
      const unit = owner.units.find((u) => u.id === booking.unitId)?.label ?? 'Unassigned';
      const confirmed = await new Promise<boolean>((resolve) =>
        setPrompt({ step: 'cancel', name, summary: `${unit}: ${shopTime(booking.startsAt, zone)} → ${shopTime(booking.endsAt, zone)}`, refund: usd(booking.priceCents), resolve }),
      );
      setPrompt(null);
      if (!confirmed) return;
      try {
        const body = { basedOnVersion: version, agreedByPhone: true };
        let result = await api.cancelBooking(bookingId, body);
        if (result.status === 'claimed') {
          const override = await new Promise<boolean>((resolve) =>
            setPrompt({ step: 'claimed', name, requesters: (result.proposals ?? []).map((p) => p.requesterName ?? 'Another customer'), resolve }),
          );
          setPrompt(null);
          if (!override) return;
          result = await api.cancelBooking(bookingId, { ...body, override: true });
        }
        if (result.status === 'cancelled')
          toast(result.refundsOk === false
            ? { kind: 'error', text: `${name}'s booking is cancelled, but the refund didn't go through. See your cards.` }
            : { kind: 'ok', text: `${name}'s booking is cancelled${result.refundCents ? `, and ${usd(result.refundCents)} is refunded` : ''}.` });
        else toast(describe(result));
      } catch (e) {
        toast({ kind: 'error', text: (e as Error).message });
      }
      void shop.refresh();
    },
    [owner, shop.refresh, toast],
  );

  // Resolve with agent acts on the customer's behalf: if their agreement wasn't ticked at the drag, ask now.
  const onResolveDraft = useCallback(
    async (draftId: string) => {
      const draft = owner.drafts.find((d) => d.id === draftId);
      const booking = owner.bookings.find((b) => b.id === draft?.bookingId);
      let agreedByPhone = false;
      if (draft && booking && !draft.attestedCustomerIds.includes(booking.customerId)) {
        const name = customers.find((c) => c.id === booking.customerId)?.name ?? 'The customer';
        const zone = owner.shop.timezone;
        const summary = `${name}'s booking → ${shopTime(draft.proposed.startsAt!, zone)} – ${shopTime(draft.proposed.endsAt!, zone)}`;
        agreedByPhone = await new Promise<boolean>((resolve) => setPrompt({ step: 'agree', name, summary, resolve }));
        setPrompt(null);
        if (!agreedByPhone) return;
      }
      onOutcome(await api.resolveDraft(draftId, agreedByPhone));
    },
    [owner, customers, onOutcome],
  );

  const onReturned = useCallback(
    async (bookingId: string) => {
      try {
        onOutcome(await api.markReturned(bookingId));
      } catch (e) {
        toast({ kind: 'error', text: (e as Error).message });
      }
    },
    [onOutcome, toast],
  );

  // Mark overdue: ask when the customer now expects to bring it back (shop time), then re-plan around it.
  const onMarkOverdue = useCallback(
    async (bookingId: string) => {
      const booking = owner.bookings.find((b) => b.id === bookingId);
      if (!booking) return;
      const zone = owner.shop.timezone;
      const name = customers.find((c) => c.id === booking.customerId)?.name ?? 'The customer';
      // A default inside shop hours: two hours from now, or 10am the next day after closing.
      let guess = DateTime.fromISO(owner.shop.now, { zone }).plus({ hours: 2 }).startOf('hour');
      const [open, close] = [Number(owner.shop.opensAt.slice(0, 2)), Number(owner.shop.closesAt.slice(0, 2))];
      if (guess.hour >= close || guess.hour < open) guess = guess.plus({ days: guess.hour >= close ? 1 : 0 }).set({ hour: open + 1 });
      const summary = `Due back ${shopTime(booking.endsAt, zone)}.`;
      const expected = await new Promise<string | null>((resolve) =>
        setPrompt({ step: 'overdue', name, summary, initial: guess.toFormat("yyyy-LL-dd'T'HH:mm"), resolve }),
      );
      setPrompt(null);
      if (!expected) return;
      onOutcome(await api.markOverdue(bookingId, DateTime.fromISO(expected, { zone }).toISO()!));
    },
    [owner, customers, onOutcome],
  );

  return (
    <div className="app">
      <Sidebar
        owner={owner}
        onReset={() => void shop.reset()}
        onEquipment={() => setEquipment(true)}
        onHelp={() => setHelp(true)}
      />
      <TopBar
        owner={owner}
        shopNow={shop.shopNow!}
        onFastForward={async (m) => {
          const r = await api.fastForward(m);
          toast({ kind: 'ok', text: `Shop clock +${m} min${r.expired.length ? `; ${r.expired.length} offer${r.expired.length === 1 ? '' : 's'} expired` : ''}.` });
          void shop.refresh();
        }}
      />
      <main className="sheet">
      <Schedule owner={owner} shopNow={shop.shopNow!} onEdit={onEdit} onResolveDraft={onResolveDraft} onCancel={onCancelBooking} onReturned={onReturned} onMarkOverdue={onMarkOverdue} />
      <div className="bottom">
        <OwnerPanel owner={owner} activity={shop.activity} onOutcome={onOutcome} onOpenChat={setOwnerThread} onResolveDraft={onResolveDraft} onMarkOverdue={onMarkOverdue} />
        <OwnerMessages
          owner={owner}
          openId={ownerThread}
          onOpen={setOwnerThread}
          typing={(id) => isTyping(shop.activity, id)}
          onOutcome={onOutcome}
          onChanged={() => void shop.refresh()}
        />
        <ChatPane
          customerId={playing}
          customers={customers}
          onCustomer={setPlaying}
          config={config}
          zone={owner.shop.timezone}
          tick={shop.tick}
          typing={isTyping(shop.activity, playing)}
          role={roleIn(owner, playing)}
          waitingOn={waitingOn(owner, playing)}
          onOutcome={onOutcome}
        />
      </div>
      </main>
      {equipment && <EquipmentDrawer owner={owner} onClose={() => setEquipment(false)} />}
      {help && <Help onClose={() => setHelp(false)} />}
      {prompt && <EditDialog prompt={prompt} />}
      <Toasts toasts={toasts} />
    </div>
  );
}
