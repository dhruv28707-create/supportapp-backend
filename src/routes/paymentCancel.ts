import { Response } from 'express';
import { db } from '../config/firebaseAdmin';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { consumeRateLimit, RateLimitExceededError } from '../services/rateLimitService';
import {
  SUBSCRIPTIONS_COLLECTION,
  normalizeStatus,
  cancelUserSubscription,
} from '../services/subscriptionService';
import { DEFAULT_PLAN } from '../constants';
import { razorpay } from '../services/razorpayClient';

const RATE_LIMIT_MAX = 6;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

/**
 * POST /api/payment-cancel — cancels the active subscription (immediate
 * downgrade to free) so Delete Account is unblocked. Idempotent: no active
 * subscription is still a 200. Razorpay-side cancellation is best-effort
 * (one-time orders normally have no subscription entity).
 */
export async function paymentCancelHandler(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  // uid comes from the verified token, never the body.
  const uid = req.user!.uid;

  try {
    await consumeRateLimit(`payment-cancel:${uid}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      res.status(429).json({ error: 'Too many requests, try again later' });
      return;
    }
    console.error(`[payment-cancel] Rate limit check failed (allowing request) uid=${uid.slice(0, 8)}:`, error);
  }

  // --- Load the user's subscription record (server-only collection) ---
  let snap;
  try {
    snap = await db.collection(SUBSCRIPTIONS_COLLECTION).doc(uid).get();
  } catch (error) {
    console.error(`[payment-cancel] Subscription lookup failed for uid=${uid.slice(0, 8)}:`, error);
    // Unlike Razorpay failures, a broken DB means we cannot honour the
    // cancellation at all — report it instead of lying with ok:true (the
    // subsequent account deletion would then confusingly 409).
    res.status(500).json({ error: 'Failed to cancel subscription' });
    return;
  }

  const data = snap.data() || {};
  const status = normalizeStatus(data.status);
  const hasPaidPlan = typeof data.plan === 'string' && data.plan !== DEFAULT_PLAN;

  // No active subscription: absent doc, already cancelled, or free plan.
  if (!snap.exists || status !== 'active' || !hasPaidPlan) {
    res.json({ ok: true, message: 'No active subscription found' });
    return;
  }

  // Best-effort Razorpay-side cancellation (only runs if a subscription id
  // is ever present; one-time orders have none). Never blocks local state.
  const razorpaySubscriptionId =
    typeof data.razorpaySubscriptionId === 'string' ? data.razorpaySubscriptionId : null;
  if (razorpaySubscriptionId) {
    try {
      await razorpay.subscriptions.cancel(razorpaySubscriptionId);
    } catch (error) {
      console.error(
        `[payment-cancel] Razorpay subscription cancel failed (continuing) sub=${razorpaySubscriptionId}:`,
        error
      );
    }
  }

  // Local cancellation: immediate downgrade, idempotent.
  try {
    const cancelled = await cancelUserSubscription(uid);
    if (!cancelled) {
      // State changed between the read and the write (concurrent cancel).
      console.log(`[payment-cancel] No active subscription at transaction time uid=${uid.slice(0, 8)}`);
      res.json({ ok: true, message: 'No active subscription found' });
      return;
    }

    console.log(`[payment-cancel] Subscription cancelled uid=${uid.slice(0, 8)}`);
    res.json({ ok: true, message: 'Subscription cancelled' });
  } catch (error) {
    console.error(`[payment-cancel] Failed to cancel subscription uid=${uid.slice(0, 8)}:`, error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
}
