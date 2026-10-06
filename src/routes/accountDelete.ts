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
 * DELETE /api/account — wipes the user's server-side data (subscription,
 * profile, chats, pending orders, rate-limit counters; paid rows anonymized)
 * and revokes Firebase tokens plus the Auth account. An active paid term
 * blocks deletion (409); cancel or let it expire first. Best-effort: partial
 * failures are logged but deletion still proceeds to token revocation.
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

  // The subscription check must never take the request down: on a Firestore
  // failure we log and continue best-effort instead of returning 500.
  let activeExpiry: string | null = null;
  try {
    activeExpiry = await getActiveSubscriptionExpiry(uid);
  } catch (error) {
    console.error(
      `[delete-account] Subscription check failed for uid=${uid.slice(0, 8)}; proceeding best-effort:`,
      error
    );
  }

  if (activeExpiry) {
    res.status(409).json({
      error:
        'Your subscription is still active. Cancel it or contact support before deleting your account.',
      code: 'active_subscription',
      expiresAt: activeExpiry,
    });
    return;
  }

  try {
    const requestStartedAt = Date.now();

    // Revocation is independent of the Firestore wipe — run both at once.
    // (Auth for this request was already verified, so mid-request revocation
    // can't invalidate our own invocation.)
    const dataCleanupPromise = deleteAccountData(uid);
    const tokensRevoked = await revokeUserTokens(uid);
    const summary = await dataCleanupPromise;

    const totalDataMs = Date.now() - requestStartedAt;

    // Loud signal when nothing was removed — usually missing Firestore IAM
    // on the service account (Admin SDK bypasses rules, so this isn't rules).
    if (
      !summary.subscriptionDeleted &&
      !summary.userDocDeleted &&
      summary.pendingPaymentsDeleted === 0 &&
      summary.paymentsAnonymized === 0 &&
      summary.chatsDeleted === 0
    ) {
      console.error(
        `[delete-account] WARNING: no server-side data was removed for uid=${uid.slice(0, 8)}. ` +
          'If the errors above are firestore/permission-denied, grant the service account ' +
          'the Cloud Datastore User role in Google Cloud IAM.'
      );
    }

    // Best-effort Auth account removal. The frontend may have already
    // deleted client-side; user-not-found then counts as success.
    let firebaseAuthDeleted = false;
    try {
      await auth.deleteUser(uid);
      firebaseAuthDeleted = true;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'auth/user-not-found') {
        firebaseAuthDeleted = true;
      } else {
        console.error(`[delete-account] Firebase Auth delete failed for uid=${uid.slice(0, 8)}:`, error);
      }
    }

    console.log(
      `[delete-account] Completed for uid=${uid.slice(0, 8)} in ${Date.now() - requestStartedAt}ms` +
        ` (data wipe ${summary.durationMs}ms)`,
      {
        ...summary,
        tokensRevoked,
        firebaseAuthDeleted,
      }
    );

    res.json({
      success: true,
      deleted: {
        subscription: summary.subscriptionDeleted,
        userDoc: summary.userDocDeleted,
        pendingPayments: summary.pendingPaymentsDeleted,
      },
      anonymizedPayments: summary.paymentsAnonymized,
      chatsDeleted: summary.chatsDeleted,
      chatDocsFailed: summary.chatDocsFailed,
      firebaseAuthDeleted,
      durationMs: totalDataMs,
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
