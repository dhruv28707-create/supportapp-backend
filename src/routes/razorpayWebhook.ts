import { Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../config/firebaseAdmin';
import { razorpay } from '../services/razorpayClient';
import { grantPlanAndMarkPaid, PAYMENTS_COLLECTION } from '../services/subscriptionService';
import { timingSafeEqualHex } from '../utils/crypto';

interface RazorpayWebhookEvent {
  event?: string;
  payload?: {
    payment?: {
      entity: {
        id?: string;
        order_id?: string;
        amount?: number | string;
      };
    };
  };
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

  let event: RazorpayWebhookEvent | undefined;
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
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const expectedHex = crypto
      .createHmac('sha256', webhookSecret || '')
      .update(rawBody)
      .digest('hex');

    if (!webhookSecret || !timingSafeEqualHex(expectedHex, signature)) {
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
    // The platform pre-parsed the body, so the raw bytes needed for the HMAC
    // are gone. The event is still cross-checked against Razorpay's API
    // below, but a forged payload with real captured-payment ids could pass
    // that check — so when a webhook secret is configured, require the raw
    // path instead of accepting unverifiable bytes.
    if (process.env.RAZORPAY_WEBHOOK_SECRET) {
      console.warn('Webhook received a pre-parsed body; raw body required for signature check');
      res.status(400).json({ error: 'Invalid body' });
      return;
    }
    console.warn('Webhook received a pre-parsed body; validating via Razorpay API');
    event = req.body;
  } else {
    res.status(400).json({ error: 'Invalid body' });
    return;
  }

  // Acknowledge non-payment events.
  if (event?.event !== 'payment.captured') {
    res.status(200).json({ received: true });
    return;
  }

  const payment = event?.payload?.payment?.entity;
  const orderId: string | undefined = payment?.order_id;
  const paymentId: string | undefined = payment?.id;

  if (!orderId || !paymentId || !payment) {
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

    // Authoritative check: the payment must exist at Razorpay, be captured,
    // and belong to this exact order.
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

    // Plan and expiry come from our own order record, never client input.
    await grantPlanAndMarkPaid(record.uid, record.tier, orderId, paymentId);

    console.log('Plan granted via webhook:', { uid: record.uid, tier: record.tier, orderId });
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Processing failed' });
  }
}
