// The equipment yard: its schedule, the four problems open when a visitor arrives, and how each one plays out on the
// same engine as the camera shop. The fake gateway stands in for PayPal, as in the other scenario tests.

import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.ts';
import * as s from '../src/db/schema.ts';
import { seedYard } from '../src/db/seed.ts';
import { openProblems, openYardMorning } from '../src/demo/yard-morning.ts';
import { loadSnapshot } from '../src/db/load-snapshot.ts';
import { optimize } from '../src/optimizer/optimizer.ts';
import { seedPrepayments } from '../src/payments/prepay.ts';
import { affectedAccept, affectedRefuse, ownerDecision, requestChange } from '../src/proposals/flow.ts';
import { resetShop, shopForSession } from '../src/server/shops.ts';
import { fakeGateway } from './fake-gateway.ts';

const { db, pool } = createDb();
afterAll(() => pool.end());

async function yard() {
  const gateway = fakeGateway();
  const d = await seedYard(db, { sessionKey: randomUUID() });
  await seedPrepayments(db, gateway, d.shop.id);
  const morning = await openYardMorning(db, gateway, d);
  return { d, gateway, morning };
}

const load = {
  booking: async (id: string) => (await db.select().from(s.bookings).where(eq(s.bookings.id, id)))[0]!,
  proposalOf: async (shopId: string, customerId: string) =>
    (await db.select().from(s.proposals).where(and(eq(s.proposals.shopId, shopId), eq(s.proposals.requesterCustomerId, customerId))))[0]!,
  revisions: (proposalId: string) => db.select().from(s.revisions).where(eq(s.revisions.proposalId, proposalId)),
  escalations: (proposalId: string) => db.select().from(s.escalations).where(and(eq(s.escalations.proposalId, proposalId), eq(s.escalations.status, 'open'))),
};

