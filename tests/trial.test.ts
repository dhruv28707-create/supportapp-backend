import { describe, it, expect, beforeEach } from 'vitest';
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
import { TIER_PRICES, ULTIMATE_TRIAL_DAYS } from '../src/constants';

const { createApp } = await import('../src/app');

const app = createApp();

beforeEach(() => {
  resetAll();
});

function oldAccount(daysAgo: number): void {
  mockAuth.getUser.mockResolvedValue({
    uid: 'u1',
    metadata: { creationTime: new Date(Date.now() - daysAgo * 86400000).toISOString() },
  });
}

describe('POST /api/trial/start', () => {
  it('requires auth', async () => {
    const res = await request(app).post('/api/trial/start');
    expect(res.status).toBe(401);
  });

  it('grants 5 days of Ultimate to a new account', async () => {
    primeAuth('u1');

    const res = await request(app).post('/api/trial/start').set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      isTrial: true,
      plan: 'ultimate',
      trialDays: ULTIMATE_TRIAL_DAYS,
    });

    const sub = mockDb.get('subscriptions/u1');
    expect(sub).toMatchObject({
      plan: 'ultimate',
      status: 'active',
      isTrial: true,
      trialUsed: true,
    });
    // Trial end ~5 days out (allow scheduling slack).
    const delta = Number(sub?.expiresAt) - Date.now();
    expect(delta).toBeGreaterThan((ULTIMATE_TRIAL_DAYS * 86400000) - 60000);
    expect(delta).toBeLessThanOrEqual(ULTIMATE_TRIAL_DAYS * 86400000);
  });

  it('unlocks premium personas during the trial', async () => {
    primeAuth('u1');
    mockFetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'hey' } }] }));

    await request(app).post('/api/trial/start').set(authHeader());
    const chat = await request(app)
      .post('/api/chat')
      .set(authHeader())
      .send({ message: 'hi', personality: 'Girlfriend' });

    expect(chat.status).toBe(200);
    expect(chat.body.personality).toBe('Girlfriend');
  });

  it('refuses a second trial (one per account, ever)', async () => {
    primeAuth('u1');
    const first = await request(app).post('/api/trial/start').set(authHeader());
    expect(first.status).toBe(200);

    const second = await request(app).post('/api/trial/start').set(authHeader());
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('trial_already_used');
  });

  it('refuses an account older than the eligibility window', async () => {
    primeAuth('u1');
    oldAccount(30);

    const res = await request(app).post('/api/trial/start').set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('trial_not_eligible');
    expect(mockDb.get('subscriptions/u1')).toBeUndefined();
  });

  it('refuses an account that already has a paid plan', async () => {
    primeAuth('u1');
    mockDb.collection('subscriptions').doc('u1').set(
      { plan: 'pro', status: 'active', expiresAt: Date.now() + 86400000 },
      { merge: false }
    );

    const res = await request(app).post('/api/trial/start').set(authHeader());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('already_subscribed');
  });
});

describe('GET /api/user/plan during a trial', () => {
  it('reports the trial and its end date', async () => {
    primeAuth('u1');
    await request(app).post('/api/trial/start').set(authHeader());

    const res = await request(app).get('/api/user/plan').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ plan: 'ultimate', isTrial: true, trialUsed: true });
    expect(typeof res.body.trialEndsAt).toBe('number');
    // Already trialed -> never offered again.
    expect(res.body.trialAvailable).toBe(false);
  });

  it('downgrades to free when the trial expires, keeping trialUsed', async () => {
    primeAuth('u1');
    mockDb.collection('subscriptions').doc('u1').set(
      {
        plan: 'ultimate',
        status: 'active',
        isTrial: true,
        trialUsed: true,
        expiresAt: Date.now() - 1000,
        messageCount: 5,
        lastResetAt: Date.now(),
      },
      { merge: false }
    );

    const res = await request(app).get('/api/user/plan').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.plan).toBe('free');
    expect(res.body.isTrial).toBe(false);
    expect(res.body.trialUsed).toBe(true);

    const sub = mockDb.get('subscriptions/u1');
    expect(sub).toMatchObject({ plan: 'free', isTrial: false, trialUsed: true });
  });
});

describe('GET /api/plans (choice cards)', () => {
  it('returns free + Pro + Ultimate tiers, priced from TIER_PRICES', async () => {
    const res = await request(app).get('/api/plans');
    expect(res.status).toBe(200);
    expect(res.body.currency).toBe('INR');

    const byId = Object.fromEntries(
      (res.body.options as Array<{ id: string; amountPaise: number; plan: string }>).map((o) => [o.id, o])
    );
    expect(Object.keys(byId).sort()).toEqual(['free', 'pro_monthly', 'pro_yearly', 'ultimate_monthly', 'ultimate_yearly']);
    expect(byId.free.amountPaise).toBe(0);
    expect(byId.pro_monthly.amountPaise).toBe(TIER_PRICES.pro_monthly);
    expect(byId.pro_yearly.amountPaise).toBe(TIER_PRICES.pro_yearly);
    expect(byId.ultimate_monthly.amountPaise).toBe(TIER_PRICES.ultimate_monthly);
    expect(byId.ultimate_yearly.amountPaise).toBe(TIER_PRICES.ultimate_yearly);
  });
});

