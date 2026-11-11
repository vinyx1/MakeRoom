// The demo's shops. A visitor can open either one: the camera shop is the simple story, the equipment yard is the same
// engine under realistic load. What differs between them is data and wording; the rules live in one place.

import { DateTime } from 'luxon';

export const SCENARIOS = ['camera', 'yard'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export type ScenarioProfile = {
  /** For the shop switcher. */
  label: string;
  tagline: string;
  /** Completes "You are the AI assistant of …" in the agent's system prompt. */
  business: string;
  /** The account the customer phone opens on. */
  defaultCustomer: string;
  /** One-click first messages in the customer's own words, by customer name. `{Thu}` etc. name a story day (`storyDays`). */
  suggestions: Record<string, string>;
  /** Which day of the story is today: the seed's clock day (1 = its Monday). */
  storyToday: number;
  /** Maps words in a failed inventory search to a category, so "closest" means the same kind of equipment. */
  categoryHints: [RegExp, string][];
};

export const PROFILES: Record<Scenario, ScenarioProfile> = {
  camera: {
    label: 'Lens & Light Rentals',
    tagline: 'One late camera: the simple story',
    business: 'a small camera rental shop',
    defaultCustomer: 'Vincent',
    suggestions: { Vincent: 'Shoot ran over. Can I keep the camera until {Thu} at 10am?' },
    storyToday: 3,
    categoryHints: [
      [/gimbal|stabili[sz]er/, 'gimbal'],
      [/camera|body|cinema|komodo|red|canon|nikon|sony|fuji/, 'camera_body'],
    ],
  },
  yard: {
    label: 'Ridgeline Equipment Rental',
    tagline: 'A rainy morning: 18 machines, four open problems',
    business: 'a regional construction equipment rental yard serving small contractors',
    defaultCustomer: 'Dune Framing',
    suggestions: {
      'Dune Framing': 'Need a telehandler for a truss lift, {Tue} 7am to {Wed} 5pm. What have you got?',
      Bayview: 'When is my excavator due back?',
    },
    storyToday: 1,
    categoryHints: [
      [/excavator|digger|backhoe|trackhoe|kubota|cat\b|komatsu/, 'excavator'],
      [/skid|loader|bobcat/, 'loader'],
      [/telehandler|forklift|reach|jcb|genie/, 'telehandler'],
      [/scissor|boom|aerial|lift|jlg/, 'aerial_lift'],
      [/roller|compactor|wacker/, 'compaction'],
    ],
  },
};

export const isScenario = (v: unknown): v is Scenario => typeof v === 'string' && (SCENARIOS as readonly string[]).includes(v);
export const profileOf = (scenario: string) => PROFILES[isScenario(scenario) ? scenario : 'camera'];

const STORY_DAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as const;

/**
 * Says the story's days as real ones. The seeds name days by their place in the story, whose "today" falls on the real
 * today (see seed.ts), so "{Thu}" in the camera shop is "tomorrow", and "{Fri}" the real weekday after that.
 */
export function storyDays(text: string, scenario: string, now: Date, zone: string) {
  const today = profileOf(scenario).storyToday;
  return text.replace(/\{(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\}/g, (_, day: keyof typeof STORY_DAY, at: number) => {
    const offset = STORY_DAY[day] - today;
    const word = offset === 0 ? 'today' : offset === 1 ? 'tomorrow' : DateTime.fromJSDate(now, { zone }).plus({ days: offset }).toFormat('cccc');
    const opensSentence = at === 0 || /[.!?]\s+$/.test(text.slice(0, at));
    return opensSentence ? word[0]!.toUpperCase() + word.slice(1) : word;
  });
}
