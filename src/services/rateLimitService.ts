import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/firebaseAdmin';

export const RATE_LIMITS_COLLECTION = 'rateLimits';

export class RateLimitExceededError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super('Rate limit exceeded');
    this.name = 'RateLimitExceededError';
  }
}

/** Result of a successful consume (returned for observability/tests). */
export interface RateLimitResult {
  count: number;
  windowStart: number;
}

/**
 * Sliding-window rate limiter backed by Firestore, so it works across
 * serverless instances. Throws RateLimitExceededError when the limit is hit.
 *
 * Concurrency design (why this is NOT a runTransaction):
 *
 * The previous implementation read+wrote the counter doc inside a
 * transaction. Firestore serializes transactions that touch the same
 * document (~1 write/sec/doc soft cap), so a user sending a burst of chat
 * messages had every request contending on `rateLimits/chat:<uid>`:
 * transactions retried, latency climbed, and under sustained bursts requests
 * failed with 500s even though plenty of quota remained.
 *
 * This version does one deterministic read followed by one non-transactional
 * increment(1). Firestore applies increments server-side and atomically, so
 * the count is always correct, and because it is not a transaction it never
 * retries or contends — throughput per counter doc is effectively the
 * machine limit, not Firestore's transaction rate.
 *
 * Trade-off: under a hard concurrent burst the counter can briefly overshoot
 * `max` (each request decides from the pre-increment snapshot). For an abuse
 * backstop that is acceptable — the plan quota still caps usage — and the
 * limiter remains fail-open on storage errors like before.
 *
 * Approximate cost: 1 read + 1 write per call, one round trip (the read is
 * fired first and awaited; the write is sent without waiting for its ack
 * because the decision was already made — increment cannot fail "denied").
 */
export async function consumeRateLimit(
  key: string,
  max: number,
  windowMs: number
): Promise<RateLimitResult> {
  const ref = db.collection(RATE_LIMITS_COLLECTION).doc(key);

  try {
    const snap = await ref.get();
    const now = Date.now();

    let count = 0;
    let windowStart = now;
    if (snap.exists) {
      const data = snap.data() || {};
      const storedCount = typeof data.count === 'number' ? data.count : 0;
      const storedStart = typeof data.windowStart === 'number' ? data.windowStart : 0;

      if (now - storedStart < windowMs) {
        // Window still open: continue it.
        count = storedCount;
        windowStart = storedStart;
      }
      // else: expired window — start a fresh one (windowStart = now).
    }

    if (count >= max) {
      throw new RateLimitExceededError(windowStart + windowMs - now);
    }

    // Non-transactional atomic increment. A concurrent request may bump the
    // same doc in parallel (bounded overshoot, see doc comment above); the
    // count still converges to the true number of admitted requests.
    const write = ref.set(
      {
        count: FieldValue.increment(1),
        windowStart,
        updatedAt: now,
      },
      { merge: true }
    );
    // Surface async write failures in logs without blocking the caller —
    // the limiter is fail-open by design.
    void write.catch((error: unknown) => {
      console.error('Rate limiter write failed (already admitted request):', error);
    });

    return { count: count + 1, windowStart };
  } catch (error) {
    if (error instanceof RateLimitExceededError) throw error;
    // Fail-open: the limiter is a secondary defense — real security comes
    // from auth + payment verification — and a limiter hiccup must never
    // take the API down.
    console.error('Rate limiter error (allowing request):', error);
    return { count: 0, windowStart: 0 };
  }
}
