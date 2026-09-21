import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetAll, mockDb, primeAuth, authHeader } from './setup';

const { consumeRateLimit, RateLimitExceededError } = await import('../src/services/rateLimitService');
const { consumeMessage, getPlanState, invalidatePlanCache } = await import(
  '../src/services/messageService'
);
const { enforceChatIpThrottle, CHAT_IP_RATE_LIMIT_MAX } = await import(
  '../src/services/chatClientThrottle'
);

beforeEach(() => {
  resetAll();
});

describe('rateLimitService (Fix #1: no transaction contention)', () => {
  it('allows up to max requests then throws with retryAfterMs', async () => {
    for (let i = 0; i < 3; i++) {
      await consumeRateLimit('chat:u1', 3, 60000);
    }
    const err = await consumeRateLimit('chat:u1', 3, 60000).catch((e: Error) => e);
    expect(err).toBeInstanceOf(RateLimitExceededError);
    expect((err as unknown as { retryAfterMs: number }).retryAfterMs).toBeLessThanOrEqual(60000);
  });

  it('resets the window after it expires', async () => {
    for (let i = 0; i < 3; i++) {
      await consumeRateLimit('chat:u1', 3, 60000);
    }
    const doc = mockDb.get('rateLimits/chat:u1');
    mockDb.set('rateLimits/chat:u1', { ...doc, windowStart: Date.now() - 61000 }, false);
    await consumeRateLimit('chat:u1', 3, 60000);
    expect(mockDb.get('rateLimits/chat:u1')!.count).toBe(1);
  });

  it('fails open when the store errors', async () => {
    const spy = vi.spyOn(mockDb, 'collection').mockImplementation(() => {
      throw new Error('store down');
    });
    const result = await consumeRateLimit('chat:u1', 3, 60000);
    expect(result).toEqual({ count: 0, windowStart: 0 });
    spy.mockRestore();
  });
});

describe('messageService quota (Fix #1: atomic increment)', () => {
  it('consumeMessage increments and enforces the plan limit', async () => {
    mockDb.collection('subscriptions').doc('u1').set(
      { plan: 'pro', messageCount: 79, lastResetAt: Date.now() - 1000, expiresAt: null },
      { merge: false }
    );

    await consumeMessage('u1');
    expect(mockDb.get('subscriptions/u1')!.messageCount).toBe(80);
    expect(mockDb.get('subscriptions/u1')!.plan).toBe('pro');

    await expect(consumeMessage('u1')).rejects.toMatchObject({ name: 'LimitReachedError' });
  });

  it('persists an expiry downgrade to free on the next consume', async () => {
    mockDb.collection('subscriptions').doc('u1').set(
      { plan: 'ultimate', messageCount: 1, lastResetAt: Date.now() - 1000, expiresAt: Date.now() - 10 },
      { merge: false }
    );
    await consumeMessage('u1');
    expect(mockDb.get('subscriptions/u1')!.plan).toBe('free');
    expect(mockDb.get('subscriptions/u1')!.expiresAt).toBeNull();
  });

  it('refreshes lastResetAt when the window rolls over during consume', async () => {
    const old = Date.now() - 10 * 60 * 60 * 1000; // 10h ago — beyond any plan window
    mockDb.collection('subscriptions').doc('u1').set(
      { plan: 'free', messageCount: 20, lastResetAt: old, expiresAt: null },
      { merge: false }
    );
    await consumeMessage('u1');
    const after = mockDb.get('subscriptions/u1')!;
    expect(after.messageCount).toBe(1); // reset to 0, then incremented
    expect(after.lastResetAt).toBeGreaterThan(old);
  });
});

describe('plan TTL cache (Fix #1)', () => {
  it('serves repeated reads from cache and reflects writes after invalidation', async () => {
    mockDb.collection('subscriptions').doc('u1').set(
      { plan: 'free', messageCount: 0, lastResetAt: Date.now(), expiresAt: null },
      { merge: false }
    );

    const first = await getPlanState('u1');
    expect(first.plan).toBe('free');

    // External write (e.g. payment grant) — without invalidation the cache
    // would serve stale data for the rest of the TTL.
    mockDb.collection('subscriptions').doc('u1').set(
      { plan: 'pro', messageCount: 0, lastResetAt: Date.now(), expiresAt: null },
      { merge: true }
    );
    const stale = await getPlanState('u1');
    expect(stale.plan).toBe('free'); // still cached

    invalidatePlanCache('u1');
    const fresh = await getPlanState('u1');
    expect(fresh.plan).toBe('pro');
  });
});

describe('per-IP chat throttle (Fix #3)', () => {
  it('blocks requests past the per-IP budget within the window', async () => {
    for (let i = 0; i < CHAT_IP_RATE_LIMIT_MAX; i++) {
      await enforceChatIpThrottle('1.2.3.4');
    }
    const err = await enforceChatIpThrottle('1.2.3.4').catch((e: Error) => e);
    expect(err).toBeInstanceOf(RateLimitExceededError);
    // Different IP unaffected.
    await expect(enforceChatIpThrottle('5.6.7.8')).resolves.toBeUndefined();
  });

  it('hashes IPs into doc ids (no raw IPs stored)', async () => {
    await enforceChatIpThrottle('9.9.9.9');
    const paths = mockDb.paths().filter((p) => p.startsWith('ipLimits/'));
    expect(paths.length).toBe(1);
    expect(paths[0]).not.toContain('9.9.9.9');
  });
});

describe('deletion purge pagination (Fix #4)', () => {
  it('wipes more than one page of chat docs for the user', async () => {
    const request = (await import('supertest')).default;
    const { createApp } = await import('../src/app');

    primeAuth('u1');
    // 450 chat docs — more than one 400-doc page.
    for (let i = 0; i < 450; i++) {
      mockDb.collection('chats').doc(`c${i}`).set({ uid: 'u1', text: `m${i}` }, { merge: false });
    }
    // Another user's chats must survive.
    mockDb.collection('chats').doc('other').set({ uid: 'u2', text: 'keep' }, { merge: false });

    const app = createApp();
    const res = await request(app).delete('/api/account').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.chatsDeleted).toBe(450);
    const remaining = mockDb.docsIn('chats');
    expect(remaining.length).toBe(1);
    expect(remaining[0].id).toBe('other');
  });

  it('paginates payments cleanup too (anonymize paid, delete pending)', async () => {
    const request = (await import('supertest')).default;
    const { createApp } = await import('../src/app');

    primeAuth('u1');
    for (let i = 0; i < 500; i++) {
      mockDb.collection('payments').doc(`o${i}`).set(
        { uid: 'u1', tier: 'pro_monthly', status: i % 2 === 0 ? 'paid' : 'pending', amount: 17900 },
        { merge: false }
      );
    }

    const app = createApp();
    const res = await request(app).delete('/api/account').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.anonymizedPayments).toBe(250);
    expect(res.body.deleted.pendingPayments).toBe(250);
  });
});
