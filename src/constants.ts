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

/**
 * Plan-based persona gating, enforced SERVER-SIDE in the chat handler
 * (src/routes/chatSend.ts). The frontend's UI locks are cosmetic only.
 *
 * Family + friend personas are free; the rest require a paid plan.
 * If this list ever changes, keep it in sync with the frontend's plan screen.
 */
export const FREE_PERSONALITIES: readonly string[] = [
  'Father',
  'Mother',
  'Sister',
  'Brother',
  'Friend',
  'Best Friend',
];

export function isPersonalityAllowed(plan: PlanType, personality: string): boolean {
  if (plan !== DEFAULT_PLAN) return true; // every paid plan unlocks all personas
  return FREE_PERSONALITIES.includes(personality);
}

export class LimitReachedError extends Error {
  constructor(
    public readonly nextRefreshAt: number,
    public readonly plan: PlanType
  ) {
    super('Message limit reached');
    this.name = 'LimitReachedError';
  }
}

// Per-attempt timeout for upstream AI calls (chat + diagnose). Kept small so
// a hung upstream call can't blow past Vercel's function duration limits,
// but generous enough that slower routes (e.g. OpenRouter free-tier routing)
// can still answer: worst case is 2 x 15s attempts = 30s of a 60s budget.
export const AI_TIMEOUT_MS = 15000;

// Prices in paise (₹1 = 100 paise). Single source of truth for order amounts.
export const TIER_PRICES = {
  pro_monthly: 17900, // ₹179
  pro_yearly: 69900, // ₹699
  ultimate_monthly: 19900, // ₹199
  ultimate_yearly: 79900, // ₹799
} as const;

export type Tier = keyof typeof TIER_PRICES;

const TIER_TO_PLAN: Record<Tier, PlanType> = {
  pro_monthly: 'pro',
  pro_yearly: 'pro',
  ultimate_monthly: 'ultimate',
  ultimate_yearly: 'ultimate',
};

/** Maps a Razorpay checkout tier to an app plan, or null if unknown. */
export function tierToPlan(tier: string): PlanType | null {
  return (TIER_TO_PLAN as Record<string, PlanType | undefined>)[tier] ?? null;
}