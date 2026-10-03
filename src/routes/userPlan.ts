import { Response } from 'express';
import { checkAndResetOnly } from '../services/messageService';
import { PLAN_CONFIG, DEFAULT_PLAN, getTrialEligibilityWindowDays } from '../constants';
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
      nextRefreshAt,
      isLimitReached,
      isTrial,
      trialEndsAt,
      trialUsed,
      trialAvailable,
    });
  } catch (error) {
    console.error('User plan error:', error);
    res.status(500).json({ error: 'Failed to fetch plan' });
  }
}
