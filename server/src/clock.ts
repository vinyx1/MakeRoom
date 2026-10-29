/** The shop's "now": server time plus the shop's offset (seeding sets Wed 2pm; fast-forward adds to it). */
export const shopNow = (shop: { clockOffsetMs: number }, realNow = new Date()) =>
  new Date(realNow.getTime() + shop.clockOffsetMs);
