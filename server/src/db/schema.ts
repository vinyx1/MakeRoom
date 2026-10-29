// Drizzle schema for docs/data-model.md. Section numbers below match that doc.
// Constraints Drizzle can't express (exclusion constraints, triggers, btree_gist) live in the
// hand-written migrations drizzle/0001_constraints.sql and drizzle/0003_immutable_revisions.sql.

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { Policy } from './policy.ts';

// --- Column helpers ---------------------------------------------------------

/** Half-open `[start, end)` range of instants. */
export type Period = { start: Date; end: Date };

export const tstzrange = customType<{ data: Period; driverData: string }>({
  dataType: () => 'tstzrange',
  toDriver: ({ start, end }) => `[${start.toISOString()},${end.toISOString()})`,
  fromDriver: (value) => {
    // Postgres prints `["2026-10-28 14:00:00+00","2026-10-29 10:00:00+00")`.
    const [start, end] = value.slice(1, -1).split(',').map((s) => new Date(s.replaceAll('"', '')));
    return { start: start!, end: end! };
  },
});

const id = () => uuid().primaryKey().defaultRandom();
const shopId = () =>
  uuid()
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' });
const at = () => timestamp({ withTimezone: true });
const version = () => integer().notNull().default(1);
/** Shop clock (server now + `shops.clock_offset_ms`), so the feed and timeouts follow fast-forward. Always passed by the app. */
const createdAt = () => at().notNull();

// --- Enums ------------------------------------------------------------------

export const unavailabilityReason = pgEnum('unavailability_reason', ['maintenance', 'out_of_service']);
export const factValue = pgEnum('fact_value', ['yes', 'no', 'unknown']);
/** `agent`: a question the agent raised that nobody has answered yet (value `unknown`). */
export const factSource = pgEnum('fact_source', ['seed', 'owner', 'agent']);
export const bookingStatus = pgEnum('booking_status', ['confirmed', 'picked_up', 'returned', 'cancelled', 'no_show']);
export const proposalSource = pgEnum('proposal_source', [
  'customer_request',
  'owner_edit',
  'owner_resolve',
  'unit_down',
  'overdue',
  'customer_cancel',
]);
export const proposalState = pgEnum('proposal_state', [
  'DRAFT',
  'AWAITING_APPROVALS',
  'CAPTURING',
  'COMMITTED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
  'FAILED',
]);
export const ACTIVE_PROPOSAL_STATES = ['DRAFT', 'AWAITING_APPROVALS', 'CAPTURING'] as const;
export const revisionStatus = pgEnum('revision_status', ['draft', 'offered', 'selected', 'superseded', 'dropped']);
export const revisionOrigin = pgEnum('revision_origin', ['optimizer', 'counter', 'owner_modify', 'fallback', 'alternative']);
export const revisionAuthor = pgEnum('revision_author', ['agent', 'owner', 'customer']);
export const changeAction = pgEnum('change_action', ['create', 'update', 'cancel', 'unassign', 'assign']);
export const changeKind = pgEnum('change_kind', ['new_booking', 'extension', 'time_shift', 'same_model_swap', 'model_change', 'cancellation']);
export const compensationKind = pgEnum('compensation_kind', ['refund', 'upgrade_value']);
export const approvalRole = pgEnum('approval_role', ['requester', 'affected', 'owner']);
export const approvalStatus = pgEnum('approval_status', ['pending', 'approved', 'rejected', 'countered', 'withdrawn']);
export const approvalSource = pgEnum('approval_source', ['card_click', 'owner_attested', 'counter_author', 'carried_over']);
export const constraintKind = pgEnum('constraint_kind', ['not_before', 'not_after', 'require_model', 'forbid_model', 'keep_unit']);
export const paypalIntent = pgEnum('paypal_intent', ['AUTHORIZE', 'CAPTURE']);
export const paypalOrderStatus = pgEnum('paypal_order_status', ['created', 'approved', 'authorized', 'captured', 'voided', 'failed']);
export const paymentOpKind = pgEnum('payment_op_kind', ['authorize', 'capture', 'void', 'refund']);
export const paymentOpStatus = pgEnum('payment_op_status', ['pending', 'succeeded', 'failed']);
export const messageAuthor = pgEnum('message_author', ['customer', 'agent', 'owner', 'system']);
export const escalationKind = pgEnum('escalation_kind', [
  'approval',
  'fact_question',
  'plan_review',
  'handoff',
  'overdue',
  'no_show',
  'unassigned',
  'payment_failure',
  /** A judgment call from `escalate_to_owner`: upset, asks for a person, dispute, still ambiguous, … */
  'customer_issue',
]);
export const escalationStatus = pgEnum('escalation_status', ['open', 'resolved']);

