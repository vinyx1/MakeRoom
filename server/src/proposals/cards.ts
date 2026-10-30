// Approval cards, rendered from the stored revision at view time (docs/conflict-model.md §4). The card is what a
// customer agrees to, so its words come from here, never from agent text. Other customers stay anonymous.

import type { Index } from '../optimizer/snapshot.ts';
import { formatShopTime } from '../optimizer/time.ts';
import { type Revision, type RevisionChange, afterOf } from './store.ts';

export type CardRole = 'requester' | 'affected';

export type CardOption = {
  revisionId: string;
  /** 'A' / 'B' when the card offers options. */
  option: string | null;
  lines: string[];
  /** Shown as "needs shop confirmation" until the owner approves. */
  needsShop: boolean;
  isAlternative: boolean;
};

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * What the customer's booking needs from the equipment it moves to (Eve's "for Canon R5 + RF 24-70"), stated only
 * once it is known: a stored `yes`, or an unknown fact the owner answered on this plan. Approving a plan takes a Yes
 * to each of its unknown facts (a No declines it), so the owner's approval is that answer. Invariant 11.
 */
function checkedFacts(idx: Index, revision: Revision, c: RevisionChange, ownerApproved: boolean): string[] {
  const booking = c.bookingId ? idx.bookings.get(c.bookingId) : undefined;
  if (!booking || !c.newUnitId) return [];
  return booking.requiredFacts.flatMap((key) => {
    const fact = idx.fact(c.newUnitId!, key);
    const known = fact?.value === 'yes' || (!!fact && ownerApproved && revision.factDependencies.includes(fact.id));
    return known ? [`Checked by the shop for your setup: ${fact!.label ?? key.replaceAll('_', ' ')}`] : [];
  });
}

export function renderOption(
  idx: Index,
  revision: Revision,
  rows: RevisionChange[],
  customerId: string,
  role: CardRole,
  ownerApproved: boolean,
): CardOption {
  const t = (d: Date) => formatShopTime(d, idx.snap.shop);
  const mine = rows.filter((c) => c.partyCustomerId === customerId);
  const lines: string[] = [];

  for (const c of mine) {
    const after = afterOf(c);
    const model = idx.models.get(after.modelId)?.name ?? 'the equipment';
    const before = c.before;
    if (role === 'requester') {
      if (c.kind === 'new_booking') lines.push(`${model}, ${t(after.startsAt)} → ${t(after.endsAt)}`);
      else if (c.kind === 'extension') lines.push(`Keep the ${model} until ${t(after.endsAt)}`);
      else lines.push(`Your rental moves to ${t(after.startsAt)} → ${t(after.endsAt)}`);
      continue;
    }
    if (!before) continue;
    const fromModel = idx.models.get(before.modelId);
    const toModel = idx.models.get(after.modelId);
    if (c.kind === 'model_change') {
      const upgrade = (toModel?.tier ?? 0) > (fromModel?.tier ?? 0);
      lines.push(`${upgrade ? 'Free upgrade' : 'Switch'} to the ${model}, same times (${t(after.startsAt)} → ${t(after.endsAt)})`);
      lines.push(...checkedFacts(idx, revision, c, ownerApproved));
    } else if (c.kind === 'same_model_swap') {
      lines.push(`Same ${model}, a different unit. Nothing else changes.`);
    } else {
      const startMoved = after.startsAt.getTime() !== new Date(before.startsAt).getTime();
      const endMoved = after.endsAt.getTime() !== new Date(before.endsAt).getTime();
      if (startMoved) lines.push(`Pickup moves from ${t(new Date(before.startsAt))} to ${t(after.startsAt)}`);
      if (endMoved) lines.push(`Return moves from ${t(new Date(before.endsAt))} to ${t(after.endsAt)}`);
    }
  }

  if (role === 'requester') {
    const charge = revision.quote.chargeCents;
    lines.push(charge > 0 ? `${usd(charge)}, only charged if it goes ahead` : 'No extra charge');
    if (revision.quote.discountCents > 0) lines.push(`Includes a ${usd(revision.quote.discountCents)} discount`);
  } else {
    // Only cash is shown as an amount; an upgrade is described as free, not by its value to the shop.
    const refund = revision.quote.compensation.filter((x) => x.customerId === customerId && x.kind === 'refund').reduce((sum, x) => sum + x.cents, 0);
    if (refund > 0) lines.push(`${usd(refund)} refunded to your original payment`);
  }

  return {
    revisionId: revision.id,
    option: revision.optionLabel,
    lines,
    needsShop: revision.needsOwner && !ownerApproved,
    isAlternative: revision.isAlternative,
  };
}
