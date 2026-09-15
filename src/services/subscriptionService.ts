import { db } from '../config/firebaseAdmin';
import { DocumentData } from 'firebase-admin/firestore';
import { tierToPlan, PlanType, DEFAULT_PLAN } from '../constants';

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

  const expires = new Date(fromMs);
  if (tier.endsWith('_yearly')) {
    expires.setFullYear(expires.getFullYear() + 1);
  } else {
    expires.setMonth(expires.getMonth() + 1);
  }
  return expires.getTime();
}

/**
 * Grants a paid plan and marks the payment as paid, atomically and
 * idempotently.
 *
 * ONLY call after the payment has been authoritatively verified
 * (signature + Razorpay payment fetch + amount match).
 *
 * Idempotency: the payments/{orderId} status flip happens INSIDE the same
 * transaction that reads it, so a webhook and a client verify racing on the
 * same order grant exactly once — the second caller sees status 'paid' and
 * gets the original paidAt/expiry instead of resetting messageCount or
 * extending the expiry. The payment doc's uid/tier/amount snapshot is also
 * copied onto the grant to defend against the order doc changing between
 * verification and grant.
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

  const grantedPlan = await db.runTransaction(async (transaction) => {
    const payRef = db.collection(PAYMENTS_COLLECTION).doc(orderId);
    const paySnap = await transaction.get(payRef);
    const record: DocumentData = paySnap.exists ? paySnap.data() || {} : {};

    // Idempotency — a concurrent path already granted this order. Report the
    // effective plan without re-granting (no messageCount reset, no new
    // expiry based on now).
    if (record.status === 'paid') {
      return tierToPlan(String(record.tier ?? tier)) ?? plan;
    }

    // Defensive re-check inside the transaction: the doc must still describe
    // the same order we verified.
    if (
      record.uid !== undefined &&
      record.uid !== uid &&
      record.status !== 'paid'
    ) {
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

    transaction.set(
      db.collection(SUBSCRIPTIONS_COLLECTION).doc(uid),
      {
        plan: effectivePlan,
        // Re-grant after a cancel must clear the cancelled marker, or the new
        // paid plan would still read as cancelled downstream.
        status: 'active',
        expiresAt,
        messageCount: 0,
        lastResetAt: now,
        updatedAt: now,
        lastOrderId: orderId,
      },
      { merge: true }
    );

    transaction.set(payRef, paidFields, { merge: true });

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

  return await db.runTransaction(async (transaction) => {
    const subRef = db.collection(SUBSCRIPTIONS_COLLECTION).doc(uid);
    const snap = await transaction.get(subRef);

    if (!snap.exists) return false;

    const data = snap.data() || {};
    // Only a doc that actually carries a paid plan is cancellable; a free
    // plan (or an expired one already downgraded to free) has nothing active.
    if (normalizeStatus(data.status) !== 'active' || data.plan === DEFAULT_PLAN) {
      return false;
    }

    transaction.set(
      subRef,
      {
        plan: DEFAULT_PLAN,
        status: 'cancelled',
        expiresAt: null,
        messageCount: typeof data.messageCount === 'number' ? data.messageCount : 0,
        lastResetAt: typeof data.lastResetAt === 'number' ? data.lastResetAt : now,
        lastOrderId: typeof data.lastOrderId === 'string' ? data.lastOrderId : null,
        cancelledAt: new Date(now),
        updatedAt: now,
      },
      { merge: true }
    );

    return true;
  });
}
