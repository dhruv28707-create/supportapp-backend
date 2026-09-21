import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/firebaseAdmin';
import { PLAN_CONFIG, PlanType, DEFAULT_PLAN, LimitReachedError } from '../constants';
import { SUBSCRIPTIONS_COLLECTION, PAYMENTS_COLLECTION } from './subscriptionService';

export interface UserMessageState {
  plan: PlanType;
  messageCount: number;
  lastResetAt: number;
}

interface SubscriptionState {
  plan: PlanType;
  messageCount: number;
  lastResetAt: number;
  expiresAt: number | null;
}

function toEpochMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    const date = (value as { toDate: () => Date }).toDate();
    return date instanceof Date ? date.getTime() : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeState(data: Record<string, unknown>): SubscriptionState {
  const planRaw = typeof data.plan === 'string' ? data.plan : '';
  const plan: PlanType = (PLAN_CONFIG as Record<string, unknown>)[planRaw]
    ? (planRaw as PlanType)
    : DEFAULT_PLAN;

  return {
    plan,
    messageCount: typeof data.messageCount === 'number' ? data.messageCount : 0,
    lastResetAt: typeof data.lastResetAt === 'number' ? data.lastResetAt : 0,
    expiresAt: toEpochMs(data.expiresAt),
  };
}

/**
 * Reads subscription state from the server-only `subscriptions/{uid}` doc
 * (plain reads, no transaction). On missing doc, falls back to the legacy
 * `users/{uid}` plan — trusted ONLY when backed by a verified paid payment
 * record (the users collection may be client-writable).
 */
async function loadSubscriptionState(uid: string): Promise<SubscriptionState> {
  const subSnap = await db.collection(SUBSCRIPTIONS_COLLECTION).doc(uid).get();

  if (subSnap.exists) {
    return normalizeState(subSnap.data() || {});
  }

  const userSnap = await db.collection('users').doc(uid).get();
  if (userSnap.exists) {
    const userData = (userSnap.data() || {}) as Record<string, unknown>;
    const legacy = normalizeState(userData);
    const orderId =
      typeof userData.razorpayOrderId === 'string' ? userData.razorpayOrderId : null;
    if (
      legacy.plan !== DEFAULT_PLAN &&
      legacy.expiresAt !== null &&
      legacy.expiresAt > Date.now() &&
      orderId !== null
    ) {
      const paymentSnap = await db.collection(PAYMENTS_COLLECTION).doc(orderId).get();
      if (paymentSnap.exists && paymentSnap.data()?.status === 'paid') {
        return { ...legacy, lastResetAt: Date.now() };
      }
    }
  }

  return { plan: DEFAULT_PLAN, messageCount: 0, lastResetAt: Date.now(), expiresAt: null };
}

/** Applies subscription expiry: an expired paid plan is downgraded to free. */
function applyExpiry(state: SubscriptionState, now: number): SubscriptionState {
  if (
    state.plan !== DEFAULT_PLAN &&
    state.expiresAt !== null &&
    now >= state.expiresAt
  ) {
    // Downgrade resets quota so the user starts fresh on free (otherwise a
    // heavy paid user would land on free with 0 remaining messages).
    return { ...state, plan: DEFAULT_PLAN, expiresAt: null, messageCount: 0 };
  }
  return state;
}

// ---------------------------------------------------------------------------
// Plan-state TTL cache
//
// The chat persona gate and plan reads used to run inside Firestore
// transactions on every request. On a warm serverless instance this cache
// serves repeated reads for the same uid from memory, cutting Firestore load
// on the hot path. Every write path below (and grantPlanAndMarkPaid /
// cancelUserSubscription in subscriptionService) invalidates the uid's entry
// so grants, cancels and quota updates are visible immediately. Worst-case
// staleness is the TTL.
// ---------------------------------------------------------------------------

const PLAN_CACHE_TTL_MS = 15_000;

const planCache = new Map<string, { expiresAt: number; value: UserMessageState }>();

export function invalidatePlanCache(uid: string): void {
  planCache.delete(uid);
}

/**
 * Effective plan (expiry applied, window refreshed in the returned numbers)
 * WITHOUT consuming anything or writing to Firestore. Cached briefly per
 * uid. Used by read-only decisions such as server-side persona gating.
 */
export async function getPlanState(uid: string): Promise<UserMessageState> {
  const cached = planCache.get(uid);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const state = applyExpiry(await loadSubscriptionState(uid), now);
  const config = PLAN_CONFIG[state.plan];

  let messageCount = state.messageCount;
  let lastResetAt = state.lastResetAt;
  if (now - lastResetAt >= config.refreshMs) {
    messageCount = 0;
    lastResetAt = now;
  }

  const value: UserMessageState = { plan: state.plan, messageCount, lastResetAt };
  planCache.set(uid, { expiresAt: now + PLAN_CACHE_TTL_MS, value });
  return value;
}

