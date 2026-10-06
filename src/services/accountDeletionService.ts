import { db } from '../config/firebaseAdmin';
import { auth } from '../config/firebaseAdmin';
import {
  SUBSCRIPTIONS_COLLECTION,
  PAYMENTS_COLLECTION,
  normalizeStatus,
} from './subscriptionService';
import { RATE_LIMITS_COLLECTION } from './rateLimitService';
import {
  CHAT_STORAGE_SHAPES,
  USER_DATA_FIELD_HINTS,
  getChatCollectionsOverride,
  listUserDocSubcollections,
} from './chatHistoryDiscovery';

/**
 * Account deletion (server-side). Active paid terms block deletion (409);
 * otherwise wipes subscriptions, profile, chats, pending orders (paid rows
 * anonymized), and rate-limit counters, then revokes tokens. Paid rows are
 * kept as anonymized financial records. Independent steps run in parallel
 * to stay under mobile client timeouts.
 */

/** Per-probe budget for chat-layout discovery (covers full paginated delete). */
const PROBE_TIMEOUT_MS = 30000;

/** Docs fetched per query page during payment cleanup. */
const PAYMENTS_PAGE_SIZE = 400;

/** Rejects if the underlying promise has not settled within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`probe timeout after ${ms}ms (${label})`)),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

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
  chatsDeleted: number;
  chatDocsFailed: number;
  /** Wall-clock duration of the data wipe, for latency monitoring in prod logs. */
  durationMs: number;
}

/** Deletes or anonymizes all server-side data tied to the user. */
export async function deleteAccountData(uid: string): Promise<DeletionSummary> {
  // Re-check inside the wipe path: a grant racing the route's 409 check must
  // still block instead of wiping an active payer.
  const activeExpiry = await getActiveSubscriptionExpiry(uid);
  if (activeExpiry) {
    throw new DeletionBlockedError(activeExpiry);
  }

  const summary: DeletionSummary = {
    subscriptionDeleted: false,
    userDocDeleted: false,
    pendingPaymentsDeleted: 0,
    paymentsAnonymized: 0,
    chatsDeleted: 0,
    chatDocsFailed: 0,
    durationMs: 0,
  };
  const startedAt = Date.now();

  // 1) Subscription doc. Check existence so the summary stays accurate.
  const deleteSubscription = (async () => {
    try {
      const snap = await db.collection(SUBSCRIPTIONS_COLLECTION).doc(uid).get();
      if (!snap.exists) return;
      await db.collection(SUBSCRIPTIONS_COLLECTION).doc(uid).delete();
      summary.subscriptionDeleted = true;
    } catch (error) {
      console.error(
        `[delete-account] Failed to delete subscription for uid=${uid.slice(0, 8)}:`,
        error
      );
    }
  })();

  // 2) users/{uid} profile doc (client-visible profile; safe to remove).
  const deleteUserDoc = (async () => {
    try {
      const snap = await db.collection('users').doc(uid).get();
      if (!snap.exists) return;
      await db.collection('users').doc(uid).delete();
      summary.userDocDeleted = true;
    } catch (error) {
      console.error(`[delete-account] Failed to delete user doc for uid=${uid.slice(0, 8)}:`, error);
    }
  })();

  // 3) Payment records owned by the user (paginated, fresh batch per page —
  // committed batches can't be reused and uncommitted trailing ops persist
  // nothing).
  const cleanupPayments = (async () => {
    for (;;) {
      const payments = await db
        .collection(PAYMENTS_COLLECTION)
        .where('uid', '==', uid)
        .limit(PAYMENTS_PAGE_SIZE)
        .get();
      if (payments.empty) break;

      const batch = db.batch();
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
      }
      await batch.commit();
      if (payments.size < PAYMENTS_PAGE_SIZE) break;
    }
  })().catch((error) => {
    console.error(`[delete-account] Payment cleanup failed for uid=${uid.slice(0, 8)}:`, error);
  });

  // 4) Chat history (server-side purge; clients can't do this themselves —
  // rules deny it). Layout auto-discovered; CHAT_COLLECTIONS overrides.
  const cleanupChats = deleteChatHistory(uid)
    .then(({ docsDeleted, docsFailed }) => {
      summary.chatsDeleted = docsDeleted;
      summary.chatDocsFailed = docsFailed;
    })
    .catch((error) => {
      console.error(`[delete-account] Chat history cleanup failed for uid=${uid.slice(0, 8)}:`, error);
    });

  // 5) Rate-limit counters keyed by uid.
  const cleanupRateLimits = cleanupRateLimitCounters(uid).catch((error) => {
    console.error(`[delete-account] Rate limit cleanup failed for uid=${uid.slice(0, 8)}:`, error);
  });

  // Independent phases — run concurrently. Each already catches its own
  // errors (best-effort).
  await Promise.all([
    deleteSubscription,
    deleteUserDoc,
    cleanupPayments,
    cleanupChats,
    cleanupRateLimits,
  ]);

  summary.durationMs = Date.now() - startedAt;
  return summary;
}

