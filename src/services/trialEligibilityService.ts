import { db, auth } from '../config/firebaseAdmin';
import { getTrialEligibilityWindowDays } from '../constants';
import { SUBSCRIPTIONS_COLLECTION } from './subscriptionService';

/**
 * Trial-eligibility lookups without Identity Toolkit pressure.
 *
 * /api/user/plan and /api/user/usage run the "is this account still new
 * enough for the free trial" hint check on every request. That used to call
 * `auth.getUser()` per hit — a single valid token hammering the endpoint
 * burned the project-wide Identity Toolkit admin quota, taking down trial
 * starts, deletions and developer tooling with it (fail-open log-only
 * handling let the hammering continue).
 *
 * `metadata.creationTime` is immutable, so it is cached once in the
 * server-only `subscriptions/{uid}` doc (Firestore rules keep users from
 * writing there — the client-writable `users/{uid}` doc must NEVER hold
 * this value, or a user could forge a fresh account age). In-flight lookups
 * per uid are deduped per serverless instance so a concurrent burst pays
 * at most one Auth read.
 */

const AUTH_CREATED_AT_FIELD = 'authCreatedAt';

/** uid -> pending lookup, so a burst issues one auth.getUser at most. */
const inFlight = new Map<string, Promise<number | null>>();

/**
 * Account creation epoch ms from the (cached) Auth record, or null when the
 * record cannot be read. Cached after first sighting; creationTime is
 * immutable.
 */
export async function getAuthCreatedTimeMs(uid: string): Promise<number | null> {
  const pending = inFlight.get(uid);
  if (pending) return pending;

  const lookup = readAuthCreatedTimeMs(uid).finally(() => {
    inFlight.delete(uid);
  });
  inFlight.set(uid, lookup);
  return lookup;
}

async function readAuthCreatedTimeMs(uid: string): Promise<number | null> {
  const cacheRef = db.collection(SUBSCRIPTIONS_COLLECTION).doc(uid);

  // 1. Cache hit: no Auth call. (Firestore errors fall through to the
  //    authoritative lookup — cheap enough on the rare failure path.)
  try {
    const snap = await cacheRef.get();
    const cached = snap.data()?.[AUTH_CREATED_AT_FIELD];
    if (typeof cached === 'number' && Number.isFinite(cached) && cached > 0) {
      return cached;
    }
  } catch (error) {
    console.error(`[trial-eligibility] Creation-time cache read failed uid=${uid.slice(0, 8)}:`, error);
  }

  // 2. Authoritative Identity Toolkit read (misses are one-time per account: a race
  //    may repeat it across restarts or concurrent instances, but self-heals).
  let creationTimeMs: number | null = null;
  try {
    const record = await auth.getUser(uid);
    const parsed = Date.parse(record.metadata.creationTime);
    if (Number.isFinite(parsed) && parsed > 0) {
      creationTimeMs = parsed;
      // Best-effort cache write; a failure only costs repeat Auth reads.
      try {
        await cacheRef.set({ [AUTH_CREATED_AT_FIELD]: creationTimeMs }, { merge: true });
      } catch (error) {
        console.error(`[trial-eligibility] Creation-time cache write failed uid=${uid.slice(0, 8)}:`, error);
      }
    }
  } catch (error) {
    console.error(`[trial-eligibility] Auth record lookup failed uid=${uid.slice(0, 8)}:`, error);
  }

  return creationTimeMs;
}

/**
 * Free-trial CTA hint: true only while the account fits the eligibility
 * window ("still a new account"). Never true if the account cannot be
 * resolved — the trial endpoint re-checks authoritatively anyway.
 */
export async function isTrialEligibleByAccountAge(uid: string): Promise<boolean> {
  const creationTimeMs = await getAuthCreatedTimeMs(uid);
  if (creationTimeMs === null) return false;
  const windowMs = getTrialEligibilityWindowDays() * 24 * 60 * 60 * 1000;
  return Date.now() - creationTimeMs <= windowMs;
}
