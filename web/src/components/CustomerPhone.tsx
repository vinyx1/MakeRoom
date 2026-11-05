// The customer's side of the demo, as a phone that slides in beside the shop's screen. The visitor picks whose phone
// it is from the accounts along the top. It stays mounted while closed, so a half-written message or an open PayPal
// button survives closing it.

import { DateTime } from 'luxon';
import { type ComponentProps, useEffect, useRef } from 'react';
import type { Customer } from '../api';
import { ChatPane } from './ChatPane';
import { Avatar } from './Chrome';

type Props = Omit<ComponentProps<typeof ChatPane>, 'typing' | 'role' | 'waitingOn'> & {
  open: boolean;
  now: Date;
  onClose: () => void;
  typing: boolean;
  role: string;
  waitingOn: Customer[];
};

export function CustomerPhone({ open, now, onClose, ...chat }: Props) {
  const { customers, customerId, onCustomer, waitingOn, zone, role } = chat;
  const name = customers.find((c) => c.id === customerId)?.name ?? '';
  // Keep the open account in view when there are more than fit. Scrolls only this strip, never the panel around a closed phone.
  const accounts = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = accounts.current;
    const on = strip?.querySelector<HTMLElement>('.phone-account.on');
    if (strip && on) strip.scrollLeft = on.offsetLeft - strip.offsetLeft - (strip.clientWidth - on.offsetWidth) / 2;
  }, [customerId]);
  return (
    <div className={`phone-slot ${open ? 'open' : ''}`} inert={!open}>
      <aside className="phone" aria-label={`${name}'s phone`}>
        <div className="phone-screen">
          <div className="phone-status">
            <span>{DateTime.fromJSDate(now, { zone }).toFormat('h:mm')}</span>
            <span className="phone-island" aria-hidden="true" />
            <button className="phone-close" onClick={onClose} aria-label="Close the customer phone">Close</button>
          </div>
          <div className="phone-accounts" ref={accounts} role="tablist" aria-label="Customer accounts">
            {customers.map((c) => (
              <button
                key={c.id}
                role="tab"
                aria-selected={c.id === customerId}
                className={`phone-account ${c.id === customerId ? 'on' : ''}`}
                onClick={() => onCustomer(c.id)}
              >
                <span className="phone-avatar">
                  <Avatar name={c.name} />
                  {waitingOn.some((w) => w.id === c.id) && <span className="phone-dot" aria-label="Has an offer to answer" />}
                </span>
                <span className="phone-account-name">{c.name.split(' ')[0]}</span>
              </button>
            ))}
          </div>
          <div className="phone-who">
            <b>{name}</b>
            <span>{role}</span>
          </div>
          <ChatPane {...chat} />
          <div className="phone-home" aria-hidden="true" />
        </div>
      </aside>
    </div>
  );
}
