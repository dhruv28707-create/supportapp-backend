import { db } from '../config/firebaseAdmin';

export class RateLimitExceededError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super('Rate limit exceeded');
    this.name = 'RateLimitExceededError';
  }
}

/**
 * Sliding-window rate limiter backed by Firestore, so it works across
 * serverless instances. Throws RateLimitExceededError when the limit is hit.
 *
 * Deliberately fail-open on storage errors: the rate limiter is a secondary
 * defense — real security comes from auth + payment verification — and we
 * don't want a limiter hiccup to break payment availability.
 */
export async function consumeRateLimit(
  key: string,
  max: number,
  windowMs: number
): Promise<void> {
  const ref = db.collection('rateLimits').doc(key);

  try {
    await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      const now = Date.now();

      let count = 0;
      let windowStart = 0;
      if (snap.exists) {
        const data = snap.data() || {};
        count = typeof data.count === 'number' ? data.count : 0;
        windowStart = typeof data.windowStart === 'number' ? data.windowStart : 0;
      }

      if (now - windowStart >= windowMs) {
        count = 0;
        windowStart = now;
      }

      if (count >= max) {
        throw new RateLimitExceededError(windowStart + windowMs - now);
      }

      transaction.set(
        ref,
        { count: count + 1, windowStart, updatedAt: now },
        { merge: true }
      );
    });
  } catch (error) {
    if (error instanceof RateLimitExceededError) throw error;
    console.error('Rate limiter error (allowing request):', error);
  }
}
