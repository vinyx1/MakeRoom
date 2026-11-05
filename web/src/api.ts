// The server's API (server/src/server/app.ts). Dates arrive as ISO strings. Domain outcomes come back as 200 with a
// `status` field; only bad input and server errors throw.

export type Booking = {
  id: string;
  customerId: string;
  modelId: string;
  unitId: string | null;
  startsAt: string;
  endsAt: string;
  bufferEndsAt: string;
  status: 'confirmed' | 'picked_up' | 'returned' | 'cancelled' | 'no_show';
  priceCents: number;
  note: string | null;
  version: number;
  /** Set when the owner marked the rental overdue. */
  overdueMarkedAt: string | null;
};
export type Unit = { id: string; label: string; modelId: string; active: boolean };
export type Model = { id: string; name: string; category: string; tier: number; dailyRateCents: number };
export type Customer = { id: string; name: string; flagged: boolean };
export type Fact = { id: string; unitId: string | null; modelId: string | null; key: string; label: string | null; value: 'yes' | 'no' | 'unknown'; source: string; setAt: string };
export type Unavailability = { id: string; unitId: string; period: { start: string; end: string }; reason: string };
export type ConditionNote = { id: string; unitId: string; body: string };

export type RevisionChange = {
  id: string;
  revisionId: string;
  bookingId: string | null;
  before: { unitId: string | null; startsAt: string; endsAt: string; bufferEndsAt: string; version: number } | null;
  newUnitId: string | null;
  newModelId: string;
  newStartsAt: string;
  newEndsAt: string;
  newBufferEndsAt: string;
  kind: string;
  partyCustomerId: string;
};
export type Approval = { id: string; revisionId: string; role: 'requester' | 'affected' | 'owner'; customerId: string | null; status: string; source: string | null };
export type Revision = {
  id: string;
  proposalId: string;
  optionLabel: string | null;
  status: string;
  isAlternative: boolean;
  needsOwner: boolean;
  ownerTriggers: string[];
  envelopeTrips: string[];
  factDependencies: string[];
  quote: { chargeCents: number; discountCents: number; netRevenueCents: number; lines: { label: string; amountCents: number }[] };
  changes: RevisionChange[];
  approvals: Approval[];
};
export type Proposal = {
  id: string;
  source: string;
  requesterCustomerId: string | null;
  subjectBookingId: string | null;
  state: string;
  expiresAt: string | null;
  revisions: Revision[];
};
export type Escalation = {
  id: string;
  kind: 'approval' | 'plan_review' | 'fact_question' | 'handoff' | 'customer_issue' | 'payment_failure' | string;
  proposalId: string | null;
  revisionId: string | null;
  conversationId: string | null;
  factId: string | null;
  summary: string;
  at: string;
};
export type Draft = { id: string; bookingId: string; proposed: { unitId?: string | null; startsAt?: string; endsAt?: string }; attestedCustomerIds: string[] };
export type LastEdit = {
  bookingId: string;
  customerId: string;
  before: { unitId: string | null; startsAt: string; endsAt: string };
  after: { unitId: string | null; startsAt: string; endsAt: string };
};
/** A plan the optimizer ruled out, from an `optimizer_run` in the feed. Shown on the schedule, never applied. */
export type RejectedPlan = {
  message: string;
  customerId: string;
  after: { unitId: string | null; startsAt: string; endsAt: string; bufferEndsAt: string };
  conflictsWith: string[];
};

export type Activity = { seq: number; at: string; actor: string; kind: string; proposalId: string | null; payload: Record<string, any> };
export type Message = { id: string; author: 'customer' | 'agent' | 'owner' | 'system'; body: string; cardRevisionIds: string[]; at: string; isOwnerDraft?: boolean };
export type Conversation = { id: string; customerId: string; handedOffAt: string | null; messages: Message[] };

export type OwnerView = {
  shop: {
    name: string; scenario: string; now: string; timezone: string; opensAt: string; closesAt: string; agentTurnsUsed: number; autoReplyCustomers: boolean;
    demo: { shops: { id: string; label: string; tagline: string }[]; defaultCustomer: string; suggestions: Record<string, string> };
  };
  models: Model[];
  units: Unit[];
  customers: Customer[];
  bookings: Booking[];
  unavailability: Unavailability[];
  conditionNotes: ConditionNote[];
  facts: Fact[];
  proposals: Proposal[];
  drafts: Draft[];
  /** The owner's latest edit, while Undo can still put it back. */
  lastEdit: LastEdit | null;
  escalations: Escalation[];
  conversations: Conversation[];
  /** Newest first. */
  activity: Activity[];
};

export type CardOption = { revisionId: string; option: string | null; lines: string[]; needsShop: boolean; isAlternative: boolean };
export type CustomerCard = { proposalId: string; role: 'requester' | 'affected' | 'counter'; chargeCents: number; heldCents: number; options: CardOption[]; expiresAt: string | null };
/** Where a request stands for this customer once their card isn't asking them anything. */
export type RequestStatus = {
  proposalId: string;
  role: 'requester' | 'affected';
  state: string;
  revisionIds: string[];
  tone: 'waiting' | 'done' | 'ended';
  headline: string;
  detail: string | null;
  lines: string[];
  canCancel: boolean;
  canWithdraw?: boolean;
};
export type CustomerView = {
  customer: { id: string; name: string };
  now: string;
  messages: Message[];
  handedOff: boolean;
  cards: CustomerCard[];
  requests: RequestStatus[];
};

