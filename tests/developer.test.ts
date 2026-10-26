import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import {
  primeAuth,
  authHeader,
  resetAll,
  mockDb,
  mockAuth,
  mockFetch,
  jsonResponse,
} from './setup';

const { createApp } = await import('../src/app');

const app = createApp();

beforeEach(() => {
  resetAll();
});

function seedFreeQuota(count = 0) {
  mockDb.collection('subscriptions').doc('u1').set(
    { plan: 'free', messageCount: count, lastResetAt: Date.now(), expiresAt: null },
    { merge: false }
  );
}

describe('developer access gate', () => {
  it('rejects normal users on every developer route', async () => {
    primeAuth('u1');

    for (const path of [
      '/api/developer/overview',
      '/api/developer/users',
      '/api/developer/collections',
      '/api/developer/provider-usage',
    ]) {
      const res = await request(app).get(path).set(authHeader());
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('developer_only');
    }
  });

  it('requires auth before the developer gate', async () => {
    const res = await request(app).get('/api/developer/overview');
    expect(res.status).toBe(401);
  });

  it('accepts the signed developer custom claim', async () => {
    mockAuth.verifyIdToken.mockResolvedValue({
      uid: 'u1',
      email: 'dev@test.dev',
      developer: true,
    });

    const res = await request(app).get('/api/developer/overview').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.developer.uid).toBe('u1');
  });

  it('accepts the server-side env allowlist', async () => {
    vi.stubEnv('DEVELOPER_UIDS', 'u1');
    primeAuth('u1');

    const res = await request(app).get('/api/developer/overview').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.collections.map((c: { name: string }) => c.name)).toContain('users');
  });

  it('accepts the protected Firestore developer flag as a fallback', async () => {
    primeAuth('u1');
    mockDb.collection('users').doc('u1').set({ isDeveloper: true }, { merge: false });

    const res = await request(app).get('/api/developer/overview').set(authHeader());
    expect(res.status).toBe(200);
  });
});

describe('developer premium access', () => {
  it('reports Ultimate + unlimited and skips quota writes for env developers', async () => {
    vi.stubEnv('DEVELOPER_UIDS', 'u1');
    primeAuth('u1');
    seedFreeQuota(999);
    mockFetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'hello' } }] }));

    const usage = await request(app).get('/api/user/usage').set(authHeader());
    expect(usage.status).toBe(200);
    expect(usage.body).toMatchObject({
      plan: 'ultimate',
      isDeveloper: true,
      unlimited: true,
      messagesUsed: 0,
      messagesRemaining: 200,
      isLimitReached: false,
      showRefillTimer: false,
    });

    const chat = await request(app)
      .post('/api/chat')
      .set(authHeader())
      .send({ message: 'hi', personality: 'Wife' });

    expect(chat.status).toBe(200);
    expect(chat.body.reply).toBe('hello');
    // The developer path never touches the subscription counter.
    expect(mockDb.get('subscriptions/u1')!.messageCount).toBe(999);
  });

  it('unlocks paid personas for a Firestore-flagged developer without a claim', async () => {
    primeAuth('u1');
    mockDb.collection('users').doc('u1').set({ isDeveloper: true }, { merge: false });
    mockFetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));

    const chat = await request(app)
      .post('/api/chat')
      .set(authHeader())
      .send({ message: 'hi', personality: 'Wife' });

    expect(chat.status).toBe(200);
    expect(mockDb.get('subscriptions/u1')).toBeUndefined();
  });

  it('unlocks paid personas when only the users-doc flag exists and a free sub doc predates the grant', async () => {
    primeAuth('u1');
    // Simulates a developer flag set outside the grant script (e.g. console
    // edit) while the account already has a normal free subscription doc.
    mockDb.collection('users').doc('u1').set({ isDeveloper: true }, { merge: false });
    mockDb.collection('subscriptions').doc('u1').set(
      { plan: 'free', messageCount: 20, lastResetAt: Date.now(), expiresAt: null },
      { merge: false }
    );
    mockFetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));

    const usage = await request(app).get('/api/user/usage').set(authHeader());
    expect(usage.status).toBe(200);
    expect(usage.body).toMatchObject({
      plan: 'ultimate',
      isDeveloper: true,
      unlimited: true,
    });

    const chat = await request(app)
      .post('/api/chat')
      .set(authHeader())
      .send({ message: 'hi', personality: 'Wife' });
    expect(chat.status).toBe(200);
  });

  it('does not change the free-user persona gate', async () => {
    primeAuth('u1');
    seedFreeQuota(0);

    const chat = await request(app)
      .post('/api/chat')
      .set(authHeader())
      .send({ message: 'hi', personality: 'Wife' });

    expect(chat.status).toBe(403);
    expect(chat.body.code).toBe('persona_locked');
  });

  it('blocks purchases, trials, and app-side deletion for developers', async () => {
    vi.stubEnv('DEVELOPER_UIDS', 'u1');
    primeAuth('u1');

    const order = await request(app)
      .post('/api/payment-order')
      .set(authHeader())
      .send({ tier: 'pro_monthly' });
    expect(order.status).toBe(409);
    expect(order.body.code).toBe('developer_account');
    expect(mockDb.paths().some((path) => path.startsWith('payments/'))).toBe(false);

    const trial = await request(app).post('/api/trial/start').set(authHeader());
    expect(trial.status).toBe(409);
    expect(trial.body.code).toBe('developer_account');

    const deletion = await request(app).delete('/api/account').set(authHeader());
    expect(deletion.status).toBe(403);
    expect(deletion.body.code).toBe('developer_account');
  });
});

