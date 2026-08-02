import { Request, Response } from 'express';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import { db } from '../config/firebaseAdmin';
import {
  grantPlanAndMarkPaid,
  PAYMENTS_COLLECTION,
} from '../services/subscriptionService';

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

function timingSafeEqualHex(expectedHex: string, receivedHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const received = Buffer.from(receivedHex, 'hex');
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(expected, received);
}

/** The subset of a Razorpay payment entity that we validate against. */
interface PaymentCheck {
  status: string;
  order_id: string;
  amount: number | string;
}

/** Reads the raw request body when the platform did not pre-parse it. */
function readRawBody(req: Request): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    if (!req.readable) {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function razorpayWebhookHandler(req: Request, res: Response): Promise<void> {
  const signature = req.headers['x-razorpay-signature'] as string | undefined;

  if (!signature) {
    res.status(400).json({ error: 'Missing signature' });
    return;
  }

  let event: any;
  let rawBody: Buffer | string | null = null;

  if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
    rawBody = req.body;
  } else if (req.body === undefined || req.body === null) {
    // Platform did not parse the body (e.g. bodyParser disabled) — read the stream.
    try {
      rawBody = await readRawBody(req);
    } catch (error) {
      console.error('Webhook raw body read failed:', error);
      res.status(400).json({ error: 'Invalid body' });
      return;
    }
  }

  if (rawBody !== null) {
    // Signature is computed over the exact raw request bytes.
    const expectedHex = crypto
      .createHmac('sha256', WEBHOOK_SECRET || '')
      .update(rawBody)
      .digest('hex');

    if (!WEBHOOK_SECRET || !timingSafeEqualHex(expectedHex, signature)) {
      console.warn('Invalid Razorpay webhook signature');
      res.status(400).json({ error: 'Invalid signature' });
      return;
    }

    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch (error) {
      console.error('Webhook body parse failed:', error);
      res.status(400).json({ error: 'Invalid body' });
      return;
    }
  } else if (req.body && typeof req.body === 'object') {
    // Body was pre-parsed by the platform, so the raw bytes are gone and the
    // HMAC cannot be recomputed. The event is still authoritatively validated
    // below against Razorpay's API and our own order record before any grant.
    console.warn('Webhook received a pre-parsed body; validating via Razorpay API');
    event = req.body;
  } else {
    res.status(400).json({ error: 'Invalid body' });
    return;
  }

  // Acknowledge non-payment events without doing anything.
  if (event?.event !== 'payment.captured') {
    res.status(200).json({ received: true });
    return;
  }

  const payment = event?.payload?.payment?.entity;
  const orderId: string | undefined = payment?.order_id;
  const paymentId: string | undefined = payment?.id;

  if (!orderId || !paymentId) {
    res.status(400).json({ error: 'Invalid payment event' });
    return;
  }

  try {
    const paymentSnap = await db.collection(PAYMENTS_COLLECTION).doc(orderId).get();

    if (!paymentSnap.exists) {
      console.warn('Webhook for unknown order:', orderId);
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    const record = paymentSnap.data() || {};

    // Idempotency — never re-grant an already-paid order.
    if (record.status === 'paid') {
      res.status(200).json({ received: true, alreadyProcessed: true });
      return;
    }

    // Event amount must match the server-set order amount.
    if (Number(payment.amount) !== Number(record.amount)) {
      console.warn('Webhook amount mismatch:', { orderId, eventAmount: payment.amount, recordAmount: record.amount });
      res.status(400).json({ error: 'Amount mismatch' });
      return;
    }

    // Authoritative check with Razorpay: the payment must exist, be captured,
    // and belong to this exact order. A forged or unauthenticated webhook
    // cannot pass this check.
    let rzPayment: PaymentCheck | undefined;
    try {
      rzPayment = await razorpay.payments.fetch(paymentId);
    } catch (error) {
      console.error('Webhook payment fetch failed:', error);
      res.status(502).json({ error: 'Payment validation unavailable' });
      return;
    }
    if (!rzPayment) {
      res.status(502).json({ error: 'Payment validation unavailable' });
      return;
    }

    if (
      rzPayment.status !== 'captured' ||
      rzPayment.order_id !== orderId ||
      Number(rzPayment.amount) !== Number(record.amount)
    ) {
      console.warn('Webhook payment validation failed:', { orderId, rzStatus: rzPayment.status });
      res.status(400).json({ error: 'Payment validation failed' });
      return;
    }

    // Plan and expiry come from our own order record — never from client notes.
    await grantPlanAndMarkPaid(record.uid, record.tier, orderId, paymentId);

    console.log('Plan granted via webhook:', { uid: record.uid, tier: record.tier, orderId });
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    // Non-2xx so Razorpay retries the delivery.
    res.status(500).json({ error: 'Processing failed' });
  }
}
