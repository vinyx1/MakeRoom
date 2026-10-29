const DAY_MS = 24 * 3600_000;

/** Billing is per started 24h. */
export const billedDays = (start: Date, end: Date) => Math.ceil((end.getTime() - start.getTime()) / DAY_MS);

export const rentalPriceCents = (dailyRateCents: number, start: Date, end: Date) =>
  billedDays(start, end) * dailyRateCents;
