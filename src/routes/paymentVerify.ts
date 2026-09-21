import { Response } from 'express';
import crypto from 'crypto';
import { db } from '../config/firebaseAdmin';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { consumeRateLimit, RateLimitExceededError } from '../services/rateLimitService';
import { razorpay } from '../services/razorpayClient';
import {
  grantPlanAndMarkPaid,
  computeExpiresAtMs,
  PAYMENTS_COLLECTION,
} from '../services/subscriptionService';
import { tierToPlan } from '../constants';
import { timingSafeEqualHex } from '../utils/crypto';

const VERIFY_RATE_LIMIT_MAX = 20;
const VERIFY_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

/** The subset of a Razorpay payment entity that we validate against. */
interface PaymentCheck {
  status: string;
  order_id: string;
  amount: number | string;
}

export async function paymentVerifyHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
  // uid comes from the verified Firebase token — never from the request body.
  const uid = req.user!.uid;

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = (req.body || {}) as {
    razorpay_order_id?: unknown;
    razorpay_payment_id?: unknown;
    razorpay_signature?: unknown;
  };

  if (
    typeof razorpay_order_id !== 'string' ||
    typeof razorpay_payment_id !== 'string' ||
    typeof razorpay_signature !== 'string'
  ) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  if (!process.env.RAZORPAY_KEY_SECRET) {
    console.error('Missing RAZORPAY_KEY_SECRET environment variable');
    res.status(500).json({ error: 'Server misconfigured' });
    return;
  }

  try {
    await consumeRateLimit(
      `payment-verify:${uid}`,
      VERIFY_RATE_LIMIT_MAX,
      VERIFY_RATE_LIMIT_WINDOW_MS
    );
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      res.status(429).json({ error: 'Too many requests, try again later' });
      return;
    }
    console.error('Payment verify rate limit check failed:', error);
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  // Payment signature: HMAC-SHA256(key_secret, `${order_id}|${payment_id}`).
  // Read lazily so tests can stub the env var after import.
  const keySecret = process.env.RAZORPAY_KEY_SECRET as string;
  const expectedHex = crypto
    .createHmac('sha256', keySecret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (!timingSafeEqualHex(expectedHex, razorpay_signature)) {
    res.status(400).json({ error: 'Invalid signature' });
    return;
  }

  try {
    const paymentSnap = await db.collection(PAYMENTS_COLLECTION).doc(razorpay_order_id).get();

    if (!paymentSnap.exists) {
      res.status(404).json({ error: 'Payment record not found' });
      return;
    }
    const record = paymentSnap.data() || {};

    // The order must belong to the authenticated user.
    if (record.uid !== uid) {
      res.status(403).json({ error: 'UID mismatch' });
      return;
    }

    // Idempotency: a replayed verify (e.g. client retry after a network drop)
    // succeeds with the already-granted result instead of erroring, so the
    // client never shows a failure for a payment that actually went through.
    // Expiry is recomputed from paidAt (when the plan actually started), NOT
    // from now — a retry weeks later must still report the same date.
    if (record.status === 'paid') {
      const plan = tierToPlan(record.tier);
      if (!plan) {
        console.error(`Payment ${razorpay_order_id} is paid but has unknown tier:`, record.tier);
        res.status(500).json({ error: 'Internal server error' });
        return;
      }
      const paidAtMs = record.paidAt ? new Date(record.paidAt as string | number | Date).getTime() : null;
      const expiresAtMs =
        paidAtMs !== null && !Number.isNaN(paidAtMs)
          ? computeExpiresAtMs(record.tier, paidAtMs)
          : computeExpiresAtMs(record.tier);
      res.json({
        success: true,
        plan,
        expiresAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
        alreadyVerified: true,
      });
      return;
    }

    // Authoritative cross-check with Razorpay: the payment must be real,
    // captured, for this exact order, and for the exact server-set amount.
    let payment: PaymentCheck | undefined;
    try {
      payment = await razorpay.payments.fetch(razorpay_payment_id);
    } catch (error) {
      console.error('Razorpay payment fetch failed:', error);
      res.status(502).json({ error: 'Payment verification unavailable' });
      return;
    }
    if (!payment) {
      res.status(502).json({ error: 'Payment verification unavailable' });
      return;
    }

    if (payment.status !== 'captured') {
      res.status(400).json({ error: 'Payment not captured' });
      return;
    }
    if (payment.order_id !== razorpay_order_id) {
      res.status(400).json({ error: 'Order mismatch' });
      return;
    }
    if (Number(payment.amount) !== Number(record.amount)) {
      res.status(400).json({ error: 'Amount mismatch' });
      return;
    }

    const plan = await grantPlanAndMarkPaid(uid, record.tier, razorpay_order_id, razorpay_payment_id);
    const expiresAtMs = computeExpiresAtMs(record.tier);

    res.json({
      success: true,
      plan,
      expiresAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
    });
  } catch (error) {
    console.error('Payment verify error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
