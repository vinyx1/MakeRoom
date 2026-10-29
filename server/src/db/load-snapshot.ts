// Builds the optimizer's input from the database. Call inside `withShopLock` so the snapshot, the validation
// and the write all see the same state (invariant 5).

import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { shopNow } from '../clock.ts';
import type { Snapshot } from '../optimizer/snapshot.ts';
import { ACTIVE_STATES } from '../proposals/state-machine.ts';
import { Policy } from './policy.ts';
import type { Tx } from './client.ts';
import * as s from './schema.ts';

export async function loadSnapshot(
  tx: Tx,
  shopId: string,
  { proposalId = null, realNow = new Date() }: { proposalId?: string | null; realNow?: Date } = {},
): Promise<Snapshot> {
  const [shop] = await tx.select().from(s.shops).where(eq(s.shops.id, shopId));
  if (!shop) throw new Error(`shop ${shopId} not found`);
  const [models, substitutes, units, unavailability, conditionNotes, facts, customers, bookings] = await Promise.all([
    tx.select().from(s.equipmentModels).where(eq(s.equipmentModels.shopId, shopId)),
    tx.select().from(s.modelSubstitutes).where(eq(s.modelSubstitutes.shopId, shopId)),
    tx.select().from(s.units).where(eq(s.units.shopId, shopId)),
    tx.select().from(s.unitUnavailability).where(eq(s.unitUnavailability.shopId, shopId)),
    tx.select().from(s.conditionNotes).where(eq(s.conditionNotes.shopId, shopId)),
    tx.select().from(s.facts).where(eq(s.facts.shopId, shopId)),
    tx.select().from(s.customers).where(eq(s.customers.shopId, shopId)),
    tx.select().from(s.bookings).where(eq(s.bookings.shopId, shopId)),
  ]);

  // Claims held by other active proposals. Unreleased claims of an ended proposal are ignored too, so a
  // missed release can't block capacity forever.
  const claimRows = await tx
    .select({ claim: s.claims })
    .from(s.claims)
    .innerJoin(s.proposals, eq(s.claims.proposalId, s.proposals.id))
    .where(
      and(
        eq(s.claims.shopId, shopId),
        isNull(s.claims.releasedAt),
        inArray(s.proposals.state, [...ACTIVE_STATES]),
        ...(proposalId ? [ne(s.claims.proposalId, proposalId)] : []),
      ),
    );

  const [exclusions, constraints] = proposalId
    ? await Promise.all([
        tx.select().from(s.proposalExclusions).where(eq(s.proposalExclusions.proposalId, proposalId)),
        tx.select().from(s.customerConstraints).where(eq(s.customerConstraints.proposalId, proposalId)),
      ])
    : [[], []];

  return {
    now: shopNow(shop, realNow),
    shop: { timezone: shop.timezone, opensAt: shop.opensAt, closesAt: shop.closesAt, policy: Policy.parse(shop.policy) },
    models,
    substitutes,
    units,
    unavailability,
    conditionNotes,
    facts,
    customers,
    bookings,
    otherClaims: claimRows.map((r) => r.claim),
    excludedCustomerIds: exclusions.map((e) => e.customerId),
    constraints,
  };
}
