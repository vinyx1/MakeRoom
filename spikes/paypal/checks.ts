// Automated checks for everything that needs no buyer click: `node checks.ts`.
// Authorizations come from server-side sandbox card orders (see check 6), so no popup is needed.
import {
  authOf, captureAuthorization, captureOf, createCardOrder, getAuthorization, getCapture, getOrder, getRefund,
  refundCapture, voidAuthorization, type Result,
} from './paypal.ts';

const RUN = `spike-${Date.now()}`; // prefix so each run uses fresh PayPal-Request-Ids
const USD = 'USD';
const results: Record<string, unknown> = {};
const err = (r: Result) => ({ status: r.status, name: r.body?.name, issue: r.body?.details?.[0]?.issue, description: r.body?.details?.[0]?.description ?? r.body?.message });

async function cardAuth(cents: number, tag: string) {
  const r = await createCardOrder('AUTHORIZE', cents, USD, { requestId: `${RUN}:${tag}:order` });
  const auth = authOf(r.body);
  if (!auth) throw new Error(`${tag}: no authorization: ${JSON.stringify(err(r))}`);
  return { orderId: r.body.id as string, authId: auth.id as string, authStatus: auth.status as string };
}

async function cardCapture(cents: number, tag: string) {
  const r = await createCardOrder('CAPTURE', cents, USD, { requestId: `${RUN}:${tag}:order` });
  const cap = captureOf(r.body);
  if (!cap) throw new Error(`${tag}: no capture: ${JSON.stringify(err(r))}`);
  return { orderId: r.body.id as string, captureId: cap.id as string, captureStatus: cap.status as string };
}

async function check(name: string, fn: () => Promise<unknown>) {
  try { results[name] = await fn(); } catch (e) { results[name] = { error: String(e) }; }
}

// 2. Capture later, less than authorized (judge C5); also: can we capture MORE than authorized?
await check('2_capture_less', async () => {
  const a = await cardAuth(4500, 'c2');
  const cap = await captureAuthorization(a.authId, 4000, USD, { requestId: `${RUN}:c2:capture` });
  const after = await getAuthorization(a.authId);
  const over = await cardAuth(4500, 'c2over');
  const capOver = await captureAuthorization(over.authId, 6000, USD, { requestId: `${RUN}:c2over:capture` });
  await voidAuthorization(over.authId, { requestId: `${RUN}:c2over:void` });
  return {
    authStatusOnCreate: a.authStatus,
    captureStatus: cap.body?.status, captured: cap.body?.amount, authAfter: after.body?.status,
    captureMoreThanAuthorized: capOver.ok ? { status: capOver.body?.status, amount: capOver.body?.amount } : err(capOver),
  };
});

// 3. Void, and nothing can be captured after a void.
await check('3_void', async () => {
  const a = await cardAuth(4500, 'c3');
  const v = await voidAuthorization(a.authId, { requestId: `${RUN}:c3:void` });
  const after = await getAuthorization(a.authId);
  const capAfterVoid = await captureAuthorization(a.authId, null, USD, { requestId: `${RUN}:c3:capture` });
  const voidAgain = await voidAuthorization(a.authId, { requestId: `${RUN}:c3:void2` });
  return { voidStatus: v.status, authAfter: after.body?.status, captureAfterVoid: err(capAfterVoid), voidTwiceNewId: voidAgain.ok ? voidAgain.status : err(voidAgain) };
});

// 4. Partial refund on an earlier capture; refunds can't exceed what was captured.
await check('4_partial_refund', async () => {
  const c = await cardCapture(9000, 'c4'); // Bob's prepaid booking, $90
  const r1 = await refundCapture(c.captureId, 1500, USD, { requestId: `${RUN}:c4:refund1` });
  const tooMuch = await refundCapture(c.captureId, 8000, USD, { requestId: `${RUN}:c4:refund2` }); // only $75 left
  const rest = await refundCapture(c.captureId, 7500, USD, { requestId: `${RUN}:c4:refund3` });
  const after = await getCapture(c.captureId);
  return {
    prepaidCapture: c.captureStatus,
    refund15: { status: r1.body?.status, amount: r1.body?.amount },
    refund80OfRemaining75: tooMuch.ok ? { UNEXPECTED: tooMuch.body?.status } : err(tooMuch),
    refundRemaining75: { status: rest.body?.status, amount: rest.body?.amount },
    captureAfter: after.body?.status,
  };
});