// --- 1. Shop and policy -----------------------------------------------------

export const shops = pgTable('shops', {
  id: id(),
  name: text().notNull(),
  timezone: text().notNull(),
  opensAt: time().notNull(),
  closesAt: time().notNull(),
  /** Shop "now" = server now + offset. */
  clockOffsetMs: bigint({ mode: 'number' }).notNull().default(0),
  policy: jsonb().$type<Policy>().notNull(),
  agentTurnsUsed: integer().notNull().default(0),
  /** Hash of the visitor's session cookie. The shop is looked up by this, never by URL. */
  sessionKey: text().notNull().unique(),
  createdAt: at().notNull().defaultNow(),
});

// --- 2. Inventory -----------------------------------------------------------

export const equipmentModels = pgTable(
  'equipment_models',
  {
    id: id(),
    shopId: shopId(),
    name: text().notNull(),
    category: text().notNull(),
    /** Rank within category: lower = downgrade, higher = upgrade. */
    tier: integer().notNull(),
    dailyRateCents: integer().notNull(),
    rateMinCents: integer().notNull(),
    rateMaxCents: integer().notNull(),
  },
  (t) => [
    unique().on(t.shopId, t.name),
    check('equipment_models_rate_in_bounds', sql`${t.rateMinCents} <= ${t.dailyRateCents} AND ${t.dailyRateCents} <= ${t.rateMaxCents}`),
  ],
);

export const modelSubstitutes = pgTable(
  'model_substitutes',
  {
    id: id(),
    shopId: shopId(),
    modelId: uuid().notNull().references(() => equipmentModels.id, { onDelete: 'cascade' }),
    substituteModelId: uuid().notNull().references(() => equipmentModels.id, { onDelete: 'cascade' }),
  },
  (t) => [
    unique().on(t.modelId, t.substituteModelId),
    check('model_substitutes_not_self', sql`${t.modelId} <> ${t.substituteModelId}`),
  ],
);

export const units = pgTable(
  'units',
  {
    id: id(),
    shopId: shopId(),
    modelId: uuid().notNull().references(() => equipmentModels.id),
    label: text().notNull(),
    active: boolean().notNull().default(true),
  },
  (t) => [unique().on(t.shopId, t.label)],
);

/** Resource calendars. Not excluded against bookings by the DB; the validator checks that. */
export const unitUnavailability = pgTable(
  'unit_unavailability',
  {
    id: id(),
    shopId: shopId(),
    unitId: uuid().notNull().references(() => units.id, { onDelete: 'cascade' }),
    period: tstzrange().notNull(),
    reason: unavailabilityReason().notNull(),
    version: version(),
  },
  (t) => [index().on(t.unitId)],
);

export const conditionNotes = pgTable(
  'condition_notes',
  {
    id: id(),
    shopId: shopId(),
    unitId: uuid().notNull().references(() => units.id, { onDelete: 'cascade' }),
    body: text().notNull(),
    openedAt: at().notNull(),
    resolvedAt: at(),
    version: version(),
  },
  (t) => [index().on(t.unitId)],
);

