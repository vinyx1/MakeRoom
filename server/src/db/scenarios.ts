// The demo's shops. A visitor can open either one: the camera shop is the simple story, the equipment yard is the same
// engine under realistic load. What differs between them is data and wording; the rules live in one place.

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
  /** One-click first messages in the customer's own words, by customer name. */
  suggestions: Record<string, string>;
  /** Maps words in a failed inventory search to a category, so "closest" means the same kind of equipment. */
  categoryHints: [RegExp, string][];
};

export const PROFILES: Record<Scenario, ScenarioProfile> = {
  camera: {
    label: 'Lens & Light Rentals',
    tagline: 'One late camera: the simple story',
    business: 'a small camera rental shop',
    defaultCustomer: 'Vincent',
    suggestions: { Vincent: 'Shoot ran over. Can I keep the camera until Thursday at 10am?' },
    categoryHints: [
      [/gimbal|stabili[sz]er/, 'gimbal'],
      [/camera|body|cinema|komodo|red|canon|nikon|sony|fuji/, 'camera_body'],
    ],
  },
  yard: {
    label: 'Ridgeline Equipment Rental',
    tagline: 'A rainy Monday: 18 machines, four open problems',
    business: 'a regional construction equipment rental yard serving small contractors',
    defaultCustomer: 'Dune Framing',
    suggestions: {
      'Dune Framing': 'Need a telehandler for a truss lift, Tuesday 7am to Wednesday 5pm. What have you got?',
      Bayview: 'When is my excavator due back?',
    },
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
