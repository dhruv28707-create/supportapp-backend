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
 * Non-transactional by design: one read plus one server-side increment(1),
 * never a read-write transaction (those serialize per doc and collapse under
 * burst load). A hard concurrent burst can briefly overshoot `max` — fine
 * for an abuse backstop, since plan quota still caps usage.
 *
 * Fail-open on storage errors (set RATE_LIMIT_FAIL_CLOSED=true to deny).
 */
export async function consumeRateLimit(
  key: string,
  max: number,
  windowMs: number
): Promise<RateLimitResult> {
  try {
    const ref = db.collection(RATE_LIMITS_COLLECTION).doc(key);
    const snap = await ref.get();
    const now = Date.now();

    let count = 0;
    let windowStart = now;
    let windowExpired = true;
    if (snap.exists) {
      const data = snap.data() || {};
      const storedCount = typeof data.count === 'number' ? data.count : 0;
      const storedStart = typeof data.windowStart === 'number' ? data.windowStart : 0;

      if (now - storedStart < windowMs) {
        // Window still open: continue it.
        count = storedCount;
        windowStart = storedStart;
        windowExpired = false;
      }
      // else: expired window — start a fresh one (windowStart = now, count = 0).
    }

    if (count >= max) {
      throw new RateLimitExceededError(windowStart + windowMs - now);
    }

    // Window reset must write count 1 (not increment the stale count), or a
    // reset window would keep growing from the old value (e.g. 3 -> 4).
    // Non-transactional by design (see doc comment above).
    const write =
      windowExpired || !snap.exists
        ? ref.set(
            {
              count: 1,
              windowStart,
              updatedAt: now,
            },
            { merge: true }
          )
        : ref.set(
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
    // Fail-open by default: the limiter is a secondary defense — real security
    // comes from auth + payment verification — and a limiter hiccup must never
    // take the API down. Set RATE_LIMIT_FAIL_CLOSED=true to deny instead
    // (useful if AI spend must be capped even during a Firestore outage).
    // The distinctive prefix lets log alerts fire on fail-open events.
    console.error('[fail-open] Rate limiter error (allowing request):', error);
    if (process.env.RATE_LIMIT_FAIL_CLOSED === 'true') {
      throw new RateLimitExceededError(windowMs);
    }
    return { count: 0, windowStart: 0 };
  }
}
