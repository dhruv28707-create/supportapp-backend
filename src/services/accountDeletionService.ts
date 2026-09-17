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
 * Account deletion — server-side path.
 *
 * Policy implemented here:
 *  - The requester must be the authenticated owner (uid comes from the
 *    verified Firebase ID token; there is no admin override path here).
 *  - An ACTIVE paid subscription blocks deletion (HTTP 409) so deletion
 *    cannot be used to silently walk away from a paid term. The user must
 *    cancel first via POST /api/payment-cancel (which downgrades the plan
 *    immediately), let it expire, or contact support for refunds per the
 *    app's stated policy.
 *  - Otherwise: server-side data (subscriptions, rate-limit counters, the
 *    users/{uid} profile doc, and any pending payment records owned by the
 *    user) is deleted. Paid payment history rows are NOT deleted — they are
 *    financial records; instead the uid is redacted to keep the row
 *    attributable to a payment without pointing at a live account.
 *  - Finally the user's Firebase refresh tokens are revoked, which
 *    invalidates all existing ID tokens within ~minutes (the max ID-token
 *    lifetime), cutting off future API access even for copied tokens.
 *
 * LATENCY CONTRACT: mobile HTTP clients abort ("Aborted" error) long before
 * serverless functions finish if deletion takes >10s. Every independent
 * cleanup step therefore runs in PARALLEL, and the chat-layout discovery
 * probes (32 collection x field combinations) run concurrently with a hard
 * per-probe timeout instead of strictly one-by-one.
 */

/** Hard per-probe time budget for chat-layout discovery. */
const PROBE_TIMEOUT_MS = 4000;

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

  // 1) Subscription state (server-only quota/plan doc).
  const deleteSubscription = db
    .collection(SUBSCRIPTIONS_COLLECTION)
    .doc(uid)
    .delete()
    .then(() => {
      summary.subscriptionDeleted = true;
    })
    .catch((error) => {
      console.error(
        `[delete-account] Failed to delete subscription for uid=${uid.slice(0, 8)}:`,
        error
      );
    });

  // 2) users/{uid} profile doc (client-visible profile; safe to remove).
  const deleteUserDoc = db
    .collection('users')
    .doc(uid)
    .delete()
    .then(() => {
      summary.userDocDeleted = true;
    })
    .catch((error) => {
      console.error(`[delete-account] Failed to delete user doc for uid=${uid.slice(0, 8)}:`, error);
    });

  // 3) Payment records owned by the user.
  const cleanupPayments = (async () => {
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
  })().catch((error) => {
    console.error(`[delete-account] Payment cleanup failed for uid=${uid.slice(0, 8)}:`, error);
  });

  // 4) Chat history written by the app into Firestore.
  //    The app must NOT try to delete these client-side (security rules deny
  //    everything the backend does not explicitly allow, and the catch-all
  //    rule denies the rest) — this server-side purge is the single source of
  //    truth for wiping chat data. Layout is auto-discovered; CHAT_COLLECTIONS
  //    overrides the candidate list.
  const cleanupChats = deleteChatHistory(uid)
    .then(({ docsDeleted, docsFailed }) => {
      summary.chatsDeleted = docsDeleted;
      summary.chatDocsFailed = docsFailed;
    })
    .catch((error) => {
      console.error(`[delete-account] Chat history cleanup failed for uid=${uid.slice(0, 8)}:`, error);
    });

  // 5) Rate-limit counters (no personal content, but tied to the uid key).
  const cleanupRateLimits = cleanupRateLimitCounters(uid).catch((error) => {
    console.error(`[delete-account] Rate limit cleanup failed for uid=${uid.slice(0, 8)}:`, error);
  });

  // All five phases are independent — run them concurrently. Each promise
  // above already catches its own errors (best-effort semantics preserved).
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
 * Rate-limit counters are keyed deterministically (`chat:<uid>`,
 * `payment-order:<uid>`, ...), so they can be deleted directly — no need to
 * scan the whole rateLimits collection (which read EVERY user's counters and
 * scaled with total user count). Deleting a nonexistent doc is a no-op.
 */
