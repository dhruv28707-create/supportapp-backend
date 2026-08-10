export const PLAN_CONFIG = {
  free: { limit: 20, refreshMs: 5 * 60 * 60 * 1000 },
  pro: { limit: 80, refreshMs: 4 * 60 * 60 * 1000 },
  ultimate: { limit: 200, refreshMs: 2 * 60 * 60 * 1000 },
} as const;

export type PlanType = keyof typeof PLAN_CONFIG;

export const DEFAULT_PLAN: PlanType = 'free';

export const PERSONALITIES = [
  'Father',
  'Mother',
  'Sister',
  'Brother',
  'Friend',
  'Best Friend',
  'Mentor',
  'Guide',
  'Husband',
  'Wife',
  'Boyfriend',
  'Girlfriend',
] as const;

export type PersonalityType = (typeof PERSONALITIES)[number];

export class LimitReachedError extends Error {
  constructor(
    public readonly nextRefreshAt: number,
    public readonly plan: PlanType
  ) {
    super('Message limit reached');
    this.name = 'LimitReachedError';
  }
}

// Per-attempt timeout for upstream Groq calls (chat + diagnose). Kept small so
// a hung upstream call can't blow past Vercel's function duration limits.
export const GROQ_TIMEOUT_MS = 10000;

// Prices in paise (₹1 = 100 paise). Single source of truth for order amounts.
export const TIER_PRICES = {
  pro_monthly: 17900, // ₹179
  pro_yearly: 69900, // ₹699
  ultimate_monthly: 19900, // ₹199
  ultimate_yearly: 79900, // ₹799
} as const;

export type Tier = keyof typeof TIER_PRICES;

export const TIER_TO_PLAN: Record<Tier, PlanType> = {
  pro_monthly: 'pro',
  pro_yearly: 'pro',
  ultimate_monthly: 'ultimate',
  ultimate_yearly: 'ultimate',
};

/** Maps a Razorpay checkout tier to an app plan, or null if unknown. */
export function tierToPlan(tier: string): PlanType | null {
  return (TIER_TO_PLAN as Record<string, PlanType | undefined>)[tier] ?? null;
}