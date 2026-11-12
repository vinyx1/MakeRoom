// A request that only moves later renters to another unit of the same model needs nobody's answer. It must offer a
// single plan, so that once the requester has paid, it goes straight to capture and the swapped customers are told.
// (With two plans differing only in which unit, no one was ever asked to pick: the request sat until it expired and
// the requester's hold was released.) Which customers swap depends on how the optimizer breaks ties between equal
// plans, so the tests read the swaps from the plan instead of naming anyone.

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

async function charlieExtendsAndPays(storyDay: number, hour: number) {
  const gateway = fakeGateway();
  const d = await seedShop(db, { sessionKey: randomUUID() });
  await seedPrepayments(db, gateway, d.shop.id);
  const charlie = d.customer('Charlie').id;
  const offered = await requestChange(db, d.shop.id, { customerId: charlie, request: { kind: 'extend', bookingId: d.bookingOf('Charlie').id, newEndsAt: at(d, storyDay, hour) } });
  if (offered.status !== 'offered') throw new Error(JSON.stringify(offered));
  expect(offered.revisions).toHaveLength(1);
  const changes = await db.select().from(s.revisionChanges).where(eq(s.revisionChanges.revisionId, offered.revisions[0]!.id));
  const swaps = changes.filter((c) => c.partyCustomerId !== charlie);
  await createRequesterOrder(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: charlie });
  const accepted = await requesterAccept(db, gateway, d.shop.id, { proposalId: offered.proposal.id, customerId: charlie });
  return { d, charlie, offered, swaps, accepted };
}

async function expectSwapsCommittedAndTold(run: Awaited<ReturnType<typeof charlieExtendsAndPays>>) {
  const { offered, swaps, accepted, charlie } = run;
  expect(swaps.length).toBeGreaterThan(0);
  expect(swaps.every((c) => c.kind === 'same_model_swap' && !c.requiresApproval)).toBe(true);
  expect(accepted.status).toBe('committed');
  for (const c of swaps) {
    const [booking] = await db.select().from(s.bookings).where(eq(s.bookings.id, c.bookingId!));
    expect(booking!.unitId).toBe(c.newUnitId);
  }
  const told = (await db.select().from(s.activityLog).where(eq(s.activityLog.proposalId, offered.proposal.id)))
    .filter((a) => a.kind === 'proposal_update')
    .map((a) => (a.payload as { customerId: string }).customerId);
  expect(told).toEqual(expect.arrayContaining([charlie, ...swaps.map((c) => c.partyCustomerId)]));
}

describe('plans nobody has to answer for', () => {
  it('Charlie keeps the A7 IV until Saturday: one plan, it commits when he accepts, and whoever swapped units is told', async () => {
    await expectSwapsCommittedAndTold(await charlieExtendsAndPays(5, 10));
  });

  it('until next Monday it reaches further down the line: still one plan, committed, everyone swapped is told', async () => {
    await expectSwapsCommittedAndTold(await charlieExtendsAndPays(7, 14));
  });
});
