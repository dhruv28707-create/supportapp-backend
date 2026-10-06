import { Response } from 'express';
import { auth } from '../config/firebaseAdmin';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { consumeRateLimit, RateLimitExceededError } from '../services/rateLimitService';
import { enforceTrialIpThrottle } from '../services/chatClientThrottle';
import { extractClientIp } from '../utils/request';
import {
  startUltimateTrial,
  TrialNotAllowedError,
} from '../services/subscriptionService';
import {
  ULTIMATE_TRIAL_DAYS,
  TRIAL_PLAN,
  getTrialEligibilityWindowDays,
} from '../constants';

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

/**
 * POST /api/trial/start — 5-day Ultimate free trial for new accounts only.
 * Auth required; uid comes from the verified token. New-account check uses
 * the Auth record (not client-writable docs); one-trial-per-account is
 * enforced transactionally. No payment involved.
 */
export async function trialStartHandler(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const uid = req.user!.uid;

  // Per-uid backstop against hammering.
  try {
    await consumeRateLimit(`trial-start:${uid}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      res.status(429).json({ error: 'Too many requests, try again later' });
      return;
    }
    console.error(`[trial-start] Rate limit check failed (allowing request) uid=${uid.slice(0, 8)}:`, error);
  }

  // Per-IP cap: per-uid limits alone can't stop one script farming trials
  // across fresh accounts from a single address.
  const ip = extractClientIp(req);
  if (ip) {
    try {
      await enforceTrialIpThrottle(ip);
    } catch (error) {
      if (error instanceof RateLimitExceededError) {
        res.status(429).json({ error: 'Too many requests, try again later' });
        return;
      }
      console.error(`[trial-start] IP throttle check failed (allowing request) uid=${uid.slice(0, 8)}:`, error);
    }
  }

  // --- New-accounts-only gate, from the authoritative Auth record ----------
  let creationTimeMs: number;
  try {
    const record = await auth.getUser(uid);
    creationTimeMs = Date.parse(record.metadata.creationTime);
  } catch (error) {
    console.error(`[trial-start] Failed to load auth record for uid=${uid.slice(0, 8)}:`, error);
    res.status(500).json({ error: 'Failed to start trial' });
    return;
  }

  const windowMs = getTrialEligibilityWindowDays() * 24 * 60 * 60 * 1000;
  if (Number.isNaN(creationTimeMs) || Date.now() - creationTimeMs > windowMs) {
    res.status(403).json({
      error: 'Free trial is only available to new accounts',
      code: 'trial_not_eligible',
    });
    return;
  }

  // --- Grant (transactional one-trial guard) -------------------------------
  try {
    const grant = await startUltimateTrial(uid);

    console.log(`[trial-start] Ultimate trial granted uid=${uid.slice(0, 8)} for ${ULTIMATE_TRIAL_DAYS} days`);

    res.status(200).json({
      success: true,
      isTrial: true,
      plan: grant.plan,
      trialDays: ULTIMATE_TRIAL_DAYS,
      startedAt: new Date(grant.startedAt).toISOString(),
      trialEndsAt: new Date(grant.expiresAt).toISOString(),
      expiresAt: new Date(grant.expiresAt).toISOString(),
    });
  } catch (error) {
    if (error instanceof TrialNotAllowedError) {
      res.status(409).json({
        error: error.message,
        code: error.code,
        // Let the client jump straight to the choice cards.
        plan: TRIAL_PLAN,
      });
      return;
    }
    console.error(`[trial-start] Trial grant failed for uid=${uid.slice(0, 8)}:`, error);
    res.status(500).json({ error: 'Failed to start trial' });
  }
}