export const facts = pgTable(
  'facts',
  {
    id: id(),
    shopId: shopId(),
    unitId: uuid().references(() => units.id, { onDelete: 'cascade' }),
    modelId: uuid().references(() => equipmentModels.id, { onDelete: 'cascade' }),
    key: text().notNull(),
    value: factValue().notNull(),
    source: factSource().notNull(),
    setAt: at().notNull(),
    escalationId: uuid().references((): AnyPgColumn => escalations.id, { onDelete: 'set null' }),
    version: version(),
  },
  (t) => [
    // NULLS NOT DISTINCT: one of unit_id/model_id is always null, which would otherwise defeat the uniqueness.
    unique().on(t.shopId, t.unitId, t.modelId, t.key).nullsNotDistinct(),
    check('facts_unit_xor_model', sql`(${t.unitId} IS NULL) <> (${t.modelId} IS NULL)`),
  ],
);

// --- 3. Customers and bookings ----------------------------------------------

export const customers = pgTable('customers', {
  id: id(),
  shopId: shopId(),
  name: text().notNull(),
  email: text().notNull(),
  flagged: boolean().notNull().default(false),
});

/**
 * Exclusion constraint (in the hand-written migration): no two confirmed/picked-up bookings on one unit
 * overlap over `[starts_at, buffer_ends_at)`. Deferred to commit, since a plan's updates overlap midway.
 */
export const bookings = pgTable(
  'bookings',
  {
    id: id(),
    shopId: shopId(),
    customerId: uuid().notNull().references(() => customers.id),
    modelId: uuid().notNull().references(() => equipmentModels.id),
    /** Null = unassigned (forced change). */
    unitId: uuid().references(() => units.id),
    startsAt: at().notNull(),
    endsAt: at().notNull(),
    /** `ends_at` + this booking's buffer, written by the app (not generated: timestamptz + interval isn't immutable). */
    bufferEndsAt: at().notNull(),
    status: bookingStatus().notNull(),
    overdueMarkedAt: at(),
    noShowMarkedAt: at(),
    priceCents: integer().notNull(),
    prepaidOrderId: uuid().references((): AnyPgColumn => paypalOrders.id),
    note: text(),
    /**
     * Fact keys any unit this booking moves to must satisfy (Eve's `balances_r5_rf2470`). The optimizer reads
     * these; `no` rules a unit out, `unknown` makes the plan need owner confirmation.
     */
    requiredFacts: text().array().notNull().default(sql`'{}'`),
    version: version(),
  },
  (t) => [
    index().on(t.shopId, t.startsAt),
    check('bookings_ends_after_start', sql`${t.endsAt} > ${t.startsAt}`),
    check('bookings_buffer_after_end', sql`${t.bufferEndsAt} >= ${t.endsAt}`),
  ],
);

// --- 4. Proposals -----------------------------------------------------------

export const proposals = pgTable(
  'proposals',
  {
    id: id(),
    shopId: shopId(),
    source: proposalSource().notNull(),
    /** Null when the owner or system initiates with no paying requester. */
    requesterCustomerId: uuid().references(() => customers.id),
    subjectBookingId: uuid().references(() => bookings.id),
    /** What was asked, as structured data. */
    request: jsonb().notNull(),
    state: proposalState().notNull().default('DRAFT'),
    revisionSeq: integer().notNull().default(0),
    fallbackPlansUsed: integer().notNull().default(0),
    expiresAt: at(),
    endedReason: text(),
    createdAt: createdAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('proposals_one_active_per_requester_booking')
      .on(t.requesterCustomerId, t.subjectBookingId)
      .where(sql`${t.state} IN ('DRAFT', 'AWAITING_APPROVALS', 'CAPTURING')`),
    index().on(t.shopId, t.state),
  ],
);

/** Quote stored on a revision. Agreed terms never change after the revision is created. */
export type Quote = {
  /** What the requester's change costs at the rate card, line by line. */
  lines: { customerId: string; label: string; amountCents: number }[];
  discountCents: number;
  /** Lines minus discount: what the requester authorizes and is captured. Negative = owed to them. */
  chargeCents: number;
  /** Per affected booking. `upgrade_value` is revenue the shop gives up; `refund` is cash back on their capture. */
  compensation: { customerId: string; bookingId: string | null; cents: number; kind: 'refund' | 'upgrade_value'; reason: string }[];
  netRevenueCents: number;
};