describe('developer read-only API', () => {
  it('lists auth users and returns a user detail bundle', async () => {
    vi.stubEnv('DEVELOPER_UIDS', 'u1');
    primeAuth('u1');

    mockAuth.listUsers.mockResolvedValue({
      users: [
        {
          uid: 'u2',
          email: 'u2@test.dev',
          displayName: 'User Two',
          phoneNumber: null,
          disabled: false,
          emailVerified: true,
          metadata: {
            creationTime: '2026-01-01T00:00:00.000Z',
            lastSignInTime: '2026-01-02T00:00:00.000Z',
          },
          providerData: [{ providerId: 'password' }],
        },
      ],
      pageToken: undefined,
    });

    const list = await request(app)
      .get('/api/developer/users?limit=10')
      .set(authHeader());
    expect(list.status).toBe(200);
    expect(list.body.users[0]).toMatchObject({ uid: 'u2', email: 'u2@test.dev' });
    expect(mockAuth.listUsers).toHaveBeenCalledWith(10, undefined);

    mockAuth.getUser.mockResolvedValue({
      uid: 'u2',
      email: 'u2@test.dev',
      displayName: null,
      phoneNumber: null,
      disabled: false,
      emailVerified: true,
      metadata: { creationTime: '2026-01-01T00:00:00.000Z' },
      providerData: [],
    });
    mockDb.collection('users').doc('u2').set({ tier: 'free', name: 'Two' }, { merge: false });
    mockDb.collection('subscriptions').doc('u2').set(
      { plan: 'pro', messageCount: 3, lastResetAt: Date.now(), expiresAt: null },
      { merge: false }
    );
    mockDb.collection('payments').doc('pay_1').set(
      { uid: 'u2', status: 'paid', amount: 17900, createdAt: new Date('2026-01-01') },
      { merge: false }
    );

    const detail = await request(app)
      .get('/api/developer/users/u2')
      .set(authHeader());
    expect(detail.status).toBe(200);
    expect(detail.body.auth.uid).toBe('u2');
    expect(detail.body.profile).toMatchObject({ name: 'Two' });
    expect(detail.body.subscription.plan).toBe('pro');
    expect(detail.body.payments).toHaveLength(1);
    expect(detail.body.effectivePlan.plan).toBe('pro');
  });

  it('browses allowlisted collections with uid filters and cursors', async () => {
    vi.stubEnv('DEVELOPER_UIDS', 'u1');
    primeAuth('u1');

    mockDb.collection('users').doc('a').set({ tier: 'free' }, { merge: false });
    mockDb.collection('users').doc('b').set({ tier: 'free' }, { merge: false });
    mockDb.collection('payments').doc('p1').set({ uid: 'a', status: 'paid' }, { merge: false });
    mockDb.collection('payments').doc('p2').set({ uid: 'b', status: 'pending' }, { merge: false });

    const collections = await request(app)
      .get('/api/developer/collections')
      .set(authHeader());
    expect(collections.status).toBe(200);
    expect(collections.body.collections.map((c: { name: string }) => c.name)).toEqual(
      expect.arrayContaining(['users', 'subscriptions', 'payments', 'rateLimits'])
    );

    const firstPage = await request(app)
      .get('/api/developer/collections/users?limit=1')
      .set(authHeader());
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.docs).toHaveLength(1);
    expect(firstPage.body.nextCursor).toBe('a');

    const secondPage = await request(app)
      .get(`/api/developer/collections/users?limit=1&cursor=${firstPage.body.nextCursor}`)
      .set(authHeader());
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.docs[0].id).toBe('b');

    const filtered = await request(app)
      .get('/api/developer/collections/payments?uid=b')
      .set(authHeader());
    expect(filtered.status).toBe(200);
    expect(filtered.body.docs).toHaveLength(1);
    expect(filtered.body.docs[0].id).toBe('p2');

    const unknown = await request(app)
      .get('/api/developer/collections/notARealCollection')
      .set(authHeader());
    expect(unknown.status).toBe(404);
  });

  it('reports OpenRouter key usage without leaking the key', async () => {
    vi.stubEnv('DEVELOPER_UIDS', 'u1');
    primeAuth('u1');
    mockFetch.mockResolvedValue(
      jsonResponse({
        data: {
          usage: 1.5,
          limit: 10,
          limit_remaining: 8.5,
          is_free_tier: false,
          rate_limit: { requests: 60, interval: '1m' },
        },
      })
    );

    const res = await request(app)
      .get('/api/developer/provider-usage')
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.openrouter).toMatchObject({
      configured: true,
      ok: true,
      usage: 1.5,
      limit: 10,
      limitRemaining: 8.5,
      isFreeTier: false,
    });
    expect(res.body.groq.configured).toBe(true);
    expect(res.body.razorpay).toMatchObject({ configured: true, mode: 'test' });
    expect(JSON.stringify(res.body)).not.toContain('test-openrouter-key');

    const [, init] = mockFetch.mock.calls[0];
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe(
      'Bearer test-openrouter-key'
    );
  });
});