// 5. Idempotency: same PayPal-Request-Id twice must not act twice.
await check('5_idempotency', async () => {
  const a = await cardAuth(4500, 'c5');
  const cap1 = await captureAuthorization(a.authId, 4500, USD, { requestId: `${RUN}:c5:capture` });
  const cap2 = await captureAuthorization(a.authId, 4500, USD, { requestId: `${RUN}:c5:capture` });
  const capNewId = await captureAuthorization(a.authId, 4500, USD, { requestId: `${RUN}:c5:capture-other` });
  const captureId = cap1.body?.id;
  const ref1 = await refundCapture(captureId, 1000, USD, { requestId: `${RUN}:c5:refund` });
  const ref2 = await refundCapture(captureId, 1000, USD, { requestId: `${RUN}:c5:refund` });
  const ref3DiffAmount = await refundCapture(captureId, 2000, USD, { requestId: `${RUN}:c5:refund` });
  const capAfter = await getCapture(captureId);
  const orderAgain = await createCardOrder('AUTHORIZE', 4500, USD, { requestId: `${RUN}:c5:order` });
  return {
    capture: { first: [cap1.status, captureId], repeat: [cap2.status, cap2.body?.id], sameCapture: cap1.body?.id === cap2.body?.id },
    captureAgainNewId: capNewId.ok ? { UNEXPECTED: capNewId.body?.id } : err(capNewId),
    refund: { first: [ref1.status, ref1.body?.id], repeat: [ref2.status, ref2.body?.id], sameRefund: ref1.body?.id === ref2.body?.id },
    refundSameIdDifferentAmount: ref3DiffAmount.ok ? { status: ref3DiffAmount.status, id: ref3DiffAmount.body?.id, amount: ref3DiffAmount.body?.amount } : err(ref3DiffAmount),
    capturedThenRefunded: capAfter.body?.seller_receivable_breakdown ?? capAfter.body?.status,
    orderCreateRepeat: { sameOrder: orderAgain.body?.id === a.orderId, status: orderAgain.status },
  };
});

// 6. Seeding prepaid captures with no buyer click: direct card capture, then a vaulted card.
await check('6_seed_prepaid', async () => {
  const direct = await cardCapture(9000, 'c6direct');
  const vaultOrder = await createCardOrder('CAPTURE', 9000, USD, { requestId: `${RUN}:c6vault:order`, vault: true });
  const vault = vaultOrder.body?.payment_source?.card?.attributes?.vault;
  let reuse: unknown = 'no vault id';
  if (vault?.id) {
    const r = await createCardOrder('CAPTURE', 4500, USD, { requestId: `${RUN}:c6reuse:order`, vaultId: vault.id });
    reuse = r.ok ? { status: r.body?.status, capture: captureOf(r.body)?.status } : err(r);
  }
  return {
    directCardCapture: direct.captureStatus,
    vault: vaultOrder.ok ? { status: vault?.status, hasId: !!vault?.id, capture: captureOf(vaultOrder.body)?.status } : err(vaultOrder),
    reuseVaultedCard: reuse,
  };
});

// 7. Failures via sandbox negative testing (PayPal-Mock-Response).
await check('7_failures', async () => {
  const declined = await createCardOrder('AUTHORIZE', 4500, USD, { requestId: `${RUN}:c7decl:order`, mock: 'INSTRUMENT_DECLINED' });
  const c = await cardCapture(9000, 'c7');
  const refundFail = await refundCapture(c.captureId, 1500, USD, { requestId: `${RUN}:c7:refund`, mock: 'REFUND_FAILED_INSUFFICIENT_FUNDS' });
  const refundRetry = await refundCapture(c.captureId, 1500, USD, { requestId: `${RUN}:c7:refund` }); // same id, no mock
  const a = await cardAuth(4500, 'c7cap');
  const captureFail = await captureAuthorization(a.authId, 4500, USD, { requestId: `${RUN}:c7cap:capture`, mock: 'INTERNAL_SERVER_ERROR' });
  await voidAuthorization(a.authId, { requestId: `${RUN}:c7cap:void` });
  return {
    declinedAuthorize: declined.ok ? { status: declined.status, orderStatus: declined.body?.status, auth: authOf(declined.body)?.status } : err(declined),
    refundFailure: refundFail.ok ? { status: refundFail.status, refund: refundFail.body?.status } : err(refundFail),
    refundRetrySameIdAfterMockFailure: refundRetry.ok ? { status: refundRetry.body?.status } : err(refundRetry),
    captureServerError: captureFail.ok ? { status: captureFail.status } : err(captureFail),
  };
});

// 8. Status by polling (no webhooks).
await check('8_polling', async () => {
  const a = await cardAuth(4500, 'c8');
  const cap = await captureAuthorization(a.authId, 4500, USD, { requestId: `${RUN}:c8:capture` });
  const ref = await refundCapture(cap.body.id, 1500, USD, { requestId: `${RUN}:c8:refund` });
  const [o, au, ca, re] = await Promise.all([getOrder(a.orderId), getAuthorization(a.authId), getCapture(cap.body.id), getRefund(ref.body.id)]);
  return { order: o.body?.status, authorization: au.body?.status, capture: ca.body?.status, refund: re.body?.status };
});

// 10. Raising the price (judge C4): void the old authorization, authorize the new amount.
await check('10_raise_price', async () => {
  const old = await cardAuth(4500, 'c10old');
  const v = await voidAuthorization(old.authId, { requestId: `${RUN}:c10old:void` });
  const fresh = await cardAuth(5500, 'c10new');
  const cap = await captureAuthorization(fresh.authId, 5500, USD, { requestId: `${RUN}:c10new:capture` });
  return { oldVoided: v.status, newAuth: fresh.authStatus, captured: cap.body?.amount };
});

// Currency: does CAD work on this CA-region merchant too?
await check('currency_CAD', async () => {
  const r = await createCardOrder('AUTHORIZE', 4500, 'CAD', { requestId: `${RUN}:cad:order` });
  const auth = authOf(r.body);
  if (auth) await voidAuthorization(auth.id, { requestId: `${RUN}:cad:void` });
  return r.ok ? { auth: auth?.status } : err(r);
});

console.log(JSON.stringify(results, null, 2));
