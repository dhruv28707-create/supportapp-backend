import { Response } from 'express';
import { checkAndResetOnly } from '../services/messageService';
import { PLAN_CONFIG, PlanType } from '../constants';
import { AuthenticatedRequest } from '../middleware/authMiddleware';

export async function getUserPlanHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
  // uid is always taken from the verified Firebase token — never from the client.
  const uid = req.user!.uid;

  if (!uid) {
    res.status(400).json({ error: 'uid is required' });
    return;
  }

  try {
    const { plan, messageCount, lastResetAt } = await checkAndResetOnly(uid);

    const limit = PLAN_CONFIG[plan].limit;
    const refreshMs = PLAN_CONFIG[plan].refreshMs;

    const messagesRemaining = Math.max(0, limit - messageCount);
    const nextRefreshAt = lastResetAt + refreshMs;
    const isLimitReached = messageCount >= limit;

    res.json({
      plan,
      messagesRemaining,
      nextRefreshAt,
      isLimitReached,
    });
  } catch (error) {
    console.error('User plan error:', error);
    res.status(500).json({ error: 'Failed to fetch plan' });
  }
}