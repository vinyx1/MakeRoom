// Pointing at a request's card lights up what it would change on the schedule. The cards and the schedule are far
// apart in the tree and this is only a hover, so it travels as a window event rather than through React state.

const EVENT = 'makeroom:highlight-request';

export function highlightRequest(proposalId: string | null) {
  window.dispatchEvent(new CustomEvent<string | null>(EVENT, { detail: proposalId }));
}

export function onHighlightRequest(listener: (proposalId: string | null) => void) {
  const handler = (e: Event) => listener((e as CustomEvent<string | null>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

/** Spread onto a card that belongs to a request. */
export function pointsAtRequest(proposalId: string | null | undefined) {
  if (!proposalId) return {};
  return { onMouseEnter: () => highlightRequest(proposalId), onMouseLeave: () => highlightRequest(null) };
}
