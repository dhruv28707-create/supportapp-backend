import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { primeAuth, authHeader, resetAll, mockDb } from './setup';

const { createApp } = await import('../src/app');

const app = createApp();

beforeEach(() => {
  resetAll();
});

function seedQuota(count: number) {
  mockDb
    .collection('subscriptions')
    .doc('u1')
    .set({ plan: 'free', messageCount: count, lastResetAt: Date.now(), expiresAt: null }, { merge: false });
}

describe('quota refill visibility (75% rule)', () => {
  it('hides the refill timer for a fresh user', async () => {
    primeAuth('u1');
    seedQuota(1);
    const res = await request(app).get('/api/user/plan').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.messagesUsed).toBe(1);
    expect(res.body.messagesTotal).toBe(20);
    expect(res.body.quotaPercent).toBeCloseTo(0.05);
    expect(res.body.showRefillTimer).toBe(false);
    // Back-compat: nextRefreshAt still present but clients must ignore it.
    expect(typeof res.body.nextRefreshAt).toBe('number');
  });

  it('hides below 75% and shows at/above 75%', async () => {
    primeAuth('u1');
    seedQuota(14);
    const below = await request(app).get('/api/user/plan').set(authHeader());
    expect(below.body.showRefillTimer).toBe(false);

    seedQuota(15);
    const at = await request(app).get('/api/user/plan').set(authHeader());
    expect(at.body.showRefillTimer).toBe(true);
    expect(at.body.quotaPercent).toBeCloseTo(0.75);
  });

  it('always shows when the limit is reached (chat 429 too)', async () => {
    primeAuth('u1');
    seedQuota(20);
    const plan = await request(app).get('/api/user/plan').set(authHeader());
    expect(plan.body.isLimitReached).toBe(true);
    expect(plan.body.showRefillTimer).toBe(true);

    const chat = await request(app)
      .post('/api/chat')
      .set(authHeader())
      .send({ message: 'hi', personality: 'Friend' });
    expect(chat.status).toBe(429);
    expect(chat.body.limitReached).toBe(true);
    expect(chat.body.showRefillTimer).toBe(true);
  });
});