/**
 * Rate-limit counters are keyed by uid (`chat:<uid>`, ...), so they delete
 * directly without scanning the collection.
 */
async function cleanupRateLimitCounters(uid: string): Promise<void> {
  const prefixes = [
    'chat:',
    'payment-order:',
    'payment-verify:',
    'payment-cancel:',
    'delete-account:',
    'trial-start:',
  ];

  const batch = db.batch();
  for (const prefix of prefixes) {
    batch.delete(db.collection(RATE_LIMITS_COLLECTION).doc(`${prefix}${uid}`));
  }
  await batch.commit();
}

/**
 * Deletes the user's chat history across well-known shapes (see
 * chatHistoryDiscovery.ts). Best-effort: failures are counted, never thrown.
 * Probes run concurrently with per-probe timeouts.
 */
async function deleteChatHistory(uid: string): Promise<{ docsDeleted: number; docsFailed: number }> {
  const startedAt = Date.now();
  let docsDeleted = 0;
  let docsFailed = 0;

  const batchDeleteDocs = async (refs: FirebaseFirestore.DocumentReference[]) => {
    let batch = db.batch();
    let ops = 0;
    for (const ref of refs) {
      batch.delete(ref);
      ops += 1;
      if (ops >= 400) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
    if (ops > 0) await batch.commit();
  };

  /**
   * Deletes every doc matching `query` via paged reads. Bounded (400/page,
   * 25 pages max) so residual data is reported instead of looping past the
   * function budget.
   */
  async function deleteChatDocsByQuery(
    query: FirebaseFirestore.Query
  ): Promise<number> {
    const PAGE_SIZE = 400;
    let deleted = 0;
    const MAX_PAGES = 25;
    for (let page = 0; page < MAX_PAGES; page++) {
      const snap = await query.limit(PAGE_SIZE).get();
      if (snap.empty) break;
      await batchDeleteDocs(snap.docs.map((d) => d.ref));
      deleted += snap.size;
      if (snap.size < PAGE_SIZE) break;
      if (page === MAX_PAGES - 1) {
        throw new Error(`purge page cap reached (${MAX_PAGES} pages) — residual data may remain`);
      }
    }
    return deleted;
  }

  try {
    const override = getChatCollectionsOverride();
    const topLevelCandidates: readonly string[] =
      override.length > 0 ? override : CHAT_STORAGE_SHAPES.UID_FIELD_COLLECTIONS;

    // Shape A: top-level collection with an owner uid field per doc.
    const shapeAProbes = topLevelCandidates.flatMap((collection) =>
      USER_DATA_FIELD_HINTS.map((field) =>
        withTimeout(
          deleteChatDocsByQuery(db.collection(collection).where(field, '==', uid)),
          PROBE_TIMEOUT_MS,
          `${collection}.${field}`
        )
          .then((deleted) => {
            if (deleted > 0) {
              docsDeleted += deleted;
              console.log(
                `[delete-account] Chat purge: ${deleted} doc(s) from ${collection} (uid field: ${field})`
              );
            }
          })
          .catch((error) => {
            // Unknown collection / missing index — expected for shapes the
            // app doesn't use; log and continue.
            docsFailed += 1;
            console.error(
              `[delete-account] Chat purge probe failed on ${collection}.${field}:`,
              error instanceof Error ? error.message : error
            );
          })
      )
    );

    // Shape B: one document per user holding the whole conversation.
    const shapeBProbes = CHAT_STORAGE_SHAPES.PER_USER_DOC_COLLECTIONS.map((collection) =>
      withTimeout(
        db.collection(collection)
          .doc(uid)
          .get()
          .then(async (snap) => {
            if (!snap.exists) return 0;
            await batchDeleteDocs([db.collection(collection).doc(uid)]);
            return 1;
          }),
        PROBE_TIMEOUT_MS,
        `${collection}/${uid}`
      )
        .then((deleted) => {
          docsDeleted += deleted;
          if (deleted > 0) {
            console.log(`[delete-account] Chat purge: per-user doc ${collection}/${uid}`);
          }
        })
        .catch((error) => {
          docsFailed += 1;
          console.error(
            `[delete-account] Chat purge per-user-doc failed on ${collection}:`,
            error instanceof Error ? error.message : error
          );
        })
    );

    // Shape C: subcollections under users/{uid} (e.g. users/{uid}/messages).
    const shapeCProbe = withTimeout(
      listUserDocSubcollections(uid),
      PROBE_TIMEOUT_MS,
      'users/{uid} subcollections'
    )
      .then(async (subcollections) => {
        const knownChatSubs = CHAT_STORAGE_SHAPES.USER_DOC_SUBCOLLECTIONS as readonly string[];
        const subProbes = subcollections
          .filter((sub) => knownChatSubs.includes(sub))
          .map((sub) =>
            withTimeout(
              deleteChatDocsByQuery(db.collection('users').doc(uid).collection(sub)),
              PROBE_TIMEOUT_MS,
              `users/{uid}/${sub}`
            )
              .then((deleted) => {
                docsDeleted += deleted;
                if (deleted > 0) {
                  console.log(
                    `[delete-account] Chat purge: ${deleted} doc(s) from users/{uid}/${sub}`
                  );
                }
              })
              .catch((error) => {
                docsFailed += 1;
                console.error(
                  `[delete-account] Chat purge subcollection failed on users/{uid}/${sub}:`,
                  error instanceof Error ? error.message : error
                );
              })
          );
        await Promise.all(subProbes);
      })
      .catch((error) => {
        docsFailed += 1;
        console.error(
          `[delete-account] Chat purge subcollection listing failed for uid=${uid.slice(0, 8)}:`,
          error instanceof Error ? error.message : error
        );
      });

    // Every probe above catches its own errors; allSettled is belt-and-braces.
    await Promise.allSettled([...shapeAProbes, ...shapeBProbes, shapeCProbe]);
  } catch (error) {
    console.error(`[delete-account] Chat history purge error for uid=${uid.slice(0, 8)}:`, error);
    docsFailed += 1;
  }

  console.log(
    `[delete-account] Chat purge finished for uid=${uid.slice(0, 8)} in ${Date.now() - startedAt}ms ` +
      `(deleted=${docsDeleted}, failed=${docsFailed})`
  );
  return { docsDeleted, docsFailed };
}

/** Revokes refresh tokens so existing ID tokens die within minutes. */
export async function revokeUserTokens(uid: string): Promise<boolean> {
  try {
    await auth.revokeRefreshTokens(uid);
    return true;
  } catch (error) {
    console.error(`[delete-account] Token revocation failed for uid=${uid.slice(0, 8)}:`, error);
    return false;
  }
}

/**
 * Active paid term blocking deletion, as an ISO expiry string (else null).
 * Cancelled, trial, free, and expired terms never block.
 */
export async function getActiveSubscriptionExpiry(uid: string): Promise<string | null> {
  const snap = await db.collection(SUBSCRIPTIONS_COLLECTION).doc(uid).get();
  if (!snap.exists) return null;

  const data = snap.data() || {};
  if (!data.plan || data.plan === 'free') return null;
  if (normalizeStatus(data.status) === 'cancelled') return null;
  if (data.isTrial === true) return null;

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
