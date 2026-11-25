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
  'Best Friend',
  'Mentor',
  'Guide',
  'Stranger',
] as const;

export type PersonalityType = (typeof PERSONALITIES)[number];

/** Rank of each plan: a higher plan unlocks everything a lower one does. */
const PLAN_RANK: Record<PlanType, number> = { free: 0, pro: 1, ultimate: 2 };

/**
 * Plan-based persona gating, enforced server-side in the chat handler.
 * Each persona lists the LOWEST plan that unlocks it:
 *  - free:     Father, Mother, Sister, Brother
 *  - pro:      + Best Friend, Mentor
 *  - ultimate: + Guide, Stranger (all 8)
 * Keep this in sync with TIER_UNLOCKS in the frontend constants.
 */
export const PERSONALITY_MIN_PLAN: Record<PersonalityType, PlanType> = {
  Father: 'free',
  Mother: 'free',
  Sister: 'free',
  Brother: 'free',
  'Best Friend': 'pro',
  Mentor: 'pro',
  Guide: 'ultimate',
  Stranger: 'ultimate',
};

/** Personas available on the free plan (derived from PERSONALITY_MIN_PLAN). */
export const FREE_PERSONALITIES: readonly string[] = PERSONALITIES.filter(
  (p) => PERSONALITY_MIN_PLAN[p] === 'free'
);

/** Lowest plan that unlocks `personality`, or null for an unknown persona. */
export function getRequiredPlan(personality: string): PlanType | null {
  return (PERSONALITY_MIN_PLAN as Record<string, PlanType | undefined>)[personality] ?? null;
}

/**
 * The anonymous listener persona. Replies carry `storeHistory: false` and
 * the system prompt assumes zero user identity.
 */
export const STRANGER_PERSONALITY = 'Stranger' as const;

export function isStrangerPersonality(personality: string): boolean {
  return personality === STRANGER_PERSONALITY;
}

export function isPersonalityAllowed(plan: PlanType, personality: string): boolean {
  const required = getRequiredPlan(personality);
  if (!required) return false; // unknown persona
  return PLAN_RANK[plan] >= PLAN_RANK[required];
}

/**
 * Legacy client aliases, coerced server-side so old app versions and stored
 * values keep working: 'BestFriend' (no space).
 * Anything else unknown is still rejected with a 400.
 */
export const PERSONALITY_ALIASES: Record<string, string> = {
  BestFriend: 'Best Friend',
};

/**
 * Personas that were removed from the app. Old app builds may still send
 * them, so the chat handler answers with a clear "please update" error
 * instead of the generic "Invalid personality" list. Display name per key
 * ('BF' / 'GF' were legacy shorthands).
 */
const RETIRED_PERSONALITY_LABELS: Record<string, string> = {
  Friend: 'Friend',
  Husband: 'Husband',
  Wife: 'Wife',
  Boyfriend: 'Boyfriend',
  Girlfriend: 'Girlfriend',
  BF: 'Boyfriend',
  GF: 'Girlfriend',
};

/** Display name of a removed persona, or null when `value` is not one. */
export function getRetiredPersonalityLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(RETIRED_PERSONALITY_LABELS, value)
    ? RETIRED_PERSONALITY_LABELS[value]
    : null;
}

/**
 * Religion subtype aliases, applied after lowercasing: 'muslim' is accepted
 * as 'islamic' (old clients stored Guide_Muslim). Truly unknown values are
 * still rejected with a 400.
 */
export const RELIGION_ALIASES: Record<string, string> = {
  muslim: 'islamic',
};

export class LimitReachedError extends Error {
  constructor(
    public readonly nextRefreshAt: number,
    public readonly plan: PlanType
  ) {
    super('Message limit reached');
    this.name = 'LimitReachedError';
  }
}

// Per-attempt timeout for upstream AI calls. Past ~10s users read the chat
// as stuck and mobile clients abort anyway, so slow attempts are abandoned
// while the staggered fallback still has room to answer.
export const AI_TIMEOUT_MS = 9000;

// Delay before the fallback attempt starts. Short enough to still answer in
// time when the primary hangs; long enough that a merely slow primary still
// wins and we don't double-bill tokens on every request.
export const CHAT_FALLBACK_STAGGER_MS = 500;

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

// Quota refill visibility (UX gate, not quota accounting): the refill
// countdown is only surfaced once >= 75% of the plan quota is used (or the
// limit is hit). Below that clients hide it. The quota window itself still
// rolls on lastResetAt.

/** Fraction of quota used at/above which the refill countdown is surfaced. */
export const QUOTA_REFILL_VISIBILITY_THRESHOLD = 0.75;

/** 0..1 fraction of the plan quota consumed (clamped). */
export function getQuotaUsageFraction(messageCount: number, limit: number): number {
  if (limit <= 0) return 0;
  const used = Math.max(0, messageCount);
  return Math.min(1, used / limit);
}

