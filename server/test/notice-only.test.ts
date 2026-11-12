// A request that only moves later renters to another unit of the same model needs nobody's answer. It must offer a
// single plan, so that once the requester has paid, it goes straight to capture and the swapped customers are told.
// (With two plans differing only in which unit, no one was ever asked to pick: the request sat until it expired and
// the requester's hold was released.)

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.ts';
import * as s from '../src/db/schema.ts';
import { seedShop } from '../src/db/seed.ts';
import { seedPrepayments } from '../src/payments/prepay.ts';
import { createRequesterOrder, requestChange, requesterAccept } from '../src/proposals/flow.ts';
import { fakeGateway } from './fake-gateway.ts';

const { db, pool } = createDb();
afterAll(() => pool.end());

type Seeded = Awaited<ReturnType<typeof seedShop>>;

/** A story day (Mon = 0 … Wed = today, Sat = 5, next Mon = 7) at an hour, shop time. */
function at(d: Seeded, storyDay: number, hour: number) {
  return DateTime.fromJSDate(d.now, { zone: d.shop.timezone }).startOf('day').minus({ days: 2 }).plus({ days: storyDay }).set({ hour }).toJSDate();
}

async function charlieExtends(storyDay: number, hour: number) {
  const gateway = fakeGateway();
  const d = await seedShop(db, { sessionKey: randomUUID() });
  await seedPrepayments(db, gateway, d.shop.id);
  const charlie = d.customer('Charlie').id;
  const offered = await requestChange(db, d.shop.id, { customerId: charlie, request: { kind: 'extend', bookingId: d.bookingOf('Charlie').id, newEndsAt: at(d, storyDay, hour) } });
  if (offered.status !== 'offered') throw new Error(JSON.stringify(offered));
  return { gateway, d, charlie, offered };
}

const bookingOf = async (id: string) => (await db.select().from(s.bookings).where(eq(s.bookings.id, id)))[0]!;
const updates = async (proposalId: string) => db.select().from(s.activityLog).where(eq(s.activityLog.proposalId, proposalId));

describe('plans nobody has to answer for', () => {
  it('Charlie keeps the A7 IV until Saturday: one plan, Gina swaps units, it commits when he accepts, and Gina is told', async () => {
    const { gateway, d, charlie, offered } = await charlieExtends(5, 10);
    expect(offered.revisions).toHaveLength(1);
    console.log('CHANGES', JSON.stringify((await db.select().from(s.revisionChanges).where(eq(s.revisionChanges.revisionId, offered.revisions[0]!.id))).map((c) => [c.kind, c.bookingId === d.bookingOf('Gina').id ? 'Gina' : c.bookingId === d.bookingOf('Charlie').id ? 'Charlie' : '?', c.newUnitId, d.units.find((u) => u.id === c.newUnitId)?.label])));
    await createRequesterOrder(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: charlie });
    const accepted = await requesterAccept(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: charlie });
    expect(accepted.status).toBe('committed');
    console.log('GINA', d.units.find((u) => u.id === d.bookingOf('Gina').unitId)?.label, (await bookingOf(d.bookingOf('Gina').id)).unitId === d.bookingOf('Gina').unitId);

    const gina = await bookingOf(d.bookingOf('Gina').id);
    expect(gina.unitId).not.toBe(d.bookingOf('Gina').unitId);
    expect(gina.startsAt).toEqual(d.bookingOf('Gina').startsAt);
    const told = (await updates(offered.proposal.id)).filter((a) => a.kind === 'proposal_update').map((a) => (a.payload as { customerId: string }).customerId);
    expect(told).toEqual(expect.arrayContaining([charlie, d.customer('Gina').id]));
  });

  it('until next Monday: Gina and Hank both swap, still one plan, both are told', async () => {
    const { gateway, d, charlie, offered } = await charlieExtends(7, 14);
    expect(offered.revisions).toHaveLength(1);

    await createRequesterOrder(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: charlie });
    const accepted = await requesterAccept(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: charlie });
    expect(accepted.status).toBe('committed');

    for (const name of ['Gina', 'Hank'] as const) expect((await bookingOf(d.bookingOf(name).id)).unitId).not.toBe(d.bookingOf(name).unitId);
    const told = (await updates(offered.proposal.id)).filter((a) => a.kind === 'proposal_update').map((a) => (a.payload as { customerId: string }).customerId);
    expect(told).toEqual(expect.arrayContaining([d.customer('Gina').id, d.customer('Hank').id]));
  });
});