/**
 * Consumes one message from the user's quota. Throws LimitReachedError when
 * the limit is hit. Call this only AFTER a successful AI reply so that failed
 * AI calls do not burn the user's message allowance.
 *
 * Concurrency: the counter is a single atomic FieldValue.increment(1) on
 * `subscriptions/{uid}` — no transaction. The old transactional
 * read-check-write serialized every burst on one doc (~1 write/sec/doc
 * soft cap), causing transaction retries and 500s under load. The
 * allow-check reads the pre-increment count, so a hard concurrent burst can
 * overshoot the plan limit slightly; for a chat quota that is acceptable
 * (the user genuinely sent those messages), while availability under load
 * improves dramatically.
 *
 * Rare repairs piggyback on the same write: refreshing an expired window
 * (lastResetAt), persisting an expiry downgrade to free (plan + expiresAt),
 * and materializing a migrated legacy plan on the user's first message.
 */
export async function consumeMessage(uid: string): Promise<{ success: true }> {
  const now = Date.now();

  // Load fresh state (bypass the TTL cache): the cache may hold a stale plan
  // right after a grant/cancel, and getPlanState's window-refresh would mask
  // whether the stored window actually rolled over.
  const raw = await loadSubscriptionState(uid);
  const state = applyExpiry(raw, now);
  const downgraded = state.plan !== raw.plan || state.expiresAt !== raw.expiresAt;
  const config = PLAN_CONFIG[state.plan];

  let effectiveCount = state.messageCount;
  let effectiveReset = state.lastResetAt;
  const windowExpired = now - effectiveReset >= config.refreshMs;
  if (windowExpired) {
    effectiveCount = 0;
    effectiveReset = now;
  }

  if (effectiveCount >= config.limit) {
    throw new LimitReachedError(effectiveReset + config.refreshMs, state.plan);
  }

  const needsResetWrite = windowExpired || downgraded;

  try {
    if (needsResetWrite) {
      // Persist the reset (and any expiry downgrade) with an explicit count
      // of 1: FieldValue.increment(1) would keep growing from the stale
      // stored value (e.g. 20 -> 21) instead of resetting to 1.
      const fields: Record<string, unknown> = {
        plan: state.plan,
        expiresAt: state.expiresAt,
        messageCount: 1,
        lastResetAt: effectiveReset,
        updatedAt: now,
      };
      await db.collection(SUBSCRIPTIONS_COLLECTION).doc(uid).set(fields, { merge: true });
    } else {
      const fields: Record<string, unknown> = {
        plan: state.plan,
        messageCount: FieldValue.increment(1),
        updatedAt: now,
      };
      if (state.plan === DEFAULT_PLAN) {
        // Free plan (including a just-applied expiry downgrade): clear any
        // stale expiry so downstream reads see a consistent doc.
        fields.expiresAt = null;
      }

      await db.collection(SUBSCRIPTIONS_COLLECTION).doc(uid).set(fields, { merge: true });
    }
  } finally {
    invalidatePlanCache(uid);
  }

  return { success: true };
}

/**
 * Read path for GET /api/user/plan: returns current state and, when the
 * window has rolled over, persists the reset (and any expiry downgrade) so
 * other endpoints see consistent state. Best-effort writes: a failed reset
 * write logs but still reports the refreshed numbers.
 */
export async function checkAndResetOnly(uid: string): Promise<UserMessageState> {
  const now = Date.now();
  const raw = await loadSubscriptionState(uid);
  const state = applyExpiry(raw, now);
  const config = PLAN_CONFIG[state.plan];
  const downgraded = state.plan !== raw.plan || state.expiresAt !== raw.expiresAt;

  let { messageCount, lastResetAt } = state;

  if (now - lastResetAt >= config.refreshMs) {
    messageCount = 0;
    lastResetAt = now;
    try {
      await db
        .collection(SUBSCRIPTIONS_COLLECTION)
        .doc(uid)
        .set(
          {
            plan: state.plan,
            expiresAt: state.expiresAt,
            messageCount: 0,
            lastResetAt,
            updatedAt: now,
          },
          { merge: true }
        );
      invalidatePlanCache(uid);
    } catch (error) {
      console.error(`[quota] Window reset write failed uid=${uid.slice(0, 8)}:`, error);
    }
  } else if (downgraded) {
    // Expiry downgraded the plan relative to the stored doc — persist it and
    // reset the quota so free starts at 0 (not the paid count).
    messageCount = 0;
    try {
      await db
        .collection(SUBSCRIPTIONS_COLLECTION)
        .doc(uid)
        .set(
          {
            plan: state.plan,
            expiresAt: state.expiresAt,
            messageCount: 0,
            updatedAt: now,
          },
          { merge: true }
        );
      invalidatePlanCache(uid);
    } catch (error) {
      console.error(`[quota] Expiry downgrade write failed uid=${uid.slice(0, 8)}:`, error);
    }
  }

  return { plan: state.plan, messageCount, lastResetAt };
}
