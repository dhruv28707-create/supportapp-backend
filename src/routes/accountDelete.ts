import { Response } from 'express';
import { auth } from '../config/firebaseAdmin';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { consumeRateLimit, RateLimitExceededError } from '../services/rateLimitService';
import {
  DeletionBlockedError,
  deleteAccountData,
  getActiveSubscriptionExpiry,
  revokeUserTokens,
} from '../services/accountDeletionService';

const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/**
 * DELETE /api/account
 *
 * Deletes the authenticated user's server-side account data and revokes
 * their Firebase tokens (existing ID tokens stop working within minutes).
 *
 * - Ownership is implied by auth: uid comes from the VERIFIED Firebase ID
 *   token, never from the body/query. There is no way for one user to
 *   delete another user's data.
 * - An active paid subscription blocks deletion (409) — deletion must not
 *   be a way to silently walk away from a paid term. The user must cancel
 *   / let it expire, or contact support for refunds per the app's policy.
 * - Best-effort cleanup: a partial failure is logged but deletion still
 *   proceeds to token revocation, so the account always ends up unusable.
 */
export async function deleteAccountHandler(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const uid = req.user!.uid;

  try {
    await consumeRateLimit(`delete-account:${uid}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      res.status(429).json({ error: 'Too many requests, try again later' });
      return;
    }
    console.error('[delete-account] Rate limit check failed:', error);
  }

  try {
    const activeExpiry = await getActiveSubscriptionExpiry(uid);
    if (activeExpiry) {
      // 409 Conflict: the account has a live paid term. The client should
      // tell the user to cancel first / contact support for refunds.
      res.status(409).json({
        error:
          'Your subscription is still active. Cancel it or contact support before deleting your account.',
        code: 'active_subscription',
        expiresAt: activeExpiry,
      });
      return;
    }

    const summary = await deleteAccountData(uid);

    // Invalidate future API access for this account: revoke refresh tokens
    // so every issued ID token stops verifying within its remaining
    // lifetime (<= ~1h). Done BEFORE the Firebase Auth account deletion so
    // the account is fully unusable even if the next step fails.
    const tokensRevoked = await revokeUserTokens(uid);

    // Best-effort removal of the Firebase Auth account itself. The frontend
    // may have already called currentUser.delete() — that's fine; this is
    // the server-side guarantee that it happened (or that at least the
    // tokens are dead and data is gone).
    let firebaseAuthDeleted = false;
    try {
      await auth.deleteUser(uid);
      firebaseAuthDeleted = true;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'auth/user-not-found') {
        // Already deleted client-side (currentUser.delete()) or never existed.
        firebaseAuthDeleted = true;
      } else {
        console.error(`[delete-account] Firebase Auth delete failed for uid=${uid.slice(0, 8)}:`, error);
      }
    }

    console.log(`[delete-account] Completed for uid=${uid.slice(0, 8)}`, {
      ...summary,
      tokensRevoked,
      firebaseAuthDeleted,
    });

    res.json({
      success: true,
      deleted: {
        subscription: summary.subscriptionDeleted,
        userDoc: summary.userDocDeleted,
        pendingPayments: summary.pendingPaymentsDeleted,
      },
      anonymizedPayments: summary.paymentsAnonymized,
      firebaseAuthDeleted,
    });
  } catch (error) {
    if (error instanceof DeletionBlockedError) {
      res.status(409).json({ error: error.message, expiresAt: error.expiresAt });
      return;
    }
    console.error('[delete-account] Deletion failed:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
}
