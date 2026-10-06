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
 * Server-only collections. The frontend never writes here, so plan state
 * can't be forged by users.
 */
export const SUBSCRIPTIONS_COLLECTION = 'subscriptions';
export const PAYMENTS_COLLECTION = 'payments';

/** Subscription status on subscriptions/{uid}. Missing/unknown reads as active. */
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
 * Grants a paid plan and marks the payment paid, idempotently. Call only
 * after authoritative verification (signature + Razorpay fetch + amount).
 * Transactional on payments/{orderId} so concurrent verify/webhook races on
 * the same order grant exactly once.
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

    // Idempotency: a concurrent path already granted this order. Ownership
    // is still enforced on replay.
    if (record.status === 'paid') {
      if (record.uid !== undefined && record.uid !== uid) {
        throw new Error(`Order ${orderId} belongs to a different uid; refusing to grant`);
      }
      return tierToPlan(String(record.tier ?? tier)) ?? plan;
    }

    // Defensive re-check: the doc must still describe the same order.
    if (record.uid !== undefined && record.uid !== uid) {
      throw new Error(`Order ${orderId} belongs to a different uid; refusing to grant`);
    }

    // Use the record's own amount/tier so the grant matches what the order
    // was created with, never a client-supplied value.
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
      // A re-grant after cancel must clear the cancelled marker.
      status: 'active',
      expiresAt,
      messageCount: 0,
      lastResetAt: now,
      updatedAt: now,
      lastOrderId: orderId,
      // A purchase replaces trial state; `trialUsed` is preserved by the
      // merge so a second trial can never start after subscribing.
      isTrial: false,
      trialEndsAt: null,
    }, { merge: true });

    tx.set(payRef, paidFields, { merge: true });

    return effectivePlan;
  });
  return grantedPlan;
}

/**
 * Cancels the subscription: plan drops to free, perks end now. Idempotent.
 * One-time Razorpay orders have no server-side subscription entity, so this
 * only flips local state (a Razorpay subscription id, if ever present, is
 * cancelled best-effort by the caller first).
 */
export async function cancelUserSubscription(uid: string): Promise<boolean> {
  const now = Date.now();

  const subRef = db.collection(SUBSCRIPTIONS_COLLECTION).doc(uid);
  const snap = await subRef.get();

  if (!snap.exists) return false;

  const data = snap.data() || {};
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
      // Cancelling a trial ends it; `trialUsed` stays true (merge preserves it).
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
 * Grants the 5-day Ultimate trial, transactionally. The transaction makes
 * the one-trial-per-account guard atomic under concurrent calls.
 * Account-age eligibility is checked by the route (needs the Auth record).
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
        // `expiresAt` drives the standard expiry downgrade, so the trial ends
        // through the same path as a paid term.
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