describe('the yard', () => {
  it('seeds 18 machines and 25 bookings, every one prepaid, with no double-booking', async () => {
    const gateway = fakeGateway();
    const d = await seedYard(db, { sessionKey: randomUUID() }); // the exclusion constraint would refuse a clash here
    expect(d.units).toHaveLength(18);
    expect(d.bookings).toHaveLength(25);
    expect(await seedPrepayments(db, gateway, d.shop.id)).toEqual({ paid: 25, failed: [] });
  });

  it('opens all four problems, and leaves each waiting on the right person', async () => {
    const { d, morning } = await yard();
    expect(morning).toEqual({ opened: ['over_limit', 'rain_delay', 'last_telehandler', 'site_fit'], failed: [] });
    expect((await openProblems(db, d.shop.id)).map((p) => [p.requester, p.state]).sort()).toEqual([
      ['Harbor Concrete', 'AWAITING_APPROVALS'],
      ['Pacific Steel', 'AWAITING_APPROVALS'],
      ['Redwood Utilities', 'AWAITING_APPROVALS'],
      ['Summit Grading', 'DRAFT'],
    ]);
  });

  it('the rain delay is a chain of two moves: Delgado decides, Northside only gets a notice', async () => {
    const { d, gateway } = await yard();
    const harbor = d.bookingOn('Harbor Concrete', 'S66-1'), northside = d.bookingOn('Northside Landscaping', 'S66-1'), delgado = d.bookingOn('Delgado Paving', 'S66-2');
    const p = await load.proposalOf(d.shop.id, harbor.customerId);
    const [rev, ...others] = await load.revisions(p.id);
    expect(others).toEqual([]);
    expect(rev!.needsOwner).toBe(false);
    // The feed names who a move would run into, never the customer being moved.
    const feed = await db.select().from(s.activityLog).where(and(eq(s.activityLog.shopId, d.shop.id), eq(s.activityLog.kind, 'optimizer_run')));
    const messages = feed.flatMap((row) => ((row.payload as { pruned: { message: string }[] }).pruned).map((x) => x.message));
    expect(messages).toContain("Move Delgado Paving to S66-1 → overlaps Harbor Concrete's booking on S66-1");
    expect(rev!.quote.chargeCents).toBe(64_000);

    const done = await affectedAccept(db, gateway, d.shop.id, { proposalId: p.id, customerId: delgado.customerId, revisionId: rev!.id });
    expect(done.status).toBe('committed');
    expect((await load.booking(harbor.id)).endsAt).toEqual(d.t({ day: 'Wed', hour: 10 }));
    expect((await load.booking(northside.id)).unitId).toBe(d.unit('S66-2').id);
    expect((await load.booking(delgado.id)).unitId).toBe(d.unit('T66-1').id);
  });

  it('over the limit: the owner reviews before Mesa hears anything', async () => {
    const { d, gateway } = await yard();
    const redwood = d.bookingOn('Redwood Utilities', 'U35-1'), mesa = d.bookingOn('Mesa Septic', 'U35-1');
    const p = await load.proposalOf(d.shop.id, redwood.customerId);
    const [rev] = await load.revisions(p.id);
    expect(rev!.ownerTriggers).toContain('over_cap');
    expect(rev!.envelopeTrips).toContain('compensation_over_revenue');
    expect((await load.escalations(p.id)).map((e) => e.kind)).toEqual(['plan_review']);
    // Mesa can't accept what the shop hasn't reviewed.
    expect((await affectedAccept(db, gateway, d.shop.id, { proposalId: p.id, customerId: mesa.customerId, revisionId: rev!.id })).status).toBe('refused');
    const approved = await ownerDecision(db, gateway, d.shop.id, { proposalId: p.id, revisionId: rev!.id, decision: 'approve' });
    expect(approved.status).not.toBe('refused');
    expect((await affectedAccept(db, gateway, d.shop.id, { proposalId: p.id, customerId: mesa.customerId, revisionId: rev!.id })).status).toBe('committed');
    expect((await load.booking(mesa.id)).unitId).toBe(d.unit('U55-1').id);
  });

  it('site fit: the Cat 308 needs the owner to answer for the gate, and a No ends the plan', async () => {
    const { d, gateway } = await yard();
    const summit = d.bookingOn('Summit Grading', 'U55-2');
    const p = await load.proposalOf(d.shop.id, summit.customerId);
    const [rev] = await load.revisions(p.id);
    expect(rev!.ownerTriggers).toContain('unknown_fact');
    const [card] = await load.escalations(p.id);
    expect(card!.summary).toContain('Fits through an 8 ft site gate');
    expect(card!.summary).toContain('Cat 308');
    const gate = d.facts.find((f) => f.unitId === d.unit('CAT308-1').id)!;
    const declined = await ownerDecision(db, gateway, d.shop.id, { proposalId: p.id, revisionId: rev!.id, decision: 'approve', factAnswers: { [gate.id]: 'no' } });
    expect(declined.status).toBe('rejected');
    expect((await load.booking(d.bookingOn('Alder Homes', 'U55-2').id)).unitId).toBe(d.unit('U55-2').id);
  });

  it('the last telehandler: with the Genie held, Dune gets nothing that clashes', async () => {
    const { d } = await yard();
    const dune = d.customer('Dune Framing');
    const request = { kind: 'new_booking' as const, customerId: dune.id, startsAt: d.t({ day: 'Tue', hour: 7 }), endsAt: d.t({ day: 'Wed', hour: 17 }) };
    for (const prefix of ['JCB 507', 'Genie GTH']) {
      const modelId = d.models.find((m) => m.name.startsWith(prefix))!.id;
      const r = await requestChange(db, d.shop.id, { customerId: dune.id, request: { ...request, modelId } });
      expect(r.status, prefix).toBe('infeasible');
    }
    const claims = await db.select().from(s.claims).where(and(eq(s.claims.shopId, d.shop.id), eq(s.claims.unitId, d.unit('GTH1056-1').id), isNull(s.claims.releasedAt)));
    expect(claims.length).toBeGreaterThan(0);
  });

  it('the last telehandler: when Coastline keeps their booking the Genie is released, and Dune can have it', async () => {
    const { d, gateway } = await yard();
    const coastline = d.bookingOn('Coastline Roofing', 'JCB507-1'), pacific = d.bookingOn('Pacific Steel', 'JCB507-1');
    const p = await load.proposalOf(d.shop.id, pacific.customerId);
    expect((await affectedRefuse(db, gateway, d.shop.id, { proposalId: p.id, customerId: coastline.customerId })).status).not.toBe('refused');
    expect((await load.booking(coastline.id)).unitId).toBe(d.unit('JCB507-1').id);

    const dune = d.customer('Dune Framing');
    const genie = d.models.find((m) => m.name.startsWith('Genie'))!.id;
    const r = await requestChange(db, d.shop.id, { customerId: dune.id, request: { kind: 'new_booking', customerId: dune.id, modelId: genie, startsAt: d.t({ day: 'Tue', hour: 7 }), endsAt: d.t({ day: 'Wed', hour: 17 }) } });
    expect(r.status).toBe('offered');
  });

  it('switching shops keeps each one separate, and Reset demo reseeds the one that is open', async () => {
    const gateway = fakeGateway();
    const token = randomUUID();
    const camera = await shopForSession(db, gateway, token);
    const first = await shopForSession(db, gateway, token, undefined, 'yard');
    expect([camera.name, first.name, first.scenario]).toEqual(['Lens & Light Rentals', 'Ridgeline Equipment Rental', 'yard']);
    expect((await shopForSession(db, gateway, token, undefined, 'yard')).id).toBe(first.id);

    const again = await resetShop(db, gateway, first.id);
    expect([again.name, again.sessionKey]).toEqual([first.name, first.sessionKey]);
    expect(await openProblems(db, again.id)).toHaveLength(4);
    expect((await shopForSession(db, gateway, token)).id).toBe(camera.id);
  });

  it('plans fast enough at this size to run under the shop lock', async () => {
    const { d } = await yard();
    const snapshot = await db.transaction((tx) => loadSnapshot(tx, d.shop.id));
    // The widest search this yard offers: every machine out at once, each pushing into the next booking.
    const t0 = performance.now();
    for (const x of d.bookings) optimize(snapshot, { kind: 'extend', bookingId: x.id, newEndsAt: new Date(x.endsAt.getTime() + 48 * 3_600_000) });
    expect((performance.now() - t0) / d.bookings.length).toBeLessThan(250);
  });
});
