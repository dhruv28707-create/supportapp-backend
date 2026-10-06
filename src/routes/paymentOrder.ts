import { Response } from 'express';
import { db } from '../config/firebaseAdmin';
import { TIER_PRICES, Tier } from '../constants';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { consumeRateLimit, RateLimitExceededError } from '../services/rateLimitService';
import { enforceOrderIpThrottle } from '../services/chatClientThrottle';
import { extractClientIp } from '../utils/request';
import { razorpay } from '../services/razorpayClient';
import { PAYMENTS_COLLECTION } from '../services/subscriptionService';

const ORDER_RATE_LIMIT_MAX = 10;
const ORDER_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

// Unpaid orders pile up if a client mints orders without checking out.
// Cap them per user so one account can't flood the collection (or Razorpay)
// with orphan orders.
const MAX_PENDING_ORDERS = 5;

export async function paymentOrderHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
  // uid comes from the verified Firebase token — never from the request body.
  const uid = req.user!.uid;

  const { tier } = (req.body || {}) as { tier?: unknown };

  // Tier allowlisted; price resolved server-side, never from the client.
  if (typeof tier !== 'string' || !(TIER_PRICES as Record<string, number>)[tier]) {
    res.status(400).json({ error: 'Invalid tier' });
    return;
  }

  const startedAt = Date.now();

  // Throttle first, before touching Razorpay — otherwise a script can mint
  // unlimited orders plus orphan pending docs.
  try {
    await consumeRateLimit(
      `payment-order:${uid}`,
      ORDER_RATE_LIMIT_MAX,
      ORDER_RATE_LIMIT_WINDOW_MS
    );
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      res.status(429).json({ error: 'Too many requests, try again later' });
      return;
    }
    console.error('[payment-order] Rate limit check failed (allowing request):', error);
  }

  // Per-IP cap: per-uid limits alone can't stop order minting across fresh
  // accounts from one address.
  const ip = extractClientIp(req);
  if (ip) {
    try {
      await enforceOrderIpThrottle(ip);
    } catch (error) {
      if (error instanceof RateLimitExceededError) {
        res.status(429).json({ error: 'Too many requests, try again later' });
        return;
      }
      console.error('[payment-order] IP throttle check failed (allowing request):', error);
    }
  }

  // Pending-order cap: finish or abandon existing orders before minting more.
  try {
    const pending = await db
      .collection(PAYMENTS_COLLECTION)
      .where('uid', '==', uid)
      .get();
    let pendingCount = 0;
    for (const doc of pending.docs) {
      if (doc.data()?.status === 'pending') pendingCount += 1;
    }
    if (pendingCount >= MAX_PENDING_ORDERS) {
      res.status(429).json({ error: 'Too many pending orders. Complete or wait before creating another.' });
      return;
    }
  } catch (error) {
    console.error('[payment-order] Pending-order check failed (allowing request):', error);
  }

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
      // Public checkout key (never the secret).
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      res.status(429).json({ error: 'Too many requests, try again later' });
      return;
    }
    // The SDK throws plain objects on API errors and TypeErrors on timeouts,
    // so log every field available.
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
