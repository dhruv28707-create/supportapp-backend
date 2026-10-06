import { Response } from 'express';
import { checkAndResetOnly } from '../services/messageService';
import {
  PLAN_CONFIG,
  DEFAULT_PLAN,
  getTrialEligibilityWindowDays,
  getQuotaUsageFraction,
  shouldShowRefillTimer,
} from '../constants';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { auth } from '../config/firebaseAdmin';

export async function getUserPlanHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
  // uid is always taken from the verified Firebase token — never from the client.
  const uid = req.user!.uid;

  try {
    const { plan, messageCount, lastResetAt, expiresAt, isTrial, trialEndsAt, trialUsed } =
      await checkAndResetOnly(uid);

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
    // trial endpoint re-checks regardless of this hint.
    let trialAvailable = false;
    if (!trialUsed && plan === DEFAULT_PLAN) {
      try {
        const record = await auth.getUser(uid);
        const creationTimeMs = Date.parse(record.metadata.creationTime);
        const windowMs = getTrialEligibilityWindowDays() * 24 * 60 * 60 * 1000;
        trialAvailable = !Number.isNaN(creationTimeMs) && Date.now() - creationTimeMs <= windowMs;
      } catch (error) {
        console.error(`[user-plan] Trial eligibility lookup failed uid=${uid.slice(0, 8)}:`, error);
      }
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
    });
  } catch (error) {
    console.error('User plan error:', error);
    res.status(500).json({ error: 'Failed to fetch plan' });
  }
}
