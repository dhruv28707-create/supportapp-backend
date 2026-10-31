import { db } from '../config/firebaseAdmin';
import { PLAN_CONFIG, PlanType, DEFAULT_PLAN, LimitReachedError } from '../constants';
import { SUBSCRIPTIONS_COLLECTION, PAYMENTS_COLLECTION } from './subscriptionService';

export interface UserMessageState {
  plan: PlanType;
  messageCount: number;
  lastResetAt: number;
  /** Active paid/trial term end (epoch ms), else null. */
  expiresAt: number | null;
  /** True while the 5-day Ultimate free trial is active. */
  isTrial: boolean;
  /** Trial end (epoch ms) while a trial is active, else null. */
  trialEndsAt: number | null;
  /** Permanent: the account has consumed its one free trial. */
  trialUsed: boolean;
  /** Server-verified developer account: premium access, no quota writes. */
  isDeveloper: boolean;
  /** Developer accounts are never quota-limited. */
  unlimited: boolean;
}

interface SubscriptionState {
  plan: PlanType;
  messageCount: number;
  lastResetAt: number;
  expiresAt: number | null;
  isTrial: boolean;
  trialEndsAt: number | null;
  trialUsed: boolean;
  isDeveloper: boolean;
  unlimited: boolean;
}

/** Plan reported for developer accounts; all personas are unlocked. */
const DEVELOPER_PLAN: PlanType = 'ultimate';

function developerSubscriptionState(): SubscriptionState {
  return {
    plan: DEVELOPER_PLAN,
    messageCount: 0,
    lastResetAt: Date.now(),
    expiresAt: null,
    isTrial: false,
    trialEndsAt: null,
    trialUsed: false,
    isDeveloper: true,
    unlimited: true,
  };
}

function developerMessageState(): UserMessageState {
  return { ...developerSubscriptionState() };
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
    isDeveloper: data.isDeveloper === true || data.developer === true,
    unlimited: data.unlimited === true,
  };
}

