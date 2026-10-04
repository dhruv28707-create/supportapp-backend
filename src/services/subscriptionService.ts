import { db } from '../config/firebaseAdmin';
import { DocumentData } from 'firebase-admin/firestore';
import {
  tierToPlan,
  PlanType,
  DEFAULT_PLAN,
  TRIAL_PLAN,
  ULTIMATE_TRIAL_MS,
} from '../constants';

/** Fields written by grantPlanAndMarkPaid into the payments doc (merge). */
interface PaidPaymentFields {
  status: 'paid';
  razorpay_payment_id: string | null;
  plan: PlanType;
  paidAt: Date;
  uid: string;
  tier: string;
  amount: number | null;
  grantedAt: number;
}

/**
 * Server-only collections. The frontend never writes to these, so even if
 * client Firestore rules are permissive on other collections, plan state
 * cannot be forged by users.
 */
export const SUBSCRIPTIONS_COLLECTION = 'subscriptions';
export const PAYMENTS_COLLECTION = 'payments';

/** Subscription status lifecycle on subscriptions/{uid}:
 *  - active:    granted by payment (no explicit field = active)
 *  - cancelled: user cancelled (POST /api/payment-cancel); perks end now
 *
 *  (Expiry to 'free' is handled separately by applyExpiry in messageService.)
 */
export type SubscriptionStatus = 'active' | 'cancelled';

/** Normalizes a stored status value, treating missing/unknown as 'active'. */
export function normalizeStatus(value: unknown): SubscriptionStatus {
  return value === 'cancelled' ? 'cancelled' : 'active';
}

/** Expiry timestamp (ms) for a tier — 1 year for yearly, 1 month otherwise. */
export function computeExpiresAtMs(
  tier: string,
  fromMs: number = Date.now()
): number | null {
  if (!tierToPlan(tier)) return null;

  // Month-end clamp + UTC math: Jan 31 +1mo -> Feb 28 (not Mar 3), and no DST
  // shift. Uses UTC getters/setters throughout.
  const from = new Date(fromMs);
  const day = from.getUTCDate();
  const expires = new Date(fromMs);
  if (tier.endsWith('_yearly')) {
    expires.setUTCFullYear(expires.getUTCFullYear() + 1);
  } else {
    expires.setUTCMonth(expires.getUTCMonth() + 1);
  }
  // Overflowed into the next month (e.g. Feb has no 31st): clamp to the last
  // day of the intended month.
  if (expires.getUTCDate() < day) {
    expires.setUTCDate(0);
  }
  return expires.getTime();
}

/**
 * Grants a paid plan and marks the payment as paid, idempotently.
 *
 * ONLY call after the payment has been authoritatively verified
 * (signature + Razorpay payment fetch + amount match).
 *
 * Transactional on payments/{orderId}: concurrent double-verify/webhook races
 * on the SAME order serialize here, so the second caller sees status 'paid'
 * and returns without resetting messageCount or extending expiry. Grants for
 * DIFFERENT orders touch different docs and never contend. Payment grants are
 * low-QPS, so the transaction cost is negligible (unlike the hot chat quota
 * path, which stays transaction-free by design).
 */
export async function grantPlanAndMarkPaid(
  uid: string,
  tier: string,
  orderId: string,
  paymentId?: string
): Promise<PlanType> {
  const plan = tierToPlan(tier);
  if (!plan) throw new Error('Invalid tier');

  const now = Date.now();
  const payRef = db.collection(PAYMENTS_COLLECTION).doc(orderId);
  const subRef = db.collection(SUBSCRIPTIONS_COLLECTION).doc(uid);

  const grantedPlan = await db.runTransaction(async (tx) => {
    const paySnap = await tx.get(payRef);
    const record: DocumentData = paySnap.exists ? paySnap.data() || {} : {};

    // Idempotency — a concurrent path already granted this order. Enforce
    // ownership even on replay: a different uid claiming a paid order gets a
    // UID-mismatch error instead of a silent plan leak.
    if (record.status === 'paid') {
      if (record.uid !== undefined && record.uid !== uid) {
        throw new Error(`Order ${orderId} belongs to a different uid; refusing to grant`);
      }
      return tierToPlan(String(record.tier ?? tier)) ?? plan;
    }

    // Defensive re-check: the doc must still describe the same order we verified.
    if (record.uid !== undefined && record.uid !== uid) {
      throw new Error(`Order ${orderId} belongs to a different uid; refusing to grant`);
    }

    // Use the record's own amount when present so the grant matches what the
    // order was created with (never a client-supplied value).
    const recordTier = typeof record.tier === 'string' ? record.tier : tier;
    const effectivePlan = tierToPlan(recordTier) ?? plan;
    const expiresAt = computeExpiresAtMs(recordTier);

    const paidFields: PaidPaymentFields = {
      status: 'paid',
      razorpay_payment_id: paymentId ?? null,
      plan: effectivePlan,
      paidAt: new Date(now),
      uid,
      tier: recordTier,
      amount: typeof record.amount === 'number' ? record.amount : null,
      grantedAt: now,
    };

    tx.set(subRef, {
      plan: effectivePlan,
      // Re-grant after a cancel must clear the cancelled marker, or the new
      // paid plan would still read as cancelled downstream.
      status: 'active',
      expiresAt,
      messageCount: 0,
      lastResetAt: now,
      updatedAt: now,
      lastOrderId: orderId,
      // A purchase replaces any free-trial state; `trialUsed` is deliberately
      // NOT touched here (merge preserves it) so a trialing user can never
      // start a second trial after they subscribe.
      isTrial: false,
      trialEndsAt: null,
    }, { merge: true });

    tx.set(payRef, paidFields, { merge: true });

    return effectivePlan;
  });
  return grantedPlan;
}

