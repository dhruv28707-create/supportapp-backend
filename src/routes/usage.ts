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

/**
 * GET /api/user/usage — quota numbers for the Settings > Usage screen.
 * Same counts as /api/user/plan (kept for compat) plus refill display
 * fields and uiHints telling the app to keep quota UI out of lobby + chat.
 */
export async function getUsageHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
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

    const messagesUsed = Math.max(0, messageCount);
    const messagesRemaining = Math.max(0, limit - messageCount);
    const nextRefreshAt = lastResetAt + refreshMs;
    const isLimitReached = messageCount >= limit;
    const quotaPercent = getQuotaUsageFraction(messageCount, limit);
    const showRefillTimer = shouldShowRefillTimer(messageCount, limit, isLimitReached);
    const refillInMs = Math.max(0, nextRefreshAt - Date.now());

    let trialAvailable = false;
    if (!trialUsed && plan === DEFAULT_PLAN) {
      trialAvailable = await isTrialEligibleByAccountAge(uid);
    }

    res.json({
      plan,
      messagesUsed,
      messagesRemaining,
      messagesTotal: limit,
      quotaPercent,
      nextRefreshAt,
      refillInMs,
      refreshHours: refreshMs / (60 * 60 * 1000),
      isLimitReached,
      showRefillTimer,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      isTrial,
      trialEndsAt,
      trialUsed,
      trialAvailable,
      isDeveloper,
      unlimited,
      uiHints: {
        showQuotaInUsageOnly: true,
        hideQuotaInLobby: true,
        hideQuotaInChat: true,
      },
    });
  } catch (error) {
    console.error('Usage error:', error);
    res.status(500).json({ error: 'Failed to fetch usage' });
  }
}