/**
 * Whether the client should surface the refill countdown.
 */
export function shouldShowRefillTimer(
  messageCount: number,
  limit: number,
  isLimitReached = messageCount >= limit
): boolean {
  if (isLimitReached) return true;
  return getQuotaUsageFraction(messageCount, limit) >= QUOTA_REFILL_VISIBILITY_THRESHOLD;
}

// Free trial: 5 days of Ultimate for new accounts, once ever. No auto-charge
// (payments are one-time Razorpay orders); expiry downgrades to free and the
// permanent `trialUsed` flag prevents another trial.
export const ULTIMATE_TRIAL_DAYS = 5;
export const ULTIMATE_TRIAL_MS = ULTIMATE_TRIAL_DAYS * 24 * 60 * 60 * 1000;
export const TRIAL_PLAN: PlanType = 'ultimate';

/** Default window (days) after signup during which a trial may be started. */
export const DEFAULT_TRIAL_ELIGIBILITY_WINDOW_DAYS = 7;

/**
 * Account-age window for trial eligibility, read per request so ops can
 * tune it without a restart.
 */
export function getTrialEligibilityWindowDays(): number {
  const raw = Number(process.env.TRIAL_ELIGIBILITY_WINDOW_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TRIAL_ELIGIBILITY_WINDOW_DAYS;
}

/**
 * A selectable plan card. `tier` is the value POST /api/payment-order
 * expects; `null` for the free option (nothing to buy).
 */
export interface PlanOption {
  id: string;
  plan: PlanType;
  tier: Tier | null;
  label: string;
  description: string;
  currency: 'INR';
  /** Price in paise (₹1 = 100 paise). 0 for free. */
  amountPaise: number;
  /** Price in rupees, for display. */
  amount: number;
  period: 'monthly' | 'yearly' | null;
  messageLimit: number;
  refreshHours: number;
  highlights: string[];
  recommended: boolean;
}

/**
 * Post-trial choice cards: free, Pro Monthly/Yearly, Ultimate Monthly/Yearly.
 * Prices render from TIER_PRICES so display always matches the charge.
 */
export function getPlanOptions(): PlanOption[] {
  const deal = (plan: PlanType, period: 'monthly' | 'yearly' | null, tier: Tier | null, label: string, description: string, highlights: string[], recommended: boolean): PlanOption => {
    const amountPaise = tier ? TIER_PRICES[tier] : 0;
    return {
      id: tier ?? 'free',
      plan,
      tier,
      label,
      description,
      currency: 'INR',
      amountPaise,
      amount: amountPaise / 100,
      period,
      messageLimit: PLAN_CONFIG[plan].limit,
      refreshHours: PLAN_CONFIG[plan].refreshMs / (60 * 60 * 1000),
      highlights,
      recommended,
    };
  };

  return [
    deal(
      'free',
      null,
      null,
      'Free',
      'Keep chatting on the house. No card, no commitment.',
      [`${PLAN_CONFIG.free.limit} messages every ${PLAN_CONFIG.free.refreshMs / (60 * 60 * 1000)} hours`, 'Father, Mother, Sister & Brother'],
      false
    ),
    deal(
      'pro',
      'monthly',
      'pro_monthly',
      'Pro Monthly',
      'More room to talk, with Best Friend and Mentor unlocked.',
      [`${PLAN_CONFIG.pro.limit} messages every ${PLAN_CONFIG.pro.refreshMs / (60 * 60 * 1000)} hours`, 'Best Friend & Mentor personas'],
      false
    ),
    deal(
      'pro',
      'yearly',
      'pro_yearly',
      'Pro Yearly',
      'Everything in Pro, billed yearly.',
      [`${PLAN_CONFIG.pro.limit} messages every ${PLAN_CONFIG.pro.refreshMs / (60 * 60 * 1000)} hours`, 'Best Friend & Mentor personas', 'Best value'],
      false
    ),
    deal(
      'ultimate',
      'monthly',
      'ultimate_monthly',
      'Ultimate Monthly',
      'All 8 personas and the highest message allowance.',
      [`${PLAN_CONFIG.ultimate.limit} messages every ${PLAN_CONFIG.ultimate.refreshMs / (60 * 60 * 1000)} hours`, 'All 8 AI personas'],
      true
    ),
    deal(
      'ultimate',
      'yearly',
      'ultimate_yearly',
      'Ultimate Yearly',
      'Everything in Ultimate, billed yearly.',
      [`${PLAN_CONFIG.ultimate.limit} messages every ${PLAN_CONFIG.ultimate.refreshMs / (60 * 60 * 1000)} hours`, 'All 8 AI personas', 'Best value'],
      false
    ),
  ];
}