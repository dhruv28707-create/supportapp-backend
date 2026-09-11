import { Response } from 'express';
import { db } from '../config/firebaseAdmin';
import { TIER_PRICES, Tier } from '../constants';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { consumeRateLimit, RateLimitExceededError } from '../services/rateLimitService';
import { razorpay } from '../services/razorpayClient';
import { PAYMENTS_COLLECTION } from '../services/subscriptionService';

const ORDER_RATE_LIMIT_MAX = 10;
const ORDER_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

export async function paymentOrderHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
  // uid comes from the verified Firebase token — never from the request body.
  const uid = req.user!.uid;

  const { tier } = (req.body || {}) as { tier?: unknown };

  // Tier must be a known key; price is resolved server-side, never client-side.
  if (typeof tier !== 'string' || !(TIER_PRICES as Record<string, number>)[tier]) {
    res.status(400).json({ error: 'Invalid tier' });
    return;
  }

  const startedAt = Date.now();

  try {
    const amount = TIER_PRICES[tier as Tier];
    const order = await razorpay.orders.create({
      amount,
      currency: 'INR', // fixed — no client-supplied currency
      receipt: `r_${uid.slice(0, 8)}_${Date.now()}`,
    });
    console.log(
      `[payment-order] Razorpay order created in ${Date.now() - startedAt}ms (uid=${uid.slice(0, 8)})`
    );

    // Count only successfully created orders — failed or timed-out attempts
    // must not burn the user's budget and lock them out of payment.
    await consumeRateLimit(
      `payment-order:${uid}`,
      ORDER_RATE_LIMIT_MAX,
      ORDER_RATE_LIMIT_WINDOW_MS
    );

    await db.collection(PAYMENTS_COLLECTION).doc(order.id).set({
      uid,
      tier,
      amount: order.amount,
      currency: 'INR',
      status: 'pending',
      createdAt: new Date(),
    });

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: 'INR',
      // Public checkout key (key_id — never the secret). Returning it lets
      // the app open checkout with the exact key the order was created with,
      // so a stale/hardcoded/mismatched key can never break the checkout.
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      res.status(429).json({ error: 'Too many requests, try again later' });
      return;
    }
    // Log every field we can get — the SDK throws plain objects on API
    // errors and confusing TypeErrors on timeouts, so a single serialization
    // strategy hides the real cause. This makes Vercel logs actionable.
    const err = error as {
      message?: string;
      code?: string;
      statusCode?: number;
      error?: { code?: string; description?: string };
    };
    console.error('Payment order error:', {
      message: err.message ?? null,
      code: err.code ?? null,
      statusCode: err.statusCode ?? null,
      rzpCode: err.error?.code ?? null,
      rzpDescription: err.error?.description ?? null,
      raw: String(error),
      elapsedMs: Date.now() - startedAt,
    });
    res.status(500).json({ error: 'Failed to create order' });
  }
}
