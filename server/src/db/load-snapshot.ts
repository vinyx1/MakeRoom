// Builds the optimizer's input from the database. Call inside `withShopLock` so the snapshot, the validation
// and the write all see the same state (invariant 5).

import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { shopNow } from '../clock.ts';
import type { Snapshot } from '../optimizer/snapshot.ts';
import { ACTIVE_STATES } from '../proposals/state-machine.ts';
import type { Tx } from './client.ts';
import * as s from './schema.ts';

export async function loadSnapshot(
  tx: Tx,
  shopId: string,
  { proposalId = null, realNow = new Date() }: { proposalId?: string | null; realNow?: Date } = {},
): Promise<Snapshot> {
  const [shop] = await tx.select().from(s.shops).where(eq(s.shops.id, shopId));
  if (!shop) throw new Error(`shop ${shopId} not found`);
  const byShop = <T extends { shopId: unknown }>(t: T) => eq((t as unknown as typeof s.units).shopId, shopId);

  const [models, substitutes, units, unavailability, conditionNotes, facts, customers, bookings] = await Promise.all([
    tx.select().from(s.equipmentModels).where(byShop(s.equipmentModels)),
    tx.select().from(s.modelSubstitutes).where(byShop(s.modelSubstitutes)),
    tx.select().from(s.units).where(byShop(s.units)),
    tx.select().from(s.unitUnavailability).where(byShop(s.unitUnavailability)),
    tx.select().from(s.conditionNotes).where(byShop(s.conditionNotes)),
    tx.select().from(s.facts).where(byShop(s.facts)),
    tx.select().from(s.customers).where(byShop(s.customers)),
    tx.select().from(s.bookings).where(byShop(s.bookings)),
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
    shop: { timezone: shop.timezone, opensAt: shop.opensAt, closesAt: shop.closesAt, policy: shop.policy },
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