/** Immutable once created, apart from `status`. */
export const revisions = pgTable(
  'revisions',
  {
    id: id(),
    shopId: shopId(),
    proposalId: uuid().notNull().references(() => proposals.id, { onDelete: 'cascade' }),
    /** Options offered together share a seq. */
    seq: integer().notNull(),
    /** Null, or 'A' / 'B' when offered as options on one card. */
    optionLabel: text(),
    parentRevisionId: uuid().references((): AnyPgColumn => revisions.id),
    status: revisionStatus().notNull().default('draft'),
    origin: revisionOrigin().notNull(),
    createdBy: revisionAuthor().notNull(),
    /** Set when `created_by` is 'customer' (the counter's author). */
    createdByCustomerId: uuid().references(() => customers.id),
    isAlternative: boolean().notNull().default(false),
    quote: jsonb().$type<Quote>().notNull(),
    netRevenueCents: integer().notNull(),
    ownerTriggers: text().array().notNull().default(sql`'{}'`),
    envelopeTrips: text().array().notNull().default(sql`'{}'`),
    needsOwner: boolean().notNull().default(false),
    factDependencies: uuid().array().notNull().default(sql`'{}'`),
    /** Deferred: versions of every input. */
    fingerprint: jsonb(),
    validatedAt: at(),
    createdAt: createdAt(),
  },
  (t) => [
    // NULLS NOT DISTINCT: a revision with no options (label null) is still unique per seq.
    unique().on(t.proposalId, t.seq, t.optionLabel).nullsNotDistinct(),
    check('revisions_option_label', sql`${t.optionLabel} IN ('A', 'B')`),
    check('revisions_customer_author', sql`(${t.createdBy} = 'customer') = (${t.createdByCustomerId} IS NOT NULL)`),
    check(
      'revisions_needs_owner',
      sql`${t.needsOwner} = (cardinality(${t.ownerTriggers}) > 0 OR cardinality(${t.envelopeTrips}) > 0)`,
    ),
  ],
);

/** Booking snapshot stored in `revision_changes.before`. */
export type BookingSnapshot = {
  unitId: string | null;
  modelId: string;
  startsAt: string;
  endsAt: string;
  bufferEndsAt: string;
  status: string;
  version: number;
};

/** One row per booking a revision touches. Together they are the plan. */
export const revisionChanges = pgTable(
  'revision_changes',
  {
    id: id(),
    shopId: shopId(),
    revisionId: uuid().notNull().references(() => revisions.id, { onDelete: 'cascade' }),
    /** Null for a booking the plan creates. */
    bookingId: uuid().references(() => bookings.id),
    action: changeAction().notNull(),
    before: jsonb().$type<BookingSnapshot>(),
    newUnitId: uuid().references(() => units.id),
    newModelId: uuid().references(() => equipmentModels.id),
    newStartsAt: at(),
    newEndsAt: at(),
    newBufferEndsAt: at(),
    kind: changeKind().notNull(),
    requiresApproval: boolean().notNull(),
    hoursShifted: numeric({ mode: 'number' }).notNull().default(0),
    partyCustomerId: uuid().notNull().references(() => customers.id),
    priceDeltaCents: integer().notNull().default(0),
    compensationCents: integer().notNull().default(0),
    compensationKind: compensationKind(),
  },
  (t) => [
    index().on(t.revisionId),
    check('revision_changes_booking_unless_create', sql`(${t.action} = 'create') = (${t.bookingId} IS NULL)`),
    check('revision_changes_before_unless_create', sql`(${t.action} = 'create') = (${t.before} IS NULL)`),
  ],
);

