import { z } from 'zod';

// Every tunable limit for a shop, stored in `shops.policy`. Defaults are the demo's values.
export const Policy = z.object({
  default_buffer_minutes: z.number().int().nonnegative().default(240),
  approval_timeout_minutes: z.number().int().positive().default(30),
  discount_band_pct: z.number().nonnegative().max(100).default(10),
  compensation_cap_cents: z.number().int().nonnegative().default(5000),
  /** Goodwill per hour a customer's booking moves for someone else (Bob, 5h later: $15). */
  shift_compensation_cents_per_hour: z.number().int().nonnegative().default(300),
  /** Goodwill on top of the price difference when a customer is moved to a cheaper model (Eve: $15 + $5). */
  downgrade_goodwill_cents: z.number().int().nonnegative().default(500),
  max_shift_hours: z.number().positive().default(6),
  max_bookings_touched: z.number().int().positive().default(3),
  search_window_hours: z.number().positive().default(24),
  model_change_penalty_hours: z.number().nonnegative().default(6),
  max_revisions: z.number().int().positive().default(3),
  max_fallback_plans: z.number().int().nonnegative().default(2),
  grace_minutes: z.number().int().nonnegative().default(60),
  cancel_full_refund_hours: z.number().nonnegative().default(24),
  cancel_late_refund_pct: z.number().nonnegative().max(100).default(50),
  payment_retry_limit: z.number().int().positive().default(3),
});
export type Policy = z.infer<typeof Policy>;

export const defaultPolicy = (): Policy => Policy.parse({});
