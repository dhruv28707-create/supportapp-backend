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
    const { plan, messageCount, lastResetAt, isTrial, trialEndsAt, trialUsed } =
      await checkAndResetOnly(uid);

    const limit = PLAN_CONFIG[plan].limit;
    const refreshMs = PLAN_CONFIG[plan].refreshMs;

    const messagesRemaining = Math.max(0, limit - messageCount);
    const nextRefreshAt = lastResetAt + refreshMs;
    const isLimitReached = messageCount >= limit;

    // Refill UX gate: the countdown must NOT appear from the first message.
    // Below 75% usage the timer stays hidden (lobby/chat stay clean); only
    // Settings may show it, and only when showRefillTimer is true.
    // nextRefreshAt is still returned for backward compat — clients must
    // ignore it unless showRefillTimer is true.
    const quotaPercent = getQuotaUsageFraction(messageCount, limit);
    const showRefillTimer = shouldShowRefillTimer(messageCount, limit, isLimitReached);

    // Offer the free-trial CTA only to a free account that has never trialed
    // and is still "new". The account-age check costs one Auth call, so it is
    // skipped entirely for paid and already-trialed users. The trial-start
    // endpoint re-checks authoritatively regardless of what we return here.
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
      // Back-compat: always a number. New clients must gate on showRefillTimer.
      nextRefreshAt,
      isLimitReached,
      isTrial,
      trialEndsAt,
      trialUsed,
      trialAvailable,
      // New quota-UX fields for the 75% refill rule:
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
