import { Response } from 'express';
import Razorpay from 'razorpay';
import { db } from '../config/firebaseAdmin';
import { TIER_PRICES, Tier } from '../constants';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { consumeRateLimit, RateLimitExceededError } from '../services/rateLimitService';
import { PAYMENTS_COLLECTION } from '../services/subscriptionService';

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

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
    console.error('Payment order rate limit check failed:', error);
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  try {
    const amount = TIER_PRICES[tier as Tier];
    const order = await razorpay.orders.create({
      amount,
      currency: 'INR', // fixed — no client-supplied currency
      receipt: `r_${uid.slice(0, 8)}_${Date.now()}`,
    });

    await db.collection(PAYMENTS_COLLECTION).doc(order.id).set({
      uid,
      tier,
      amount: order.amount,
      currency: 'INR',
      status: 'pending',
      createdAt: new Date(),
    });

    res.json({ orderId: order.id, amount: order.amount, currency: 'INR' });
  } catch (error) {
    console.error(
      'Payment order error:',
      JSON.stringify(error, Object.getOwnPropertyNames(error))
    );
    res.status(500).json({ error: 'Failed to create order' });
  }
}
