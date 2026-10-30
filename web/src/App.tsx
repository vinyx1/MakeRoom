// Layout: the schedule across the top; below it the owner, then two customer chats (requester and affected party,
// each switchable), so cause and effect are in one frame.

import { PayPalProvider } from '@paypal/react-paypal-js/sdk-v6';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type Config, type Outcome, api } from './api';
import { ChatPane } from './components/ChatPane';
import { EditDialog, type EditPrompt, EquipmentDrawer, Header, Help, type Toast, Toasts } from './components/Chrome';
import { OwnerPanel } from './components/OwnerPanel';
import { type EditRequest, Schedule } from './components/Schedule';
import { isTyping, shopTime, usd, useShop } from './live';

export function App() {
  const [config, setConfig] = useState<Config | null>(null);
  useEffect(() => {
    void api.config().then(setConfig);
  }, []);
  const shop = useShop();

  if (shop.error) return <div className="splash error">Can't reach the RentFlow server: {shop.error}</div>;
  if (!config || !shop.owner)
    return (
      <div className="splash">
        <div className="spinner" />
        Setting up your demo shop… <span className="muted">(the demo bookings are being prepaid in the PayPal sandbox)</span>
      </div>
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
  const [left, setLeft] = useState(() => byName('Alice'));
  const [right, setRight] = useState(() => byName('Bob'));
  const [equipment, setEquipment] = useState(false);
  const [help, setHelp] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [prompt, setPrompt] = useState<EditPrompt | null>(null);
  const nextToast = useRef(0);

  // After a reset the customers have new ids; point the panes at the same names again.
  useEffect(() => {
    if (!customers.some((c) => c.id === left)) setLeft(byName('Alice'));
    if (!customers.some((c) => c.id === right)) setRight(byName('Bob'));
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

  return (
    <div className="app">
      <Header
        owner={owner}
        shopNow={shop.shopNow!}
        onFastForward={async (m) => {
          const r = await api.fastForward(m);
          toast({ kind: 'ok', text: `Shop clock +${m} min${r.expired.length ? `; ${r.expired.length} offer${r.expired.length === 1 ? '' : 's'} expired` : ''}.` });
          void shop.refresh();
        }}
        onAutoReply={async (on) => {
          await api.autoReply(on);
          void shop.refresh();
        }}
        onReset={() => void shop.reset()}
        onEquipment={() => setEquipment(true)}
        onHelp={() => setHelp(true)}
      />
      <Schedule owner={owner} shopNow={shop.shopNow!} onEdit={onEdit} onResolveDraft={onResolveDraft} />
      <div className="bottom">
        <OwnerPanel owner={owner} activity={shop.activity} onOutcome={onOutcome} onOpenChat={setLeft} onResolveDraft={onResolveDraft} />
        {[
          [left, setLeft],
          [right, setRight],
        ].map(([id, set], i) => (
          <ChatPane
            key={i}
            customerId={id as string}
            customers={customers}
            onCustomer={set as (id: string) => void}
            config={config}
            zone={owner.shop.timezone}
            tick={shop.tick}
            typing={isTyping(shop.activity, id as string)}
            onOutcome={onOutcome}
          />
        ))}
      </div>
      {equipment && <EquipmentDrawer owner={owner} onClose={() => setEquipment(false)} />}
      {help && <Help onClose={() => setHelp(false)} />}
      {prompt && <EditDialog prompt={prompt} />}
      <Toasts toasts={toasts} />
    </div>
  );
}
