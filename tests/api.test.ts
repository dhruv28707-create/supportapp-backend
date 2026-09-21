import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import {
  primeAuth,
  authHeader,
  resetAll,
  mockDb,
  mockFetch,
  jsonResponse,
} from './setup';

// Import the app AFTER the setup file has installed the module mocks.
const { createApp } = await import('../src/app');

const app = createApp();

beforeEach(() => {
  resetAll();
});

describe('GET /api/health', () => {
  it('returns 200 ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'supportapp-backend' });
  });
});

describe('Chat endpoints (the 404 regression)', () => {
  it('POST /api/chat exists and requires auth (would be 404 before the fix)', async () => {
    const res = await request(app).post('/api/chat').send({ message: 'hi' });
    expect(res.status).toBe(401);
  });

  it('POST /api/chat/send also routes to the chat handler', async () => {
    const res = await request(app).post('/api/chat/send').send({ message: 'hi' });
    expect(res.status).toBe(401);
  });

  it('answers a chat message end-to-end with quota consumed after success', async () => {
    primeAuth('u1');
    mockFetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: ' hey ' } }] }));

    const res = await request(app)
      .post('/api/chat')
      .set(authHeader())
      .send({ message: 'feeling low', personality: 'Friend' });

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('hey');
    expect(res.body.choices[0].message.content).toBe('hey');
    // Quota consumed exactly once.
    const sub = mockDb.get('subscriptions/u1');
    expect(sub?.messageCount).toBe(1);
  });

  it('consumes NO quota when the AI upstream fails (503)', async () => {
    primeAuth('u1');
    mockFetch.mockResolvedValue(jsonResponse({ error: { message: 'overloaded' } }, 500));

    const res = await request(app)
      .post('/api/chat')
      .set(authHeader())
      .send({ message: 'hello' });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('ai_upstream_error');
    expect(mockDb.get('subscriptions/u1')).toBeUndefined();
  });

  it('rejects locked personas for free plans without touching quota or AI', async () => {
    primeAuth('u1');
    const res = await request(app)
      .post('/api/chat')
      .set(authHeader())
      .send({ message: 'hi', personality: 'Girlfriend' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('persona_locked');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockDb.get('subscriptions/u1')).toBeUndefined();
  });

  it('returns 400 on invalid personality', async () => {
    primeAuth('u1');
    const res = await request(app)
      .post('/api/chat')
      .set(authHeader())
      .send({ message: 'hi', personality: 'Boss' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid personality');
  });
});

describe('GET /api/user/plan', () => {
  it('reports remaining messages and refresh time', async () => {
    primeAuth('u1');
    mockDb.collection('subscriptions').doc('u1').set({
      plan: 'pro',
      messageCount: 10,
      lastResetAt: Date.now(),
      expiresAt: null,
    }, { merge: false });

    const res = await request(app).get('/api/user/plan').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.plan).toBe('pro');
    expect(res.body.messagesRemaining).toBe(70);
    expect(res.body.isLimitReached).toBe(false);
  });

  it('downgrades an expired paid plan to free', async () => {
    primeAuth('u1');
    mockDb.collection('subscriptions').doc('u1').set({
      plan: 'ultimate',
      messageCount: 5,
      lastResetAt: Date.now(),
      expiresAt: Date.now() - 1000,
    }, { merge: false });

    const res = await request(app).get('/api/user/plan').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.plan).toBe('free');
    expect(res.body.messagesRemaining).toBe(20);
  });
});