export type Config = {
  paypalClientId: string | null;
  currency: string;
  sandboxBuyer: { email: string; password: string } | null;
  testCardEnabled: boolean;
};

/** Every action result: `status` plus whatever the server adds (reason, waitingOn, saveableFacts, …). */
export type Outcome = { status: string; reason?: string; [key: string]: any };

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
  return json as T;
}

export const api = {
  config: () => call<Config>('GET', '/api/config'),
  owner: () => call<OwnerView>('GET', '/api/owner'),
  customer: (id: string) => call<CustomerView>('GET', `/api/customers/${id}`),

  send: (customerId: string, text: string) => call<Outcome>('POST', `/api/customers/${customerId}/messages`, { text }),
  ownerMessage: (customerId: string, text: string) => call<Outcome>('POST', `/api/customers/${customerId}/owner-message`, { text }),
  handBack: (customerId: string) => call<Outcome>('POST', `/api/customers/${customerId}/hand-back`),

  order: (proposalId: string, customerId: string, testCard = false) =>
    call<Outcome & { orderId?: string; error?: string }>('POST', `/api/proposals/${proposalId}/order`, { customerId, ...(testCard ? { testCard } : {}) }),
  accept: (proposalId: string, customerId: string) => call<Outcome>('POST', `/api/proposals/${proposalId}/accept`, { customerId }),
  pick: (proposalId: string, revisionId: string, customerId: string) =>
    call<Outcome>('POST', `/api/proposals/${proposalId}/revisions/${revisionId}/accept`, { customerId }),
  keep: (proposalId: string, customerId: string) => call<Outcome>('POST', `/api/proposals/${proposalId}/keep`, { customerId }),
  scriptedAnswer: (proposalId: string, customerId: string) => call<Outcome>('POST', `/api/proposals/${proposalId}/scripted-answer`, { customerId }),
  cancel: (proposalId: string, customerId: string) => call<Outcome>('POST', `/api/proposals/${proposalId}/cancel`, { customerId }),
  sendCounter: (proposalId: string, revisionId: string, customerId: string) => call<Outcome>('POST', `/api/proposals/${proposalId}/revisions/${revisionId}/send`, { customerId }),
  discardCounter: (proposalId: string, revisionId: string, customerId: string) => call<Outcome>('POST', `/api/proposals/${proposalId}/revisions/${revisionId}/discard`, { customerId }),
  ownerDecision: (proposalId: string, revisionId: string, decision: 'approve' | 'decline', factAnswers?: Record<string, 'yes' | 'no'>) =>
    call<Outcome & { saveableFacts?: { factId: string; value: 'yes' | 'no'; label: string }[] }>(
      'POST', `/api/proposals/${proposalId}/revisions/${revisionId}/owner`, { decision, ...(factAnswers ? { factAnswers } : {}) },
    ),
  editBooking: (bookingId: string, body: { unitId: string; startsAt: string; endsAt: string; basedOnVersion: number; attestedCustomerIds: string[]; override?: boolean }) =>
    call<Outcome & { proposals?: { id: string; requesterName: string | null }[]; violations?: { message: string }[] }>('POST', `/api/bookings/${bookingId}/edit`, body),
  setPrice: (proposalId: string, priceCents: number) => call<Outcome>('POST', `/api/proposals/${proposalId}/price`, { priceCents }),
  resolveDraft: (draftId: string, agreedByPhone = false) => call<Outcome>('POST', `/api/drafts/${draftId}/resolve`, { agreedByPhone }),
  discardDraft: (draftId: string) => call<Outcome>('POST', `/api/drafts/${draftId}/discard`),
  undoEdit: (bookingId: string) => call<Outcome>('POST', `/api/bookings/${bookingId}/undo`),
  cancelBooking: (bookingId: string, body: { basedOnVersion: number; agreedByPhone: boolean; override?: boolean }) =>
    call<Outcome & { refundCents?: number; refundsOk?: boolean; proposals?: { id: string; requesterName: string | null }[] }>('POST', `/api/bookings/${bookingId}/cancel`, body),
  markOverdue: (bookingId: string, expectedReturnAt: string) => call<Outcome>('POST', `/api/bookings/${bookingId}/overdue`, { expectedReturnAt }),
  markReturned: (bookingId: string) => call<Outcome>('POST', `/api/bookings/${bookingId}/returned`),
  saveFact: (factId: string, value: 'yes' | 'no') => call<Outcome>('POST', `/api/facts/${factId}`, { value }),

  reset: () => call<Outcome>('POST', '/api/demo/reset'),
  switchShop: (scenario: string) => call<Outcome>('POST', '/api/demo/scenario', { scenario }),
  fastForward: (minutes: number) => call<Outcome & { expired: string[] }>('POST', '/api/demo/fast-forward', { minutes }),
};
