// What Bryntum's scheduling engine makes of a request, in a line or two on the owner's cards. It is a second opinion
// on the optimizer's plans, computed in the browser from the same bookings (see ../engine.ts); it never changes anything.

import { useEffect, useState } from 'react';
import type { OwnerView, Proposal } from '../api';
import { type EnginePush, solveCascade, verifyPlan } from '../engine';
import { shopTime } from '../live';

type Result = { plans: { label: string; pushes: EnginePush[] }[]; cascade: EnginePush[] };

/** `compact` is one line, for a list of requests; the owner's approval card gets the full note. */
export function EngineNote({ owner, proposal, revisionId, compact = false }: { owner: OwnerView; proposal: Proposal; revisionId?: string | null; compact?: boolean }) {
  const [result, setResult] = useState<Result | null>(null);
  // Recompute only when something the engine is given has changed, not on every refresh of the owner view.
  const signature = JSON.stringify([
    owner.bookings.map((b) => [b.id, b.version, b.unitId, b.startsAt, b.endsAt, b.bufferEndsAt, b.status]),
    owner.unavailability.map((u) => [u.id, u.unitId, u.period.start, u.period.end]),
    proposal.revisions.map((r) => [r.id, r.status, r.changes.map((c) => [c.id, c.newUnitId, c.newStartsAt, c.newEndsAt, c.newBufferEndsAt])]),
    revisionId,
  ]);

  useEffect(() => {
    let current = true;
    const revisions = proposal.revisions.filter((r) => !revisionId || r.id === revisionId);
    void (async () => {
      try {
        const plans = [];
        for (const r of revisions) plans.push({ label: r.optionLabel ? `Plan ${r.optionLabel}` : 'The plan', pushes: await verifyPlan(owner, r) });
        const cascade = await solveCascade(owner, proposal);
        if (current) setResult({ plans, cascade });
      } catch (e) {
        console.warn('Bryntum engine check failed', e);
        if (current) setResult(null);
      }
    })();
    return () => {
      current = false;
    };
  }, [signature]);

  if (!result || !result.plans.length) return null;
  const zone = owner.shop.timezone;
  const when = (d: Date) => shopTime(d, zone);
  const describe = (p: EnginePush) => (p.maintenance ? `it runs into ${p.name}` : `${p.name}'s ${p.unit} pickup would have to move from ${when(p.planned)} to ${when(p.engine)}`);

  if (compact) {
    const bad = result.plans.filter((p) => p.pushes.length);
    return (
      <div className={`engine-line ${bad.length ? 'engine-no' : 'engine-ok'}`}>
        Bryntum engine: <b>{bad.length ? 'disagrees' : 'agrees'}</b> {bad.length ? `on ${bad.map((p) => p.label).join(' and ')}` : `with ${result.plans.map((p) => p.label).join(' and ')}`}
      </div>
    );
  }
  return (
    <div className="engine-note">
      <div className="engine-title">Bryntum scheduling engine</div>
      {result.plans.map((p) => (
        <div key={p.label} className={p.pushes.length ? 'engine-no' : 'engine-ok'}>
          <b>{p.pushes.length ? 'Disagrees' : 'Agrees'}</b>
          {result.plans.length > 1 && <> on {p.label}</>}
          {p.pushes.length === 0 ? ': no overlaps, every turnaround kept, pickups within shop hours.' : `: ${p.pushes.map(describe).join('; ')}.`}
        </div>
      ))}
      {result.cascade.length > 0 && (
        <div className="engine-cascade">
          On its own, the engine would just slide {result.cascade.map((p) => `${p.name} from ${when(p.planned)} to ${when(p.engine)}`).join(', ')}. The optimizer also tries other units and models.
        </div>
      )}
    </div>
  );
}