describe('POST /api/payment-order', () => {
  it('creates an order with the server-side price and returns keyId', async () => {
    primeAuth('u1');
    const { default: razorpayConstructor } = await import('razorpay');
    const instance = new razorpayConstructor({ key_id: 'k', key_secret: 's' });
    (instance.orders.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'order_1',
      amount: 17900,
      currency: 'INR',
    });

    const res = await request(app)
      .post('/api/payment-order')
      .set(authHeader())
      .send({ tier: 'pro_monthly' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ orderId: 'order_1', amount: 17900, currency: 'INR' });
    expect(mockDb.get('payments/order_1')).toMatchObject({ uid: 'u1', tier: 'pro_monthly', status: 'pending' });
  });

  it('rejects unknown tiers', async () => {
    primeAuth('u1');
    const res = await request(app)
      .post('/api/payment-order')
      .set(authHeader())
      .send({ tier: 'mega_ultra' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/payment-verify', () => {
  it('verifies a captured payment, grants the plan idempotently', async () => {
    primeAuth('u1');
    // Seed the pending order exactly as paymentOrderHandler would.
    mockDb.collection('payments').doc('order_1').set({
      uid: 'u1',
      tier: 'pro_monthly',
      amount: 17900,
      currency: 'INR',
      status: 'pending',
    }, { merge: false });

    const { default: razorpayConstructor } = await import('razorpay');
    const instance = new razorpayConstructor({ key_id: 'k', key_secret: 's' });
    (instance.payments.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'captured',
      order_id: 'order_1',
      amount: 17900,
    });

    process.env.RAZORPAY_KEY_SECRET = 'test_secret';
    const crypto = await import('crypto');
    const sig = crypto
      .createHmac('sha256', 'test_secret')
      .update('order_1|pay_1')
      .digest('hex');

    const res = await request(app)
      .post('/api/payment-verify')
      .set(authHeader())
      .send({
        razorpay_order_id: 'order_1',
        razorpay_payment_id: 'pay_1',
        razorpay_signature: sig,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.plan).toBe('pro');
    expect(mockDb.get('subscriptions/u1')).toMatchObject({ plan: 'pro', status: 'active' });
    expect(mockDb.get('payments/order_1')).toMatchObject({ status: 'paid' });

    // Idempotent replay.
    const replay = await request(app)
      .post('/api/payment-verify')
      .set(authHeader())
      .send({
        razorpay_order_id: 'order_1',
        razorpay_payment_id: 'pay_1',
        razorpay_signature: sig,
      });
    expect(replay.status).toBe(200);
    expect(replay.body.alreadyVerified).toBe(true);
  });
});

describe('POST /api/payment-cancel', () => {
  it('cancels an active subscription immediately and is idempotent', async () => {
    primeAuth('u1');
    mockDb.collection('subscriptions').doc('u1').set({
      plan: 'pro',
      status: 'active',
      messageCount: 3,
      lastResetAt: Date.now(),
      expiresAt: Date.now() + 86400000,
    }, { merge: false });

    const res = await request(app).post('/api/payment-cancel').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Subscription cancelled');
    expect(mockDb.get('subscriptions/u1')).toMatchObject({ plan: 'free', status: 'cancelled' });

    // Replay: still success.
    const replay = await request(app).post('/api/payment-cancel').set(authHeader());
    expect(replay.status).toBe(200);
    expect(replay.body.message).toBe('No active subscription found');
  });
});

describe('DELETE /api/account', () => {
  it('blocks deletion while a paid subscription is active (409)', async () => {
    primeAuth('u1');
    mockDb.collection('subscriptions').doc('u1').set({
      plan: 'pro',
      status: 'active',
      expiresAt: Date.now() + 86400000,
    }, { merge: false });

    const res = await request(app).delete('/api/account').set(authHeader());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('active_subscription');
  });

  it('wipes all data for a free user and revokes + deletes auth', async () => {
    const { revokeUserTokensSpy } = await spyAuth();
    primeAuth('u1');
    mockDb.collection('subscriptions').doc('u1').set({ plan: 'free' }, { merge: false });
    mockDb.collection('users').doc('u1').set({ name: 'x' }, { merge: false });
    mockDb.collection('chats').doc('c1').set({ uid: 'u1', text: 'hi' }, { merge: false });
    mockDb.collection('rateLimits').doc('chat:u1').set({ count: 5 }, { merge: false });

    const res = await request(app).delete('/api/account').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.deleted.subscription).toBe(true);
    expect(res.body.deleted.userDoc).toBe(true);
    expect(res.body.chatsDeleted).toBeGreaterThanOrEqual(1);
    expect(mockDb.get('subscriptions/u1')).toBeUndefined();
    expect(mockDb.get('users/u1')).toBeUndefined();
    expect(mockDb.get('chats/c1')).toBeUndefined();
    expect(mockDb.get('rateLimits/chat:u1')).toBeUndefined();
    expect(mockAuth.revokeRefreshTokens).toHaveBeenCalledWith('u1');
    expect(mockAuth.deleteUser).toHaveBeenCalledWith('u1');
    void revokeUserTokensSpy;
  });

  it('anonymizes paid payment rows instead of deleting them', async () => {
    primeAuth('u1');
    mockDb.collection('payments').doc('order_paid').set({
      uid: 'u1', tier: 'pro_monthly', status: 'paid', amount: 17900,
    }, { merge: false });
    mockDb.collection('payments').doc('order_pending').set({
      uid: 'u1', tier: 'pro_monthly', status: 'pending', amount: 17900,
    }, { merge: false });

    const res = await request(app).delete('/api/account').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.anonymizedPayments).toBe(1);
    expect(res.body.deleted.pendingPayments).toBe(1);
    expect(mockDb.get('payments/order_paid')).toMatchObject({ uid: 'deleted:u1' });
    expect(mockDb.get('payments/order_pending')).toBeUndefined();
  });
});

async function spyAuth() {
  return { revokeUserTokensSpy: mockAuth.revokeRefreshTokens };
}
