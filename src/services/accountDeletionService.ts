import { db } from '../config/firebaseAdmin';
import { auth } from '../config/firebaseAdmin';
import { SUBSCRIPTIONS_COLLECTION, PAYMENTS_COLLECTION } from './subscriptionService';
import { RATE_LIMITS_COLLECTION } from './rateLimitService';

/**
 * Account deletion — server-side path.
 *
 * Policy implemented here:
 *  - The requester must be the authenticated owner (uid comes from the
 *    verified Firebase ID token; there is no admin override path here).
 *  - An ACTIVE paid subscription blocks deletion (HTTP 409) so deletion
 *    cannot be used to silently walk away from a paid term. The user must
 *    cancel / let it expire first (contact support for refunds per the
 *    app's stated policy).
 *  - Otherwise: server-side data (subscriptions, rate-limit counters, the
 *    users/{uid} profile doc, and any pending payment records owned by the
 *    user) is deleted. Paid payment history rows are NOT deleted — they are
 *    financial records; instead the uid is redacted to keep the row
 *    attributable to a payment without pointing at a live account.
 *  - Finally the user's Firebase refresh tokens are revoked, which
 *    invalidates all existing ID tokens within ~minutes (the max ID-token
 *    lifetime), cutting off future API access even for copied tokens.
 */

export class DeletionBlockedError extends Error {
  constructor(public readonly expiresAt: string) {
    super('Active subscription blocks account deletion');
    this.name = 'DeletionBlockedError';
  }
}

export interface DeletionSummary {
  subscriptionDeleted: boolean;
  userDocDeleted: boolean;
  pendingPaymentsDeleted: number;
  paymentsAnonymized: number;
}

/** Deletes or anonymizes all server-side data tied to the user. */
export async function deleteAccountData(uid: string): Promise<DeletionSummary> {
  const summary: DeletionSummary = {
    subscriptionDeleted: false,
    userDocDeleted: false,
    pendingPaymentsDeleted: 0,
    paymentsAnonymized: 0,
  };

  // 1) Subscription state (server-only quota/plan doc).
  try {
    await db.collection(SUBSCRIPTIONS_COLLECTION).doc(uid).delete();
    summary.subscriptionDeleted = true;
  } catch (error) {
    console.error(
      `[delete-account] Failed to delete subscription for uid=${uid.slice(0, 8)}:`,
      error
    );
  }

  // 2) users/{uid} profile doc (client-visible profile; safe to remove).
  try {
    await db.collection('users').doc(uid).delete();
    summary.userDocDeleted = true;
  } catch (error) {
    console.error(`[delete-account] Failed to delete user doc for uid=${uid.slice(0, 8)}:`, error);
  }

  // 3) Payment records owned by the user.
  try {
    const payments = await db.collection(PAYMENTS_COLLECTION).where('uid', '==', uid).get();

    const batch = db.batch();
    let ops = 0;
    for (const doc of payments.docs) {
      const data = doc.data() || {};
      if (data.status === 'paid') {
        // Financial record: anonymize instead of delete.
        batch.set(
          doc.ref,
          {
            uid: `deleted:${uid.slice(0, 8)}`,
            deletedAt: new Date(),
          },
          { merge: true }
        );
        summary.paymentsAnonymized += 1;
      } else {
        // Pending/failed orders: delete outright.
        batch.delete(doc.ref);
        summary.pendingPaymentsDeleted += 1;
      }
      ops += 1;
      if (ops >= 400) {
        // Firestore batches cap at 500 ops; stay safely under it.
        await batch.commit();
        ops = 0;
      }
    }
    if (ops > 0) await batch.commit();
  } catch (error) {
    console.error(`[delete-account] Payment cleanup failed for uid=${uid.slice(0, 8)}:`, error);
  }

  // 4) Rate-limit counters (no personal content, but tied to the uid key).
  try {
    const limits = await db.collection(RATE_LIMITS_COLLECTION).get();
    // The rateLimits docs are keyed like "chat:<uid>"; delete only this
    // user's docs without touching anyone else's.
    const batch = db.batch();
    let ops = 0;
    const prefixes = ['chat:', 'payment-order:', 'payment-verify:'].map((p) => `${p}${uid}`);
    for (const doc of limits.docs) {
      if (!prefixes.some((p) => doc.id.startsWith(p))) continue;
      batch.delete(doc.ref);
      ops += 1;
      if (ops >= 400) {
        await batch.commit();
        ops = 0;
      }
    }
    if (ops > 0) await batch.commit();
  } catch (error) {
    console.error(`[delete-account] Rate limit cleanup failed for uid=${uid.slice(0, 8)}:`, error);
  }

  return summary;
}

/** Revokes all of the user's refresh tokens so existing ID tokens die within minutes. */
export async function revokeUserTokens(uid: string): Promise<boolean> {
  try {
    await auth.revokeRefreshTokens(uid);
    return true;
  } catch (error) {
    // A user that never signed in through a token flow may not exist in Auth;
    // deletion of the data should still succeed.
    console.error(`[delete-account] Token revocation failed for uid=${uid.slice(0, 8)}:`, error);
    return false;
  }
}

/**
 * Checks whether the user has an active paid subscription that blocks
 * deletion. Returns the ISO expiry string when blocked, else null.
 */
export async function getActiveSubscriptionExpiry(uid: string): Promise<string | null> {
  const snap = await db.collection(SUBSCRIPTIONS_COLLECTION).doc(uid).get();
  if (!snap.exists) return null;

  const data = snap.data() || {};
  if (!data.plan || data.plan === 'free') return null;

  const expires = data.expiresAt;
  let expiresMs: number | null = null;
  if (expires instanceof Date) expiresMs = expires.getTime();
  else if (typeof expires === 'number') expiresMs = expires;
  else if (expires && typeof (expires as { toDate?: unknown }).toDate === 'function') {
    const d = (expires as { toDate: () => Date }).toDate();
    if (d instanceof Date) expiresMs = d.getTime();
  } else if (typeof expires === 'string') {
    const parsed = Date.parse(expires);
    expiresMs = Number.isNaN(parsed) ? null : parsed;
  }

  if (expiresMs === null || expiresMs <= Date.now()) return null;
  return new Date(expiresMs).toISOString();
}
