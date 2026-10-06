import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/firebaseAdmin';
import { PLAN_CONFIG, PlanType, DEFAULT_PLAN, LimitReachedError } from '../constants';
import { SUBSCRIPTIONS_COLLECTION, PAYMENTS_COLLECTION } from './subscriptionService';

export interface UserMessageState {
  plan: PlanType;
  messageCount: number;
  lastResetAt: number;
  /** True while the 5-day Ultimate free trial is active. */
  isTrial: boolean;
  /** Trial end (epoch ms) while a trial is active, else null. */
  trialEndsAt: number | null;
  /** Permanent: the account has consumed its one free trial. */
  trialUsed: boolean;
}

interface SubscriptionState {
  plan: PlanType;
  messageCount: number;
  lastResetAt: number;
  expiresAt: number | null;
  isTrial: boolean;
  trialEndsAt: number | null;
  trialUsed: boolean;
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

  const rawCount = typeof data.messageCount === 'number' ? data.messageCount : 0;

  return {
    plan,
    messageCount: Math.max(0, Math.floor(rawCount)),
    lastResetAt: typeof data.lastResetAt === 'number' ? data.lastResetAt : 0,
    expiresAt: toEpochMs(data.expiresAt),
    isTrial: data.isTrial === true,
    trialEndsAt: toEpochMs(data.trialEndsAt),
    trialUsed: data.trialUsed === true,
  };
}

/**
 * Reads subscription state from server-only `subscriptions/{uid}`. On a
 * missing doc, falls back to legacy `users/{uid}` only when backed by a
 * verified paid payment record (users docs may be client-writable).
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

  return {
    plan: DEFAULT_PLAN,
    messageCount: 0,
    lastResetAt: Date.now(),
    expiresAt: null,
    isTrial: false,
    trialEndsAt: null,
    trialUsed: false,
  };
}

/** Applies subscription expiry: an expired paid plan is downgraded to free. */
function applyExpiry(state: SubscriptionState, now: number): SubscriptionState {
  if (
    state.plan !== DEFAULT_PLAN &&
    state.expiresAt !== null &&
    now >= state.expiresAt
  ) {
    // Downgrade resets quota so the user starts fresh on free. `trialUsed`
    // survives via the spread.
    return {
      ...state,
      plan: DEFAULT_PLAN,
      expiresAt: null,
      messageCount: 0,
      isTrial: false,
      trialEndsAt: null,
    };
  }
  return state;
}

// Plan-state reads are always fresh from Firestore (no cache), so every
// serverless instance sees coherent state.

/**
 * Effective plan (expiry applied, window refreshed) without consuming
 * anything. Used for read-only decisions like persona gating.
 */
export async function getPlanState(uid: string): Promise<UserMessageState> {
  const now = Date.now();
  const state = applyExpiry(await loadSubscriptionState(uid), now);
  const config = PLAN_CONFIG[state.plan];

  let messageCount = state.messageCount;
  let lastResetAt = state.lastResetAt;
  if (now - lastResetAt >= config.refreshMs) {
    messageCount = 0;
    lastResetAt = now;
  }

  return {
    plan: state.plan,
    messageCount,
    lastResetAt,
    isTrial: state.isTrial,
    trialEndsAt: state.trialEndsAt,
    trialUsed: state.trialUsed,
  };
}

/**
 * Consumes one message of quota. Throws LimitReachedError at the limit. Call
 * only after a successful AI reply so failures don't burn allowance.
 *
 * Single atomic increment(1), no transaction: transactions serialize per doc
 * and collapse under burst load. A hard concurrent burst can overshoot the
 * limit slightly — acceptable for a chat quota; availability matters more.
 */
export async function consumeMessage(uid: string): Promise<{ success: true }> {
  const now = Date.now();

  // getPlanState's window-refresh would mask whether the stored window
  // actually rolled over, so load raw state here.
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

  if (needsResetWrite) {
    // Persist the reset with an explicit count of 1: increment(1) would keep
    // growing from the stale stored value instead of resetting.
    const fields: Record<string, unknown> = {
      plan: state.plan,
      expiresAt: state.expiresAt,
      messageCount: 1,
      lastResetAt: effectiveReset,
      updatedAt: now,
      // `state` is post-applyExpiry: an expired trial is already cleared
      // here (isTrial false / trialEndsAt null) while trialUsed persists.
      isTrial: state.isTrial,
      trialEndsAt: state.trialEndsAt,
    };
    await db.collection(SUBSCRIPTIONS_COLLECTION).doc(uid).set(fields, { merge: true });
  } else {
    const fields: Record<string, unknown> = {
      plan: state.plan,
      messageCount: FieldValue.increment(1),
      updatedAt: now,
    };
    if (state.plan === DEFAULT_PLAN) {
      fields.expiresAt = null;
      fields.isTrial = false;
      fields.trialEndsAt = null;
    }

    await db.collection(SUBSCRIPTIONS_COLLECTION).doc(uid).set(fields, { merge: true });
  }

  return { success: true };
}

/**
 * Read path for GET /api/user/plan: current state, persisting a rolled-over
 * window or expiry downgrade best-effort so other endpoints see it too.
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
            isTrial: state.isTrial,
            trialEndsAt: state.trialEndsAt,
          },
          { merge: true }
        );
    } catch (error) {
      console.error(`[quota] Window reset write failed uid=${uid.slice(0, 8)}:`, error);
    }
  } else if (downgraded) {
    // Persist the expiry downgrade and reset quota to 0 for the free plan.
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
            lastResetAt: state.lastResetAt,
            updatedAt: now,
            isTrial: state.isTrial,
            trialEndsAt: state.trialEndsAt,
          },
          { merge: true }
        );
    } catch (error) {
      console.error(`[quota] Expiry downgrade write failed uid=${uid.slice(0, 8)}:`, error);
    }
  }

  return {
    plan: state.plan,
    messageCount,
    lastResetAt,
    isTrial: state.isTrial,
    trialEndsAt: state.trialEndsAt,
    trialUsed: state.trialUsed,
  };
}
