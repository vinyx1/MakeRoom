// What one agent turn may see and touch: one shop, one customer, one conversation (docs/agent-tools.md §1).
// Ids shown to the model are short and opaque (`bk_3f9a2c`); only ids handed out in this turn resolve, so an id
// from outside the scope is NOT_FOUND, the same as one that doesn't exist.

import { DateTime } from 'luxon';
import type { Index } from '../optimizer/snapshot.ts';

export type IdKind = 'bk' | 'rq' | 'rv' | 'md' | 'un';

export class ShortIds {
  private long = new Map<string, string>();
  private short = new Map<string, string>();

  of(kind: IdKind, id: string): string {
    const known = this.short.get(`${kind}:${id}`);
    if (known) return known;
    const hex = id.replaceAll('-', '');
    let len = 6;
    let candidate = `${kind}_${hex.slice(0, len)}`;
    while (this.long.has(candidate)) candidate = `${kind}_${hex.slice(0, ++len)}`;
    this.long.set(candidate, id);
    this.short.set(`${kind}:${id}`, candidate);
    return candidate;
  }

  /** The real id behind a short one of the given kind, or null. */
  resolve(kind: IdKind, short: string): string | null {
    if (!short.startsWith(`${kind}_`)) return null;
    return this.long.get(short.trim()) ?? null;
  }
}

/** Shop-local times for the model: an input string, and a display string it copies verbatim. */
export function shopTime(idx: Index) {
  const zone = idx.snap.shop.timezone;
  return {
    /** "2026-10-29T10:00" (shop-local) → Date, or null if malformed. */
    parse(local: string): Date | null {
      const d = DateTime.fromISO(local, { zone });
      return d.isValid ? d.toJSDate() : null;
    },
    show(d: Date) {
      const t = DateTime.fromJSDate(d, { zone }).setLocale('en-US');
      return { local: t.toFormat("yyyy-LL-dd'T'HH:mm"), display: t.toFormat('ccc d LLL, h:mma').replace('AM', 'am').replace('PM', 'pm') };
    },
    display(d: Date) {
      return this.show(d).display;
    },
    /** "Wed 28 Oct = 2026-10-28 · Thu 29 Oct = …": relative dates by lookup, not arithmetic. */
    calendar(days = 14) {
      const start = DateTime.fromJSDate(idx.snap.now, { zone }).startOf('day').setLocale('en-US');
      return Array.from({ length: days }, (_, i) => {
        const d = start.plus({ days: i });
        return `${d.toFormat('ccc d LLL')} = ${d.toFormat('yyyy-LL-dd')}`;
      }).join(' · ');
    },
  };
}

export const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const MONEY = /\$\s?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?/g;

/** Dollar amounts in a text, in cents. */
export function amountsIn(text: string): number[] {
  return [...text.matchAll(MONEY)].map((m) => Number(m[1]!.replace(/,/g, '')) * 100 + Number((m[2] ?? '0').padEnd(2, '0')));
}
