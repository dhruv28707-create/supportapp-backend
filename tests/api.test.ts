import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import {
  primeAuth,
  authHeader,
  resetAll,
  mockDb,
  mockAuth,
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
      .send({ message: 'feeling low', personality: 'Father' });

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('hey');
    expect(res.body.choices[0].message.content).toBe('hey');
    // Quota is accounted in the background after the reply is sent (so the
    // reply never waits on Firestore) — poll until the write lands.
    await vi.waitFor(() => {
      expect(mockDb.get('subscriptions/u1')?.messageCount).toBe(1);
    });
  });

  it('removes a leaked model end token and its runaway continuation', async () => {
    primeAuth('u1');
    mockFetch.mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: 'Baki sab kaam ho jayega.<|endoftext|>Okay! ... Morse code?' } }],
      })
    );

    const res = await request(app)
      .post('/api/chat')
      .set(authHeader())
      .send({ message: 'Fir baki sab manage kese hoga', personality: 'Father' });

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Baki sab kaam ho jayega.');
    expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body)).stop).toContain('<|endoftext|>');
  });

  it('forwards recent user and assistant turns as context', async () => {
    primeAuth('u1');
    mockFetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'You said blue.' } }] }));

    const res = await request(app)
      .post('/api/chat')
      .set(authHeader())
      .send({
        message: 'What colour did I say?',
        personality: 'Father',
        messages: [
          { role: 'user', content: 'My favourite colour is blue.' },
          { role: 'assistant', content: 'Blue suits you.' },
        ],
      });

    expect(res.status).toBe(200);
    const upstreamBody = JSON.parse(String(mockFetch.mock.calls[0][1]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(upstreamBody.messages.slice(1)).toEqual([
      { role: 'user', content: 'My favourite colour is blue.' },
      { role: 'assistant', content: 'Blue suits you.' },
      { role: 'user', content: 'What colour did I say?' },
    ]);
  });

  it('gives each faith-specific Guide a cross-faith non-participation rule', async () => {
    const { buildSystemPrompt } = await import('../src/services/promptService');
    for (const religion of ['islamic', 'hindu', 'christian', 'buddhist', 'jewish']) {
      expect(buildSystemPrompt('Guide', religion)).toContain(
        'Do not repeat, endorse, praise, or participate in devotional greetings'
      );
    }
    expect(buildSystemPrompt('Guide', 'spiritual')).not.toContain('Faith boundary:');
    expect(buildSystemPrompt('Guide', 'secular')).not.toContain('Faith boundary:');
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

  it('rejects an exhausted quota instantly without calling AI', async () => {
    primeAuth('u1');
    mockDb.collection('subscriptions').doc('u1').set({
      plan: 'free',
      messageCount: 20,
      lastResetAt: Date.now(),
      expiresAt: null,
    }, { merge: false });

    const res = await request(app)
      .post('/api/chat')
      .set(authHeader())
      .send({ message: 'hello', personality: 'Father' });

    expect(res.status).toBe(429);
    expect(res.body.limitReached).toBe(true);
    expect(res.body.code).toBe('quota_exhausted');
    expect(typeof res.body.nextRefreshAt).toBe('number');
    // No provider spend for a rejection.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('answers from Groq first (fast provider is primary) and keeps OpenRouter as fallback', async () => {
    primeAuth('u1');
    // Both providers answer, with distinct text: whichever one is PRIMARY
    // should win. Groq is primary by default.
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('groq')) {
        return jsonResponse({ choices: [{ message: { content: 'from groq' } }] });
      }
      return jsonResponse({ choices: [{ message: { content: 'from openrouter' } }] });
    });

    const res = await request(app)
      .post('/api/chat')
      .set(authHeader())
      .send({ message: 'hi', personality: 'Father' });

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('from groq');
  });

  it('fails over to OpenRouter immediately when Groq errors fast', async () => {
    primeAuth('u1');
    // Primary (Groq) dies instantly; fallback (OpenRouter) answers.
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('groq')) {
        return jsonResponse({ error: { message: 'primary down' } }, 500);
      }
      return jsonResponse({ choices: [{ message: { content: 'from fallback' } }] });
    });

    const started = Date.now();
    const res = await request(app)
      .post('/api/chat')
      .set(authHeader())
      .send({ message: 'are you there', personality: 'Father' });
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('from fallback');
    // The fallback must NOT wait out the full stagger when the primary has
    // already definitively failed — that was 700ms of dead air per message.
    expect(elapsed).toBeLessThan(700);
  });

  it('rejects locked personas for free plans without touching quota or AI', async () => {
    primeAuth('u1');
    const res = await request(app)
      .post('/api/chat')
      .set(authHeader())
      .send({ message: 'hi', personality: 'Mentor' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('persona_locked');
    expect(res.body.requiredPlan).toBe('pro');
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

  it('coerces legacy personality/religion aliases instead of 400', async () => {
    primeAuth('u1');
    mockFetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'hi' } }] }));

    const alias = await request(app)
      .post('/api/chat')
      .set(authHeader())
      .send({ message: 'hi', personality: 'BestFriend' });
    // 'BestFriend' coerces to 'Best Friend' (a Pro persona) — the 403 naming
    // the canonical persona proves the alias was resolved before gating.
    expect(alias.status).toBe(403);
    expect(alias.body.code).toBe('persona_locked');
    expect(alias.body.personality).toBe('Best Friend');

    // Removed personas (incl. the old BF/GF shorthands) get a clear
    // "please update" 400 that old app builds show as-is.
    const retired = await request(app)
      .post('/api/chat')
      .set(authHeader())
      .send({ message: 'hi', personality: 'BF' });
    expect(retired.status).toBe(400);
    expect(retired.body.code).toBe('persona_retired');
    expect(retired.body.error).toContain('update the app');

    // 'muslim' is accepted as 'islamic'.
    const muslim = await request(app)
      .post('/api/chat')
      .set(authHeader())
      .send({ message: 'hi', personality: 'Father', religionSubType: 'muslim' });
    expect(muslim.status).toBe(200);
  });

  it('answers with a free persona when none is sent (default never hits the plan gate)', async () => {
    primeAuth('u1');
    mockFetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'hi' } }] }));
    const res = await request(app).post('/api/chat').set(authHeader()).send({ message: 'hello' });
    expect(res.status).toBe(200);
    expect(res.body.personality).toBe('Father');
  });

  it.each(['Friend', 'Husband', 'Wife', 'Boyfriend', 'Girlfriend', 'BF', 'GF'])(
    'rejects the removed persona %s with a clear update message',
    async (removed) => {
      primeAuth('u1');
      const res = await request(app)
        .post('/api/chat')
        .set(authHeader())
        .send({ message: 'hi', personality: removed });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('persona_retired');
      expect(mockFetch).not.toHaveBeenCalled();
    }
  );

  it('enforces the plan tiers: free < Pro < Ultimate', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'hi' } }] }));
    const seed = (plan: string) =>
      mockDb.collection('subscriptions').doc('u1').set(
        { plan, messageCount: 0, lastResetAt: Date.now(), expiresAt: plan === 'free' ? null : Date.now() + 86400000 },
        { merge: false }
      );
    const status = async (personality: string) =>
      (await request(app).post('/api/chat').set(authHeader()).send({ message: 'hi', personality })).status;

    const expected: Record<string, Record<string, number>> = {
      free: { Father: 200, Mother: 200, Sister: 200, Brother: 200, 'Best Friend': 403, Mentor: 403, Guide: 403, Stranger: 403 },
      pro: { Father: 200, Mother: 200, Sister: 200, Brother: 200, 'Best Friend': 200, Mentor: 200, Guide: 403, Stranger: 403 },
      ultimate: { Father: 200, Mother: 200, Sister: 200, Brother: 200, 'Best Friend': 200, Mentor: 200, Guide: 200, Stranger: 200 },
    };
    for (const plan of ['free', 'pro', 'ultimate']) {
      primeAuth('u1');
      seed(plan);
      for (const [persona, want] of Object.entries(expected[plan])) {
        expect(await status(persona), `${plan} -> ${persona}`).toBe(want);
      }
    }
  });

  it('rejects messages over 2000 characters', async () => {
    primeAuth('u1');
    const res = await request(app)
      .post('/api/chat')
      .set(authHeader())
      .send({ message: 'x'.repeat(2001), personality: 'Father' });
    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
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
    expect(res.body.expiresAt).toBeNull();
    expect(typeof res.body.refillInMs).toBe('number');
    expect(res.body.refreshHours).toBe(4);
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
      currency: 'INR',
    });

    process.env.RAZORPAY_KEY_SECRET = 'test_secret';
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

  it('rejects an order that belongs to another uid', async () => {
    primeAuth('u1');
    mockDb.collection('payments').doc('order_other').set(
      { uid: 'u2', tier: 'pro_monthly', amount: 17900, status: 'pending' },
      { merge: false }
    );
    const sig = crypto
      .createHmac('sha256', 'test_secret')
      .update('order_other|pay_other')
      .digest('hex');

    const res = await request(app)
      .post('/api/payment-verify')
      .set(authHeader())
      .send({
        razorpay_order_id: 'order_other',
        razorpay_payment_id: 'pay_other',
        razorpay_signature: sig,
      });

    expect(res.status).toBe(403);
  });

  it('rejects an amount that does not match the order', async () => {
    primeAuth('u1');
    mockDb.collection('payments').doc('order_amt').set(
      { uid: 'u1', tier: 'pro_monthly', amount: 17900, status: 'pending' },
      { merge: false }
    );
    const { default: razorpayConstructor } = await import('razorpay');
    const instance = new razorpayConstructor({ key_id: 'k', key_secret: 's' });
    (instance.payments.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'captured',
      order_id: 'order_amt',
      amount: 100,
      currency: 'INR',
    });
    const sig = crypto
      .createHmac('sha256', 'test_secret')
      .update('order_amt|pay_amt')
      .digest('hex');

    const res = await request(app)
      .post('/api/payment-verify')
      .set(authHeader())
      .send({
        razorpay_order_id: 'order_amt',
        razorpay_payment_id: 'pay_amt',
        razorpay_signature: sig,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Amount mismatch');
  });

  it('rejects a payment in the wrong currency', async () => {
    primeAuth('u1');
    mockDb.collection('payments').doc('order_cur').set(
      { uid: 'u1', tier: 'pro_monthly', amount: 17900, status: 'pending' },
      { merge: false }
    );
    const { default: razorpayConstructor } = await import('razorpay');
    const instance = new razorpayConstructor({ key_id: 'k', key_secret: 's' });
    (instance.payments.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'captured',
      order_id: 'order_cur',
      amount: 17900,
      currency: 'USD',
    });
    const sig = crypto
      .createHmac('sha256', 'test_secret')
      .update('order_cur|pay_cur')
      .digest('hex');

    const res = await request(app)
      .post('/api/payment-verify')
      .set(authHeader())
      .send({
        razorpay_order_id: 'order_cur',
        razorpay_payment_id: 'pay_cur',
        razorpay_signature: sig,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Currency mismatch');
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

  it('returns 500 when Firebase Auth deletion fails (no lying success)', async () => {
    primeAuth('u1');
    mockAuth.deleteUser.mockRejectedValue({ code: 'auth/internal-error' });

    const res = await request(app).delete('/api/account').set(authHeader());

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('auth_delete_failed');
  });

  it('treats an already-missing Auth user as success', async () => {
    primeAuth('u1');
    mockAuth.deleteUser.mockRejectedValue({ code: 'auth/user-not-found' });

    const res = await request(app).delete('/api/account').set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

async function spyAuth() {
  return { revokeUserTokensSpy: mockAuth.revokeRefreshTokens };
}

describe('GET /api/app-config', () => {
  it('is public and reports "no update needed" until build numbers are configured', async () => {
    const res = await request(app).get('/api/app-config');
    expect(res.status).toBe(200);
    expect(res.body.minVersionCode).toBe(0);
    expect(res.body.latestVersionCode).toBe(0);
    expect(res.body.storeUrls.android).toContain('play.google.com');
  });

  it('reads min/latest build numbers from the environment', async () => {
    vi.stubEnv('APP_MIN_VERSION_CODE', '7');
    vi.stubEnv('APP_LATEST_VERSION_CODE', '9');
    const res = await request(app).get('/api/app-config');
    expect(res.body.minVersionCode).toBe(7);
    expect(res.body.latestVersionCode).toBe(9);
    vi.unstubAllEnvs();
  });
});