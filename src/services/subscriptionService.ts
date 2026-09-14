import { db } from '../config/firebaseAdmin';
import { DocumentData } from 'firebase-admin/firestore';
import { tierToPlan, PlanType } from '../constants';

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
