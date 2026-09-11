import { db } from '../config/firebaseAdmin';
import { tierToPlan, PlanType } from '../constants';

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
 * Grants a paid plan and marks the payment as paid.
 * ONLY call after the payment has been authoritatively verified
 * (signature + Razorpay payment fetch + amount match).
 */
export async function grantPlanAndMarkPaid(
  uid: string,
  tier: string,
  orderId: string,
  paymentId?: string
): Promise<PlanType> {
  const plan = tierToPlan(tier);
  if (!plan) throw new Error('Invalid tier');

  const expiresAt = computeExpiresAtMs(tier);
  const now = Date.now();

  // Both writes are atomic so a partial failure can never leave a granted
  // plan with an unmarked (still retryable) payment.
  await db.runTransaction(async (transaction) => {
    transaction.set(
      db.collection(SUBSCRIPTIONS_COLLECTION).doc(uid),
      {
        plan,
        expiresAt,
        messageCount: 0,
        lastResetAt: now,
        updatedAt: now,
        lastOrderId: orderId,
      },
      { merge: true }
    );

    transaction.set(
      db.collection(PAYMENTS_COLLECTION).doc(orderId),
      {
        status: 'paid',
        razorpay_payment_id: paymentId ?? null,
        plan,
        paidAt: new Date(),
      },
      { merge: true }
    );
  });

  return plan;
}