async function cleanupRateLimitCounters(uid: string): Promise<void> {
  const prefixes = [
    'chat:',
    'payment-order:',
    'payment-verify:',
    'payment-cancel:',
    'delete-account:',
  ];

  const batch = db.batch();
  for (const prefix of prefixes) {
    batch.delete(db.collection(RATE_LIMITS_COLLECTION).doc(`${prefix}${uid}`));
  }
  await batch.commit();
}

/**
 * Deletes the user's chat history from Firestore. The app stores chats in a
 * shape this repo does not define, so all well-known shapes are attempted
 * (see chatHistoryDiscovery.ts). Best-effort: failures are logged and
 * counted, never thrown.
 *
 * All probes run CONCURRENTLY with a per-probe timeout: serialized probing of
 * 32 collection/field combinations alone used to take several seconds of
 * round-trips, which (with the rest of the cleanup) pushed the endpoint past
 * mobile HTTP client timeouts — the client saw "Aborted" while the function
 * still completed with 200.
 */
async function deleteChatHistory(uid: string): Promise<{ docsDeleted: number; docsFailed: number }> {
  const startedAt = Date.now();
  let docsDeleted = 0;
  let docsFailed = 0;

  const batchDeleteDocs = async (refs: FirebaseFirestore.DocumentReference[]) => {
    const batch = db.batch();
    let ops = 0;
    for (const ref of refs) {
      batch.delete(ref);
      ops += 1;
      if (ops >= 400) {
        await batch.commit();
        ops = 0;
      }
    }
    if (ops > 0) await batch.commit();
    docsDeleted += refs.length;
  };

  try {
    const override = getChatCollectionsOverride();
    const topLevelCandidates: readonly string[] =
      override.length > 0 ? override : CHAT_STORAGE_SHAPES.UID_FIELD_COLLECTIONS;

    // Shape A: top-level collection with an owner uid field on each doc.
    const shapeAProbes = topLevelCandidates.flatMap((collection) =>
      USER_DATA_FIELD_HINTS.map((field) =>
        withTimeout(
          db.collection(collection).where(field, '==', uid).limit(1000).get(),
          PROBE_TIMEOUT_MS,
          `${collection}.${field}`
        )
          .then(async (snap) => {
            if (snap.empty) return;
            const refs = snap.docs.map((d) => d.ref);
            await batchDeleteDocs(refs);
            console.log(
              `[delete-account] Chat purge: ${refs.length} doc(s) from ${collection} (uid field: ${field})`
            );
          })
          .catch((error) => {
            // Unknown collection / missing index — expected for shapes the
            // app does not use; log and continue with the next candidate.
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
        db.collection(collection).doc(uid).get(),
        PROBE_TIMEOUT_MS,
        `${collection}/${uid}`
      )
        .then(async (snap) => {
          if (!snap.exists) return;
          const docRef = db.collection(collection).doc(uid);
          await batchDeleteDocs([docRef]);
          console.log(`[delete-account] Chat purge: per-user doc ${collection}/${uid}`);
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
              db.collection('users').doc(uid).collection(sub).limit(1000).get(),
              PROBE_TIMEOUT_MS,
              `users/{uid}/${sub}`
            )
              .then(async (snap) => {
                if (snap.empty) return;
                const refs = snap.docs.map((d) => d.ref);
                await batchDeleteDocs(refs);
                console.log(`[delete-account] Chat purge: ${refs.length} doc(s) from users/{uid}/${sub}`);
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

  // A cancelled subscription no longer blocks deletion: the user went through
  // POST /api/payment-cancel (or the doc was already flipped). Only an ACTIVE
  // paid term is a reason to refuse deleting the account.
  if (normalizeStatus(data.status) === 'cancelled') return null;

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
