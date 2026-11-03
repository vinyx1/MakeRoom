// Per-session limits on the routes that cost something: agent turns, PayPal calls, reseeding a shop.
// In memory: one server process, and a restart forgetting a minute of counts does no harm.

const MINUTE = 60_000;

const LIMITS = [
  { name: 'chat', pattern: /\/messages$/, max: 20, windowMs: MINUTE, message: 'Too many messages. Please wait a minute and try again.' },
  { name: 'payment', pattern: /\/(order|accept|send|cancel)$/, max: 20, windowMs: MINUTE, message: 'Too many payment requests. Please wait a minute and try again.' },
  { name: 'reset', pattern: /\/demo\/reset$/, max: 10, windowMs: 60 * MINUTE, message: 'Too many resets. Please try again later.' },
];

export const limitFor = (route: string) => LIMITS.find((l) => l.pattern.test(route)) ?? null;

export function createRateLimiter(now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return {
    /** Counts this request unless the key is already at `max` within the window. */
    allow(key: string, max: number, windowMs: number) {
      const t = now();
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.at(-1)! <= t - windowMs) hits.delete(k);
      const recent = (hits.get(key) ?? []).filter((x) => x > t - windowMs);
      if (recent.length >= max) return false;
      recent.push(t);
      hits.set(key, recent);
      return true;
    },
  };
}
