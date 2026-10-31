import { Response } from 'express';
import { checkAndResetOnly } from '../services/messageService';
import { isTrialEligibleByAccountAge } from '../services/trialEligibilityService';
import {
  PLAN_CONFIG,
  DEFAULT_PLAN,
  getQuotaUsageFraction,
  shouldShowRefillTimer,
} from '../constants';
import { AuthenticatedRequest } from '../middleware/authMiddleware';

export async function getUserPlanHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
  // uid is always taken from the verified Firebase token — never from the client.
  const uid = req.user!.uid;

  try {
    const {
      plan,
      messageCount,
      lastResetAt,
      expiresAt,
      isTrial,
      trialEndsAt,
      trialUsed,
      isDeveloper,
      unlimited,
    } = await checkAndResetOnly(uid, req.user!.developer === true);

    const limit = PLAN_CONFIG[plan].limit;
    const refreshMs = PLAN_CONFIG[plan].refreshMs;

    const messagesRemaining = Math.max(0, limit - messageCount);
    const nextRefreshAt = lastResetAt + refreshMs;
    const isLimitReached = messageCount >= limit;

    // Refill UX gate (75% rule): nextRefreshAt is always returned, but
    // clients only show the countdown when showRefillTimer is true.
    const quotaPercent = getQuotaUsageFraction(messageCount, limit);
    const showRefillTimer = shouldShowRefillTimer(messageCount, limit, isLimitReached);

    // Trial CTA hint only for free, never-trialed, still-new accounts. The
    // trial endpoint re-checks regardless of this hint. Account age comes
    // from a server-only cache of the immutable creationTime — no Identity
    // Toolkit call per request.
    let trialAvailable = false;
    if (!trialUsed && plan === DEFAULT_PLAN) {
      trialAvailable = await isTrialEligibleByAccountAge(uid);
    }

    res.json({
      plan,
      messagesRemaining,
      nextRefreshAt,
      refillInMs: Math.max(0, nextRefreshAt - Date.now()),
      refreshHours: refreshMs / (60 * 60 * 1000),
      isLimitReached,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      isTrial,
      trialEndsAt,
      trialUsed,
      trialAvailable,
      messagesUsed: Math.max(0, messageCount),
      messagesTotal: limit,
      quotaPercent,
      showRefillTimer,
      isDeveloper,
      unlimited,
    });
  } catch (error) {
    console.error('User plan error:', error);
    res.status(500).json({ error: 'Failed to fetch plan' });
  }
}
