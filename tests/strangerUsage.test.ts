import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { primeAuth, authHeader, resetAll, mockDb, mockFetch, jsonResponse } from './setup';

const { createApp } = await import('../src/app');

const app = createApp();

beforeEach(() => {
  resetAll();
});

describe('Stranger personality', () => {
  it('is allowed on free plans with anonymity + no-history flags', async () => {
    primeAuth('u1');
    mockFetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'hey, im listening' } }] }));

    const res = await request(app)
      .post('/api/chat')
      .set(authHeader())
      .send({ message: 'just need to vent', personality: 'Stranger' });

    expect(res.status).toBe(200);
    expect(res.body.personality).toBe('Stranger');
    expect(res.body.isStranger).toBe(true);
    expect(res.body.anonymous).toBe(true);
    expect(res.body.storeHistory).toBe(false);
    expect(res.body.noHistory).toBe(true);
    // Quota must be persisted synchronously (regression: fire-and-forget lost it on Vercel).
    expect(mockDb.get('subscriptions/u1')?.messageCount).toBe(1);
  });

  it('ignores religionSubType for Stranger instead of 400', async () => {
    primeAuth('u1');
    mockFetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));

    const res = await request(app)
      .post('/api/chat')
      .set(authHeader())
      .send({ message: 'hi', personality: 'Stranger', religionSubType: 'hindu' });

    expect(res.status).toBe(200);
    expect(res.body.religionSubType).toBeNull();
  });
});

describe('GET /api/user/usage', () => {
  it('returns Usage payload with uiHints and refill fields', async () => {
    primeAuth('u1');
    mockDb
      .collection('subscriptions')
      .doc('u1')
      .set({ plan: 'free', messageCount: 3, lastResetAt: Date.now(), expiresAt: null }, { merge: false });

    const res = await request(app).get('/api/user/usage').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.plan).toBe('free');
    expect(res.body.messagesUsed).toBe(3);
    expect(res.body.messagesRemaining).toBe(17);
    expect(res.body.messagesTotal).toBe(20);
    expect(res.body.showRefillTimer).toBe(false);
    expect(typeof res.body.refillInMs).toBe('number');
    expect(res.body.uiHints).toMatchObject({
      showQuotaInUsageOnly: true,
      hideQuotaInLobby: true,
      hideQuotaInChat: true,
    });
  });

  it('requires auth', async () => {
    const res = await request(app).get('/api/user/usage');
    expect(res.status).toBe(401);
  });
});
