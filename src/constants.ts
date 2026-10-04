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

// Per-attempt timeout for upstream AI calls (chat + diagnose).
//
// Latency budget: users read anything past ~10s as "it's stuck", and mobile
// clients abort around 10s anyway, so a 15s attempt produced nothing at all
// for a hung provider. At 9s a slow attempt is abandoned while the
// staggered fallback still has room to answer inside the user's patience
// window.
export const AI_TIMEOUT_MS = 9000;

// How long after the primary attempt the fallback is launched (see
// chatSend.ts). Short enough that the fallback still answers in time when
// the primary is hung; long enough that a merely slow-but-healthy
// primary still wins, so we don't double-bill tokens on every request.
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

// ---------------------------------------------------------------------------
// Quota refill visibility (UX gate, not a quota-accounting change)
//
// Complaint: the refill countdown started from the very first message, so a
// user opening the app or sending 1 message immediately saw "refills in Xh".
// Rule now: the refill timer is only SURFACED once >= 75% of the plan quota
// is used (or the limit is reached). Below that the backend still reports
// quota counts, but sets showRefillTimer=false so clients hide the countdown.
// Where to show it is a frontend decision — lobby/chat must ignore the timer,
// Settings may show it when showRefillTimer is true. The quota window itself
// still rolls on lastResetAt; this only gates visibility.
// ---------------------------------------------------------------------------

/** Fraction of quota used at/above which the refill countdown is surfaced. */
export const QUOTA_REFILL_VISIBILITY_THRESHOLD = 0.75;

/** 0..1 fraction of the plan quota consumed (clamped). */
export function getQuotaUsageFraction(messageCount: number, limit: number): number {
  if (limit <= 0) return 0;
  const used = Math.max(0, messageCount);
  return Math.min(1, used / limit);
}

/**
 * Whether the client should surface the refill countdown at all.
 * True when the limit is reached or usage >= 75%. Below that, lobby/chat
 * must stay clean and even Settings should not show a countdown.
 */
export function shouldShowRefillTimer(
  messageCount: number,
  limit: number,
  isLimitReached = messageCount >= limit
): boolean {
  if (isLimitReached) return true;
  return getQuotaUsageFraction(messageCount, limit) >= QUOTA_REFILL_VISIBILITY_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Free trial (Ultimate only, NEW accounts only, once per account)
//
// A newly-signed-up user may activate 5 days of Ultimate for free via
// POST /api/trial/start. There is no auto-charge (payments are one-time
// Razorpay orders); when the 5 days end the plan downgrades to free and the
// permanent `trialUsed` flag prevents another trial ever. The user is then
// offered the choice cards from getPlanOptions(): free / monthly / yearly.
// ---------------------------------------------------------------------------
export const ULTIMATE_TRIAL_DAYS = 5;
export const ULTIMATE_TRIAL_MS = ULTIMATE_TRIAL_DAYS * 24 * 60 * 60 * 1000;
export const TRIAL_PLAN: PlanType = 'ultimate';

/** Default window (days) after signup during which a trial may be started. */
export const DEFAULT_TRIAL_ELIGIBILITY_WINDOW_DAYS = 7;

/**
 * Account-age window for trial eligibility, read lazily (per request) so
 * tests/ops can change it without an import-time freeze.
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
 * The post-trial choice cards: free, Ultimate Monthly, Ultimate Yearly —
 * all three Ultimate options render from this one source of truth, so the
 * displayed price always matches what payment-order will charge. Add the pro
 * tiers here if they should be shown too.
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
      [`${PLAN_CONFIG.free.limit} messages every ${PLAN_CONFIG.free.refreshMs / (60 * 60 * 1000)} hours`, 'Family & friend personas'],
      false
    ),
    deal(
      'ultimate',
      'monthly',
      'ultimate_monthly',
      'Ultimate Monthly',
      'All 12 personas and the highest message allowance.',
      [`${PLAN_CONFIG.ultimate.limit} messages every ${PLAN_CONFIG.ultimate.refreshMs / (60 * 60 * 1000)} hours`, 'All 12 AI personas'],
      true
    ),
    deal(
      'ultimate',
      'yearly',
      'ultimate_yearly',
      'Ultimate Yearly',
      'Everything in Ultimate, billed yearly.',
      [`${PLAN_CONFIG.ultimate.limit} messages every ${PLAN_CONFIG.ultimate.refreshMs / (60 * 60 * 1000)} hours`, 'All 12 AI personas', 'Best value'],
      false
    ),
  ];
}