describe('developer logs API', () => {
  it('rejects normal users', async () => {
    primeAuth('u1');
    const res = await request(app).get('/api/developer/logs').set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('developer_only');
  });

  it('returns persisted chat events newest first with working filters and cursor', async () => {
    vi.stubEnv('DEVELOPER_UIDS', 'u1');
    primeAuth('u1');
    mockFetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'hi' } }] }));

    // Two successful chats (chat_reply events) with different personalities.
    await request(app)
      .post('/api/chat')
      .set(authHeader())
      .send({ message: 'one', personality: 'Friend' });
    await request(app)
      .post('/api/chat')
      .set(authHeader())
      .send({ message: 'two', personality: 'Wife' });

    const all = await request(app).get('/api/developer/logs').set(authHeader());
    expect(all.status).toBe(200);
    const replyEvents = all.body.logs.filter(
      (log: { event: string }) => log.event === 'chat_reply'
    );
    expect(replyEvents.length).toBe(2);
    // Newest first: the second chat must come before the first.
    expect(replyEvents[0].detail.personality).toBe('Wife');
    expect(replyEvents[1].detail.personality).toBe('Friend');
    // Never log the user's message content.
    expect(all.body.logs.some((log: { detail?: { replyLength?: number } }) =>
      log.detail && typeof log.detail.replyLength === 'number'
    )).toBe(true);
    expect(JSON.stringify(all.body)).not.toContain('one');
    expect(JSON.stringify(all.body)).not.toContain('"two"');

    const filtered = await request(app)
      .get('/api/developer/logs?event=chat_reply&level=info')
      .set(authHeader());
    expect(filtered.status).toBe(200);
    expect(filtered.body.count).toBe(2);
    expect(filtered.body.logs.every((log: { event: string; level: string }) =>
      log.event === 'chat_reply' && log.level === 'info'
    )).toBe(true);

    const emptyFilter = await request(app)
      .get('/api/developer/logs?uid=nobody')
      .set(authHeader());
    expect(emptyFilter.body.count).toBe(0);
  });

  it('paginates with the numeric ts cursor', async () => {
    vi.stubEnv('DEVELOPER_UIDS', 'u1');
    primeAuth('u1');
    mockFetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'hi' } }] }));

    for (const message of ['a', 'b', 'c']) {
      await request(app)
        .post('/api/chat')
        .set(authHeader())
        .send({ message, personality: 'Friend' });
    }

    const page1 = await request(app)
      .get('/api/developer/logs?event=chat_reply&limit=2')
      .set(authHeader());
    expect(page1.status).toBe(200);
    expect(page1.body.count).toBe(2);
    expect(page1.body.nextCursor).toBeTypeOf('number');

    const page2 = await request(app)
      .get(`/api/developer/logs?event=chat_reply&limit=2&cursor=${page1.body.nextCursor}`)
      .set(authHeader());
    expect(page2.status).toBe(200);
    expect(page2.body.count).toBe(1);
  });
});
