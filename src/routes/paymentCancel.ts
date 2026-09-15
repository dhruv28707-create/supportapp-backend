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
 * POST /api/payment-cancel
 *
 * Cancels the authenticated user's active subscription so the Delete Account
 * flow is no longer blocked by an active paid term. No request body.
 *
 * Semantics (matches the frontend contract — the caller treats every 2xx as
 * success and never blocks deletion on this endpoint):
 *  - No active subscription (absent, already cancelled, free, or expired
 *    plan): 200 { ok: true, message: 'No active subscription found' }.
 *    This is deliberately NOT an error, so replays and fresh users both
 *    succeed — the endpoint is idempotent, like payment-verify.
 *  - Active subscription: cancelled IMMEDIATELY (plan -> free, perks end
 *    now) and 200 { ok: true, message: 'Subscription cancelled' }.
 *  - Razorpay-side cancellation is best-effort and never blocks the local
 *    state flip: this backend's payments are one-time Razorpay orders, so
 *    there is normally no Razorpay subscription entity at all. Only if a
 *    subscription id is ever present on the record (future recurring plans)
 *    is the Razorpay API called; its failure is logged and swallowed.
 *
 * Keys live in the existing RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET env vars —
 * they are server-side only and never appear in any response.
 */
export async function paymentCancelHandler(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  // uid is always taken from the verified Firebase token — never from the body/query.
  const uid = req.user!.uid;

  // --- Abuse rate limit (fail-open, consistent with the other payment limiters) ---
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

  // No active subscription: absent doc, already cancelled, free plan, or a
  // paid doc already downgraded (expiry). Success per the frontend contract.
  if (!snap.exists || status !== 'active' || !hasPaidPlan) {
    res.json({ ok: true, message: 'No active subscription found' });
    return;
  }

  // --- Best-effort Razorpay-side cancellation (future-proofing only) ---
  // cancelUserSubscription flips the doc regardless of what happens here, so
  // a Razorpay outage/never blocks deletion. With one-time orders there is
  // no subscription entity and this branch never runs.
  const razorpaySubscriptionId =
    typeof data.razorpaySubscriptionId === 'string' ? data.razorpaySubscriptionId : null;
  if (razorpaySubscriptionId) {
    try {
      // Immediate cancellation (default) to match the immediate local
      // downgrade. Errors like "already cancelled" / "not found" land in the
      // catch and are deliberately non-fatal.
      await razorpay.subscriptions.cancel(razorpaySubscriptionId);
    } catch (error) {
      console.error(
        `[payment-cancel] Razorpay subscription cancel failed (continuing) sub=${razorpaySubscriptionId}:`,
        error
      );
    }
  }

  // --- Local cancellation: immediate downgrade, atomic and idempotent ---
  try {
    const cancelled = await cancelUserSubscription(uid);
    if (!cancelled) {
      // State changed between the read above and the transaction (e.g. a
      // concurrent cancel or expiry). Still a success for the caller.
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