/** Only written by the card endpoint and owner actions; no agent tool writes `approved`. */
export const approvals = pgTable(
  'approvals',
  {
    id: id(),
    shopId: shopId(),
    revisionId: uuid().notNull().references(() => revisions.id, { onDelete: 'cascade' }),
    proposalId: uuid().notNull().references(() => proposals.id, { onDelete: 'cascade' }),
    role: approvalRole().notNull(),
    /** Null for the owner. */
    customerId: uuid().references(() => customers.id),
    status: approvalStatus().notNull().default('pending'),
    /** A rejection meaning "no, as booked": excludes the customer from this proposal. */
    refusal: boolean().notNull().default(false),
    source: approvalSource(),
    carriedFromId: uuid().references((): AnyPgColumn => approvals.id),
    requestedAt: at().notNull(),
    respondedAt: at(),
    expiresAt: at(),
  },
  (t) => [
    // NULLS NOT DISTINCT: the owner's row has customer_id null and must still be unique per revision.
    unique().on(t.revisionId, t.role, t.customerId).nullsNotDistinct(),
    check('approvals_owner_has_no_customer', sql`(${t.role} = 'owner') = (${t.customerId} IS NULL)`),
    check('approvals_refusal_is_rejection', sql`NOT ${t.refusal} OR ${t.status} = 'rejected'`),
    index().on(t.proposalId),
  ],
);

/** Customers who refused; the optimizer won't plan approval-needing changes for them in this proposal. */
export const proposalExclusions = pgTable(
  'proposal_exclusions',
  {
    id: id(),
    shopId: shopId(),
    proposalId: uuid().notNull().references(() => proposals.id, { onDelete: 'cascade' }),
    customerId: uuid().notNull().references(() => customers.id),
    reason: text().notNull(),
  },
  (t) => [unique().on(t.proposalId, t.customerId)],
);

export const customerConstraints = pgTable(
  'customer_constraints',
  {
    id: id(),
    shopId: shopId(),
    proposalId: uuid().notNull().references(() => proposals.id, { onDelete: 'cascade' }),
    customerId: uuid().notNull().references(() => customers.id),
    kind: constraintKind().notNull(),
    value: jsonb().notNull(),
    sourceMessageId: uuid().references((): AnyPgColumn => messages.id),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.proposalId)],
);

/**
 * A proposal's lock on a booking or on unit capacity. Two exclusion constraints (hand-written migration)
 * stop two proposals holding the same booking or overlapping capacity; one proposal's options may overlap.
 */
export const claims = pgTable(
  'claims',
  {
    id: id(),
    shopId: shopId(),
    proposalId: uuid().notNull().references(() => proposals.id, { onDelete: 'cascade' }),
    revisionId: uuid().notNull().references(() => revisions.id, { onDelete: 'cascade' }),
    bookingId: uuid().references(() => bookings.id),
    unitId: uuid().references(() => units.id),
    period: tstzrange(),
    releasedAt: at(),
  },
  (t) => [
    check(
      'claims_booking_xor_capacity',
      sql`(${t.bookingId} IS NOT NULL AND ${t.unitId} IS NULL AND ${t.period} IS NULL)
       OR (${t.bookingId} IS NULL AND ${t.unitId} IS NOT NULL AND ${t.period} IS NOT NULL)`,
    ),
    index().on(t.revisionId),
  ],
);

// --- 5. Payments ------------------------------------------------------------

export const paypalOrders = pgTable(
  'paypal_orders',
  {
    id: id(),
    shopId: shopId(),
    /** Null for seeded prepayments. */
    proposalId: uuid().references(() => proposals.id),
    revisionId: uuid().references(() => revisions.id),
    /** Set for prepayments. */
    bookingId: uuid().references((): AnyPgColumn => bookings.id),
    customerId: uuid().notNull().references(() => customers.id),
    paypalOrderId: text().notNull().unique(),
    intent: paypalIntent().notNull(),
    amountCents: integer().notNull(),
    authorizationId: text(),
    captureId: text(),
    capturedCents: integer().notNull().default(0),
    refundedCents: integer().notNull().default(0),
    status: paypalOrderStatus().notNull().default('created'),
    /** Safety valve if the sandbox misbehaves; the feed labels simulated rows. */
    simulated: boolean().notNull().default(false),
  },
  (t) => [
    check('paypal_orders_amounts', sql`0 <= ${t.refundedCents} AND ${t.refundedCents} <= ${t.capturedCents} AND ${t.capturedCents} <= ${t.amountCents}`),
  ],
);