/**
 * Cancels the user's subscription: plan drops to free and perks end now
 * (immediate mode, per the Delete Account flow this endpoint serves).
 *
 * Idempotent: cancelling an already-cancelled/absent subscription changes
 * nothing. Returns whether an active subscription was actually cancelled.
 *
 * Note: this backend's payments are one-time Razorpay orders, so there is
 * normally no Razorpay subscription entity to cancel — this only flips the
 * local state. If a Razorpay subscription id is ever present on the record
 * (future recurring plans), the caller cancels it with the Razorpay API
 * BEFORE calling this; its failure must not block the local cancellation.
 */
export async function cancelUserSubscription(uid: string): Promise<boolean> {
  const now = Date.now();

  const subRef = db.collection(SUBSCRIPTIONS_COLLECTION).doc(uid);
  const snap = await subRef.get();

  if (!snap.exists) return false;

  const data = snap.data() || {};
  // Only a doc that actually carries a paid plan is cancellable; a free
  // plan (or an expired one already downgraded to free) has nothing active.
  if (normalizeStatus(data.status) !== 'active' || data.plan === DEFAULT_PLAN) {
    return false;
  }

  await subRef.set(
    {
      plan: DEFAULT_PLAN,
      status: 'cancelled',
      expiresAt: null,
      messageCount: typeof data.messageCount === 'number' ? data.messageCount : 0,
      lastResetAt: typeof data.lastResetAt === 'number' ? data.lastResetAt : now,
      lastOrderId: typeof data.lastOrderId === 'string' ? data.lastOrderId : null,
      cancelledAt: new Date(now),
      updatedAt: now,
      // Cancelling a free trial ends it cleanly; `trialUsed` stays true so it
      // cannot be restarted (merge preserves the field).
      isTrial: false,
      trialEndsAt: null,
    },
    { merge: true }
  );

  return true;
}

/** Why a trial start was refused. */
export type TrialRefusalCode = 'trial_already_used' | 'already_subscribed';

export class TrialNotAllowedError extends Error {
  constructor(public readonly code: TrialRefusalCode) {
    super(
      code === 'trial_already_used'
        ? 'Free trial already used'
        : 'Account already has an active plan'
    );
    this.name = 'TrialNotAllowedError';
  }
}

export interface TrialGrant {
  plan: PlanType;
  startedAt: number;
  expiresAt: number;
}

/**
 * Grants the 5-day Ultimate free trial, transactionally and idempotently.
 *
 * The transaction on subscriptions/{uid} makes the one-trial-per-account
 * guard atomic: two concurrent calls both read the doc, but the second sees
 * `trialUsed: true` (or the trial plan) and is refused — never two grants.
 *
 * Account-age eligibility (new users only) is enforced by the ROUTE before
 * calling this, since it needs the Firebase Auth user record.
 *
 * Callers must NOT depend on a Razorpay order: no payment is involved.
 */
export async function startUltimateTrial(uid: string): Promise<TrialGrant> {
  const now = Date.now();
  const expiresAt = now + ULTIMATE_TRIAL_MS;
  const subRef = db.collection(SUBSCRIPTIONS_COLLECTION).doc(uid);

  const granted = await db.runTransaction(async (tx) => {
    const snap = await tx.get(subRef);
    const data = snap.exists ? snap.data() || {} : {};

    if (data.trialUsed === true) {
      throw new TrialNotAllowedError('trial_already_used');
    }

    const rawPlan = typeof data.plan === 'string' ? data.plan : '';
    const currentPlan: PlanType =
      rawPlan === 'pro' ? 'pro' : rawPlan === 'ultimate' ? 'ultimate' : DEFAULT_PLAN;
    if (currentPlan !== DEFAULT_PLAN) {
      throw new TrialNotAllowedError('already_subscribed');
    }

    tx.set(
      subRef,
      {
        plan: TRIAL_PLAN,
        status: 'active',
        isTrial: true,
        trialStartedAt: now,
        trialEndsAt: expiresAt,
        // Permanent marker: merge writes elsewhere never clear it.
        trialUsed: true,
        // expiresAt drives the existing applyExpiry downgrade, so the trial
        // ends through the same code path as a paid term.
        expiresAt,
        messageCount: 0,
        lastResetAt: now,
        updatedAt: now,
      },
      { merge: true }
    );

    return { plan: TRIAL_PLAN, startedAt: now, expiresAt };
  });

  // Plan reads are uncached, so the new trial is visible immediately everywhere.
  return granted;
}
