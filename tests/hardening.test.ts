import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import {
  primeAuth,
  authHeader,
  resetAll,
  mockDb,
  mockFetch,
  jsonResponse,
  mockRazorpayPaymentsFetch,
  mockRazorpayOrdersCreate,
} from './setup';

const { createApp } = await import('../src/app');
const app = createApp();

beforeEach(() => {
  resetAll();
});

describe('payment-order throttle-first', () => {
  it('rejects when over budget WITHOUT calling Razorpay', async () => {
    primeAuth('u1');
    mockRazorpayOrdersCreate.mockResolvedValue({ id: 'order_x', amount: 17900, currency: 'INR' });
    // Exhaust 10/10min budget via the API itself.
    for (let i = 0; i < 10; i++) {
      await request(app).post('/api/payment-order').set(authHeader()).send({ tier: 'pro_monthly' });
    }
    mockRazorpayOrdersCreate.mockClear();
    const res = await request(app).post('/api/payment-order').set(authHeader()).send({ tier: 'pro_monthly' });
    expect(res.status).toBe(429);
    expect(mockRazorpayOrdersCreate).not.toHaveBeenCalled();
  });
});

describe('grant is transactional + idempotent', () => {
  it('double-grant on the same order grants once (no expiry extension)', async () => {
    const { grantPlanAndMarkPaid } = await import('../src/services/subscriptionService');
    mockDb.collection('payments').doc('order_1').set(
      { uid: 'u1', tier: 'pro_monthly', amount: 17900, status: 'pending' },
      { merge: false }
    );
    const p1 = await grantPlanAndMarkPaid('u1', 'pro_monthly', 'order_1', 'pay_1');
    expect(p1).toBe('pro');
    const firstExpiry = (mockDb.get('subscriptions/u1') as { expiresAt: number }).expiresAt;
    const p2 = await grantPlanAndMarkPaid('u1', 'pro_monthly', 'order_1', 'pay_1');
    expect(p2).toBe('pro');
    const secondExpiry = (mockDb.get('subscriptions/u1') as { expiresAt: number }).expiresAt;
    expect(secondExpiry).toBe(firstExpiry);
  });

  it('rejects a different uid claiming a paid order', async () => {
    const { grantPlanAndMarkPaid } = await import('../src/services/subscriptionService');
    mockDb.collection('payments').doc('order_2').set(
      { uid: 'u1', tier: 'pro_monthly', amount: 17900, status: 'pending' },
      { merge: false }
    );
    await grantPlanAndMarkPaid('u1', 'pro_monthly', 'order_2', 'pay_1');
    await expect(grantPlanAndMarkPaid('u2', 'pro_monthly', 'order_2', 'pay_1')).rejects.toThrow(
      /different uid/
    );
  });

  it('clamps month-end expiry (Jan 31 +1mo -> Feb 28, not Mar)', async () => {
    const { computeExpiresAtMs } = await import('../src/services/subscriptionService');
    const jan31 = Date.UTC(2026, 0, 31, 12, 0, 0);
    const expiry = computeExpiresAtMs('pro_monthly', jan31)!;
    const d = new Date(expiry);
    expect(d.getUTCMonth()).toBe(1); // February
    expect(d.getUTCDate()).toBe(28);
  });
});

describe('webhook', () => {
  it('rejects missing/invalid signature without touching Razorpay', async () => {
    const noSig = await request(app).post('/api/webhooks/razorpay').send({ event: 'payment.captured' });
    expect(noSig.status).toBe(400);

    const rawBad = JSON.stringify({ event: 'payment.captured' });
    const badSig = await request(app)
      .post('/api/webhooks/razorpay')
      .set('x-razorpay-signature', 'deadbeef')
      .set('Content-Type', 'application/json')
      .send(Buffer.from(rawBad));
    // Raw-bytes HMAC path fails -> 400, before any Razorpay fetch.
    expect(badSig.status).toBe(400);
    expect(mockRazorpayPaymentsFetch).not.toHaveBeenCalled();
  });

  it('grants on valid signed payment.captured and is idempotent', async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = 'wh_secret';
    mockDb.collection('payments').doc('order_w1').set(
      { uid: 'u1', tier: 'pro_monthly', amount: 17900, status: 'pending' },
      { merge: false }
    );
    mockRazorpayPaymentsFetch.mockResolvedValue({
      status: 'captured',
      order_id: 'order_w1',
      amount: 17900,
    });
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_w1', order_id: 'order_w1', amount: 17900 } } },
    });
    const sig = crypto.createHmac('sha256', 'wh_secret').update(body).digest('hex');

    const res = await request(app)
      .post('/api/webhooks/razorpay')
      .set('x-razorpay-signature', sig)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(200);
    expect(mockDb.get('subscriptions/u1')).toMatchObject({ plan: 'pro' });

    const replay = await request(app)
      .post('/api/webhooks/razorpay')
      .set('x-razorpay-signature', sig)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(replay.status).toBe(200);
    expect(replay.body.alreadyProcessed).toBe(true);
  });
});

describe('diagnose gate', () => {
  it('404s when disabled, reports models when enabled', async () => {
    const disabled = await request(app).get('/api/diagnose');
    expect(disabled.status).toBe(404);

    process.env.ENABLE_DIAGNOSE = 'true';
    process.env.PRIMARY_MODEL = 'custom/primary';
    const enabled = await request(app).get('/api/diagnose');
    expect(enabled.status).toBe(200);
    expect(enabled.body.primaryModel).toBe('custom/primary');
  });
});

describe('account deletion TOCTOU', () => {
  it('blocks when a grant races in before the wipe', async () => {
    primeAuth('u1');
    // No sub at route-check time, then a paid grant lands before wipe.
    // Simulate by seeding an active sub (the re-check inside
    // deleteAccountData must see it and throw 409).
    mockDb.collection('subscriptions').doc('u1').set(
      { plan: 'pro', status: 'active', expiresAt: Date.now() + 86400000, messageCount: 0, lastResetAt: Date.now() },
      { merge: false }
    );
    const res = await request(app).delete('/api/account').set(authHeader());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('active_subscription');
    // Sub was NOT wiped.
    expect(mockDb.get('subscriptions/u1')).toBeDefined();
  });
});

describe('CORS preflight allows AppCheck header', () => {
  it('OPTIONS returns the AppCheck header in allow-list', async () => {
    const res = await request(app).options('/api/chat').set('Origin', 'http://localhost:3000').set('Access-Control-Request-Method', 'POST');
    const allow = (res.headers['access-control-allow-headers'] || '') as string;
    expect(allow.toLowerCase()).toContain('x-firebase-appcheck');
  });
});

void mockFetch;
void jsonResponse;
void vi;