/** Every PayPal call, recorded before it is made. Becomes the outbox later. */
export const paymentOps = pgTable(
  'payment_ops',
  {
    id: id(),
    shopId: shopId(),
    kind: paymentOpKind().notNull(),
    paypalOrderRef: uuid().notNull().references(() => paypalOrders.id),
    amountCents: integer().notNull(),
    /** The PayPal-Request-Id: `{proposal}:{revision}:{kind}:{customer}`. One id = one amount. */
    requestId: text().notNull().unique(),
    status: paymentOpStatus().notNull().default('pending'),
    attempts: integer().notNull().default(0),
    lastError: text(),
    /** PayPal's id for the result (authorization, capture or refund id). */
    paypalRef: text(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.paypalOrderRef)],
);

// --- 6. Conversations and escalations ---------------------------------------

export const conversations = pgTable('conversations', {
  id: id(),
  shopId: shopId(),
  customerId: uuid().notNull().unique().references(() => customers.id),
  handedOffAt: at(),
  handoffReason: text(),
  handedBackAt: at(),
});

export const messages = pgTable(
  'messages',
  {
    id: id(),
    shopId: shopId(),
    conversationId: uuid().notNull().references(() => conversations.id, { onDelete: 'cascade' }),
    author: messageAuthor().notNull(),
    body: text().notNull(),
    /** An approval card. Rendered from these revisions at view time, never stored as text. */
    cardRevisionIds: uuid().array().notNull().default(sql`'{}'`),
    isOwnerDraft: boolean().notNull().default(false),
    /** Shop clock. */
    at: at().notNull(),
  },
  (t) => [index().on(t.conversationId, t.at)],
);

export const escalations = pgTable(
  'escalations',
  {
    id: id(),
    shopId: shopId(),
    kind: escalationKind().notNull(),
    proposalId: uuid().references(() => proposals.id),
    revisionId: uuid().references(() => revisions.id),
    conversationId: uuid().references(() => conversations.id),
    factId: uuid().references((): AnyPgColumn => facts.id),
    bookingId: uuid().references(() => bookings.id),
    reasons: text().array().notNull().default(sql`'{}'`),
    /** Agent-written context for the owner. */
    summary: text().notNull(),
    status: escalationStatus().notNull().default('open'),
    resolution: jsonb(),
    /** Shop clock. */
    at: at().notNull(),
  },
  (t) => [index().on(t.shopId, t.status)],
);

// --- 7. Owner drafts and activity -------------------------------------------

/** Scratch work: holds no claims, blocks nothing. */
export const ownerDrafts = pgTable('owner_drafts', {
  id: id(),
  shopId: shopId(),
  bookingId: uuid().notNull().unique().references(() => bookings.id),
  proposed: jsonb().$type<{ unitId?: string | null; startsAt?: string; endsAt?: string }>().notNull(),
  basedOnVersion: integer().notNull(),
  /** "Agreed by phone". */
  attestedCustomerIds: uuid().array().notNull().default(sql`'{}'`),
});

/** Append-only. Feeds the owner's activity feed over SSE. */
export const activityLog = pgTable(
  'activity_log',
  {
    id: id(),
    /** Insertion order: ties on `at` within one transaction are common. Also the SSE resume cursor. */
    seq: bigserial({ mode: 'number' }).notNull().unique(),
    shopId: shopId(),
    /** Shop clock. */
    at: at().notNull(),
    /** `agent`, `owner`, `customer:{id}` or `system`. */
    actor: text().notNull(),
    kind: text().notNull(),
    proposalId: uuid().references(() => proposals.id),
    revisionId: uuid().references(() => revisions.id),
    payload: jsonb().notNull().default({}),
  },
  (t) => [index().on(t.shopId, t.at)],
);
