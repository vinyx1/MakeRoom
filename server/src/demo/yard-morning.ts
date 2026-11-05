// Monday morning at the yard: four problems already in progress when the visitor arrives. Nothing here is staged: each
// goes through the same flow as a customer's chat or an owner's drag, with real sandbox holds. The chat lines are what
// those customers said before the visitor arrived, and the agent's replies quote the proposal's own numbers.

import { and, eq, inArray } from 'drizzle-orm';
import { conversationOf } from '../agent/turn.ts';
import type { Db } from '../db/client.ts';
import * as s from '../db/schema.ts';
import type { YardShop } from '../db/seed-yard.ts';
import { ownerEditBooking } from '../owner/edit-booking.ts';
import type { PaymentGateway } from '../payments/gateway.ts';
import { createRequesterOrder, requestChange, requesterAccept, resolveDraft } from '../proposals/flow.ts';

const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export type MorningResult = { opened: string[]; failed: { problem: string; reason: string }[] };

export async function openYardMorning(db: Db, gateway: PaymentGateway, d: YardShop): Promise<MorningResult> {
  const shopId = d.shop.id;
  const result: MorningResult = { opened: [], failed: [] };

  const say = async (customerId: string, author: 'customer' | 'agent', body: string) => {
    const [shop] = await db.select().from(s.shops).where(eq(s.shops.id, shopId));
    const at = new Date(Date.now() + shop!.clockOffsetMs);
    const conversation = await conversationOf(db, shopId, customerId, at);
    await db.insert(s.messages).values({ shopId, conversationId: conversation.id, author, body, at });
  };

  /** A contractor asked for more time in chat, accepted the offer and placed the hold. */
  const extendAndHold = async (name: string, label: string, until: Parameters<YardShop['t']>[0], asked: string, reply: (charge: string) => string) => {
    const b = d.bookingOn(name, label);
    const customerId = b.customerId;
    const offered = await requestChange(db, shopId, { customerId, request: { kind: 'extend', bookingId: b.id, newEndsAt: d.t(until) } });
    if (offered.status !== 'offered') throw new Error(`no offer: ${offered.status}`);
    const order = await createRequesterOrder(db, gateway, shopId, { proposalId: offered.proposal.id, customerId, testCard: true });
    if (order.status !== 'ok') throw new Error(`no hold: ${order.status}`);
    const accepted = await requesterAccept(db, gateway, shopId, { proposalId: offered.proposal.id, customerId });
    if (accepted.status !== 'awaiting_approvals') throw new Error(`not waiting on anyone: ${accepted.status}`);
    await say(customerId, 'customer', asked);
    await say(customerId, 'agent', reply(usd(offered.chargeCents)));
    // Their status card, in the same place in the chat as if they had just paid.
    const [shop] = await db.select().from(s.shops).where(eq(s.shops.id, shopId));
    const conversation = await conversationOf(db, shopId, customerId, new Date(Date.now() + shop!.clockOffsetMs));
    await db.insert(s.messages).values({
      shopId, conversationId: conversation.id, author: 'system', body: '',
      cardRevisionIds: offered.revisions.map((r) => r.id), at: new Date(Date.now() + shop!.clockOffsetMs),
    });
  };

  const attempt = async (problem: string, run: () => Promise<void>) => {
    try {
      await run();
      result.opened.push(problem);
    } catch (e) {
      // A problem that can't open leaves an ordinary booking behind: the shop still works.
      result.failed.push({ problem, reason: (e as Error).message });
    }
  };

  // Order matters: each request's claims are in place before the next is planned, as they would be on the day.
  await attempt('over_limit', () =>
    extendAndHold('Redwood Utilities', 'U35-1', { day: 'Tue', hour: 17 },
      "Trench flooded over the weekend, we lost two days. Can we keep the U35 until Tuesday 5pm?",
      (charge) => `Tuesday 5pm would be ${charge} for the extra day, and your hold is in place. Another customer has that machine from Tuesday morning, so the fix needs the shop's sign-off. I'll update you as soon as they've looked at it.`),
  );

  await attempt('rain_delay', () =>
    extendAndHold('Harbor Concrete', 'S66-1', { day: 'Wed', hour: 10 },
      'Rain pushed our pour. We need the skid steer until Wednesday 10am.',
      (charge) => `Wednesday 10am would be ${charge} for the extra time, and your hold is in place. Another customer has that machine booked, so I'm checking a rearrangement with them. Nothing is charged until it's settled.`),
  );

  await attempt('last_telehandler', () =>
    extendAndHold('Pacific Steel', 'JCB507-1', { day: 'Tue', hour: 15 },
      "Steel delivery slipped because of the storm. Can we hold the JCB until Tuesday 3pm?",
      (charge) => `Tuesday 3pm would be ${charge} for the extra day, and your hold is in place. Another customer is booked on it from Tuesday morning, so I'm asking them about taking a different machine. Nothing is charged until they answer.`),
  );

  // The one that came in by phone: the owner dragged it, then asked the assistant to resolve it.
  await attempt('site_fit', async () => {
    const summit = d.bookingOn('Summit Grading', 'U55-2');
    const edit = await ownerEditBooking(db, gateway, shopId, {
      bookingId: summit.id, unitId: summit.unitId!, startsAt: summit.startsAt, endsAt: d.t({ day: 'Tue', hour: 16 }),
      basedOnVersion: summit.version, attestedCustomerIds: [summit.customerId],
    });
    if (edit.status !== 'draft') throw new Error(`no draft: ${edit.status}`);
    const resolved = await resolveDraft(db, shopId, { draftId: edit.draftId });
    if (resolved.status !== 'resolved') throw new Error(`not resolved: ${resolved.status}`);
  });

  return result;
}

/** Open problems, for tests and the smoke check: requester name and proposal state. */
export async function openProblems(db: Db, shopId: string) {
  const rows = await db
    .select({ state: s.proposals.state, requester: s.customers.name })
    .from(s.proposals)
    .innerJoin(s.customers, eq(s.proposals.requesterCustomerId, s.customers.id))
    .where(and(eq(s.proposals.shopId, shopId), inArray(s.proposals.state, ['DRAFT', 'AWAITING_APPROVALS'])));
  return rows;
}
