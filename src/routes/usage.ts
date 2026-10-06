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

/**
 * GET /api/user/usage — quota numbers for the Settings > Usage screen.
 * Same counts as /api/user/plan (kept for compat) plus refill display
 * fields and uiHints telling the app to keep quota UI out of lobby + chat.
 */
export async function getUsageHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = req.user!.uid;

  try {
    const { plan, messageCount, lastResetAt, isTrial, trialEndsAt, trialUsed } =
      await checkAndResetOnly(uid);

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
      try {
        const record = await auth.getUser(uid);
        const creationTimeMs = Date.parse(record.metadata.creationTime);
        const windowMs = getTrialEligibilityWindowDays() * 24 * 60 * 60 * 1000;
        trialAvailable = !Number.isNaN(creationTimeMs) && Date.now() - creationTimeMs <= windowMs;
      } catch (error) {
        console.error(`[usage] Trial eligibility lookup failed uid=${uid.slice(0, 8)}:`, error);
      }
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
      isTrial,
      trialEndsAt,
      trialUsed,
      trialAvailable,
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