/** Minimal snapshot surface (satisfied by admin snapshots and tx.get()). */
interface QuotaDocSnapshot {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

/**
 * Derives raw subscription state from `subscriptions/{uid}`. On a missing
 * doc, falls back to legacy `users/{uid}` only when backed by a verified
 * paid payment record (users docs may be client-writable). Shared by the
 * plain read path and the consume transaction — the transaction MUST use
 * this same derivation so a burst cannot see different rules than the cap.
 */
async function resolveSubscriptionState(
  getDoc: (reference: FirebaseFirestore.DocumentReference) => Promise<QuotaDocSnapshot>,
  uid: string,
  now: number
): Promise<SubscriptionState> {
  const subSnap = await getDoc(db.collection(SUBSCRIPTIONS_COLLECTION).doc(uid));

  if (subSnap.exists) {
    const subState = normalizeState(subSnap.data() || {});
    // The protected users/{uid}.isDeveloper flag outranks a subscription doc
    // that predates a manual grant (the grant script writes both, but a flag
    // set outside the script must still win over a stale free sub doc).
    if (!subState.isDeveloper && !subState.unlimited) {
      try {
        const userSnap = await getDoc(db.collection('users').doc(uid));
        const userData = userSnap.data() || {};
        if (userData.isDeveloper === true || userData.developer === true) {
          return developerSubscriptionState();
        }
      } catch (error) {
        console.error(`[quota] Developer flag lookup failed uid=${uid.slice(0, 8)}:`, error);
      }
    }
    return subState;
  }

  const userSnap = await getDoc(db.collection('users').doc(uid));
  if (userSnap.exists) {
    const userData = userSnap.data() || {};
    // Developer flag on the profile is server-only (rules protect it). This
    // covers a freshly granted account before its ID token is refreshed.
    if (userData.isDeveloper === true || userData.developer === true) {
      return developerSubscriptionState();
    }
    const legacy = normalizeState(userData);
    const orderId =
      typeof userData.razorpayOrderId === 'string' ? userData.razorpayOrderId : null;
    if (
      legacy.plan !== DEFAULT_PLAN &&
      legacy.expiresAt !== null &&
      legacy.expiresAt > now &&
      orderId !== null
    ) {
      const paymentSnap = await getDoc(db.collection(PAYMENTS_COLLECTION).doc(orderId));
      if (paymentSnap.exists && paymentSnap.data()?.status === 'paid') {
        return { ...legacy, lastResetAt: now };
      }
    }
  }

  return {
    plan: DEFAULT_PLAN,
    messageCount: 0,
    lastResetAt: now,
    expiresAt: null,
    isTrial: false,
    trialEndsAt: null,
    trialUsed: false,
    isDeveloper: false,
    unlimited: false,
  };
}

/** Snapshot getter over plain (non-transactional) Firestore reads. */
function dbGetDoc(reference: FirebaseFirestore.DocumentReference): Promise<QuotaDocSnapshot> {
  return reference.get();
}

/**
 * Reads subscription state from server-only `subscriptions/{uid}`. On a
 * missing doc, falls back to legacy `users/{uid}` only when backed by a
 * verified paid payment record (users docs may be client-writable).
 */
function loadSubscriptionState(uid: string): Promise<SubscriptionState> {
  return resolveSubscriptionState(dbGetDoc, uid, Date.now());
}

/** Applies subscription expiry: an expired paid plan is downgraded to free. */
function applyExpiry(state: SubscriptionState, now: number): SubscriptionState {
  if (state.isDeveloper || state.unlimited) return state;
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
export async function getPlanState(
  uid: string,
  developer = false
): Promise<UserMessageState> {
  if (developer) return developerMessageState();

  const now = Date.now();
  const state = applyExpiry(await loadSubscriptionState(uid), now);
  if (state.isDeveloper || state.unlimited) return developerMessageState();
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
    expiresAt: state.expiresAt,
    isTrial: state.isTrial,
    trialEndsAt: state.trialEndsAt,
    trialUsed: state.trialUsed,
    isDeveloper: state.isDeveloper,
    unlimited: state.unlimited,
  };
}

/**
 * Consumes one message of quota. Throws LimitReachedError at the limit. Call
 * only after a successful AI reply so failures don't burn allowance.
 *
 * Always transactional: plan state and count are re-read INSIDE the
 * transaction and the write happens only when `count < plan limit`. Firestore
 * serializes transactions on the document, so concurrent consumes commit one
 * after another and the plan cap is a true hard cap — a burst of any size can
 * never push messageCount past the limit. The pre-AI gate in /chat is only a
 * fast-fail hint, never the enforcement point.
 */
export async function consumeMessage(
  uid: string,
  developer = false
): Promise<{ success: true }> {
  if (developer) return { success: true };

  const now = Date.now();
  const subRef = db.collection(SUBSCRIPTIONS_COLLECTION).doc(uid);

  await db.runTransaction(async (tx) => {
    const rawState = await resolveSubscriptionState((reference) => tx.get(reference), uid, now);
    const state = applyExpiry(rawState, now);
    // Premium state arrived mid-flight (grant or developer flag racing this
    // consume): never write a counter for it.
    if (state.isDeveloper || state.unlimited) return;

    // getPlanState's window-refresh would mask whether the stored window
    // actually rolled over, so decision state is derived from the raw doc.
    const config = PLAN_CONFIG[state.plan];
    const downgraded = state.plan !== rawState.plan || state.expiresAt !== rawState.expiresAt;

    let count = state.messageCount;
    let resetAt = state.lastResetAt;
    const windowExpired = now - resetAt >= config.refreshMs;
    if (windowExpired) {
      count = 0;
      resetAt = now;
    }

    // Hard cap on the fresh in-transaction read: this comparison can never
    // be bypassed by another request reading a stale count, because the
    // write only commits with this read's snapshot.
    if (count >= config.limit) {
      throw new LimitReachedError(resetAt + config.refreshMs, state.plan);
    }

    if (windowExpired || downgraded) {
      // Persist the reset with an explicit count of 1: increment(1) would
      // keep growing from the stale stored value instead of resetting.
      tx.set(
        subRef,
        {
          plan: state.plan,
          expiresAt: state.expiresAt,
          messageCount: 1,
          lastResetAt: resetAt,
          updatedAt: now,
          // `state` is post-applyExpiry: an expired trial is already cleared
          // here (isTrial false / trialEndsAt null) while trialUsed persists.
          isTrial: state.isTrial,
          trialEndsAt: state.trialEndsAt,
        },
        { merge: true }
      );
    } else {
      const fields: Record<string, unknown> = {
        plan: state.plan,
        messageCount: count + 1,
        updatedAt: now,
      };
      if (state.plan === DEFAULT_PLAN) {
        fields.expiresAt = null;
        fields.isTrial = false;
        fields.trialEndsAt = null;
      }
      tx.set(subRef, fields, { merge: true });
    }
  });

  return { success: true };
}

/**
 * Read path for GET /api/user/plan: current state, persisting a rolled-over
 * window or expiry downgrade best-effort so other endpoints see it too.
 */
export async function checkAndResetOnly(
  uid: string,
  developer = false
): Promise<UserMessageState> {
  if (developer) return developerMessageState();

  const now = Date.now();
  const raw = await loadSubscriptionState(uid);
  const state = applyExpiry(raw, now);
  if (state.isDeveloper || state.unlimited) return developerMessageState();
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
    expiresAt: state.expiresAt,
    isTrial: state.isTrial,
    trialEndsAt: state.trialEndsAt,
    trialUsed: state.trialUsed,
    isDeveloper: state.isDeveloper,
    unlimited: state.unlimited,
  };
}