describe('trial interaction with cancel and deletion', () => {
  it('lets the user cancel a trial early, keeping trialUsed', async () => {
    primeAuth('u1');
    await request(app).post('/api/trial/start').set(authHeader());

    const res = await request(app).post('/api/payment-cancel').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Subscription cancelled');

    expect(mockDb.get('subscriptions/u1')).toMatchObject({
      plan: 'free',
      status: 'cancelled',
      isTrial: false,
      trialUsed: true,
    });
  });

  it('allows account deletion while a trial is active', async () => {
    primeAuth('u1');
    await request(app).post('/api/trial/start').set(authHeader());

    const res = await request(app).delete('/api/account').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockDb.get('subscriptions/u1')).toBeUndefined();
  });
});

describe('durable trial guard (anti-churn)', () => {
  it('writes uid-keyed and email-keyed guards on grant', async () => {
    primeAuth('u1', 'churn@test.dev');
    const res = await request(app).post('/api/trial/start').set(authHeader());
    expect(res.status).toBe(200);

    expect(mockDb.get(`trialGuards/uid_u1`)).toMatchObject({ trialUsed: true });
    const guardPaths = mockDb.paths().filter((p) => p.startsWith('trialGuards/email_'));
    expect(guardPaths.length).toBe(1);
    expect(mockDb.get(guardPaths[0])).toMatchObject({ trialUsed: true, uid: 'u1' });
  });

  it('blocks a trial after account deletion + same-email re-signup', async () => {
    primeAuth('u1', 'churn@test.dev');
    await request(app).post('/api/trial/start').set(authHeader());
    await request(app).post('/api/payment-cancel').set(authHeader());
    await request(app).delete('/api/account').set(authHeader());

    // Simulate the churn cycle: subscriptions doc wiped, Auth record deleted,
    // same email signs up again as a brand-new uid with a fresh creationTime.
    primeAuth('u2', 'churn@test.dev');
    const res = await request(app).post('/api/trial/start').set(authHeader());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('trial_already_used');
    // Hint state is repaired so trialAvailable can never lie either.
    expect(mockDb.get('subscriptions/u2')).toMatchObject({ trialUsed: true });
  });

  it('guards survive deletion and backfill legacy accounts', async () => {
    // Legacy account: trialUsed predates the durable guard ledger.
    primeAuth('u1', 'legacy@test.dev');
    mockDb.collection('subscriptions').doc('u1').set(
      { plan: 'free', trialUsed: true, trialEndsAt: Date.now() - 24 * 3600e3 },
      { merge: true }
    );
    let res = await request(app).post('/api/trial/start').set(authHeader());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('trial_already_used');
    expect(mockDb.get('trialGuards/uid_u1')).toMatchObject({ trialUsed: true });

    // Partial state: email-keyed guard exists but uid guard is gone —
    // any leftover gap is sealed and the trial is still refused.
    primeAuth('u2', 'legacy@test.dev');
    res = await request(app).post('/api/trial/start').set(authHeader());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('trial_already_used');
  });

  it('does not leak the trial-guard window across different emails', async () => {
    primeAuth('u1', 'a@test.dev');
    expect((await request(app).post('/api/trial/start').set(authHeader())).status).toBe(200);

    primeAuth('u2', 'b@test.dev');
    expect((await request(app).post('/api/trial/start').set(authHeader())).status).toBe(200);
  });
});

describe('trial eligibility hint caching (no Identity Toolkit call per request)', () => {
  it('caches the immutable creationTime after the first lookup and reuses it', async () => {
    primeAuth('u1');

    const first = await request(app).get('/api/user/plan').set(authHeader());
    expect(first.status).toBe(200);
    expect(first.body.trialAvailable).toBe(true);
    // Exactly one Auth read, then the value is cached server-side in the
    // client-untouchable subscriptions doc.
    expect(mockAuth.getUser).toHaveBeenCalledTimes(1);
    expect(mockDb.get('subscriptions/u1')!.authCreatedAt).toEqual(expect.any(Number));

    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/api/user/plan').set(authHeader());
      expect(res.body.trialAvailable).toBe(true);
    }
    // Hammering the plan endpoint never calls auth.getUser again.
    expect(mockAuth.getUser).toHaveBeenCalledTimes(1);
  });

  it('keeps reporting ineligible for old accounts (cached negatives stay safe)', async () => {
    primeAuth('u1');
    mockAuth.getUser.mockResolvedValue({
      uid: 'u1',
      metadata: { creationTime: new Date(Date.now() - 30 * 86400000).toISOString() },
    });

    const first = await request(app).get('/api/user/plan').set(authHeader());
    expect(first.body.trialAvailable).toBe(false);
    expect(mockAuth.getUser).toHaveBeenCalledTimes(1);

    const second = await request(app).get('/api/user/plan').set(authHeader());
    expect(second.body.trialAvailable).toBe(false);
    expect(mockAuth.getUser).toHaveBeenCalledTimes(1);
  });

  it('is never eligible when the account cannot be resolved', async () => {
    primeAuth('u1');
    mockAuth.getUser.mockRejectedValue(new Error('identity toolkit exhausted'));

    const res = await request(app).get('/api/user/plan').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.trialAvailable).toBe(false);
  });

  it('dedupes a concurrent burst of lookups for the same uid to one Auth call', async () => {
    primeAuth('u1');
    // Slow the Auth mock so all requests overlap while in-flight.
    mockAuth.getUser.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { uid: 'u1', metadata: { creationTime: new Date().toISOString() } };
    });

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => request(app).get('/api/user/plan').set(authHeader()))
    );
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(mockAuth.getUser).toHaveBeenCalledTimes(1);
  });
});
