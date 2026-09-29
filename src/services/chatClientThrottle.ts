import { createHmac } from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/firebaseAdmin';
import { RateLimitExceededError } from './rateLimitService';

/**
 * Per-IP throttle for /api/chat.
 *
 * WHY THIS EXISTS: every other quota keys on uid, but creating Firebase
 * accounts is free and unlimited. As the userbase grows, the marginal cost
 * of farming 1,000 fresh accounts (20 free messages each) is one script and
 * ten minutes — and the AI bill scales with SIGNUPS, not users. A per-IP
 * cap is the cheap first wall: it does not stop distributed farming, but it
 * stops the trivially-scripted kind and bounds worst-case spend per address.
 *
 * THRESHOLDS: generous on purpose. 120 msgs / 5 min per IP is far above any
 * real human typing pattern (that's one message every 2.5s sustained), so
 * legitimate users on shared NAT (offices, campus wifi, CGNAT mobile
 * carriers) are unaffected. Tune via env without redeploying code.
 *
 * CONSISTENCY: same non-transactional increment approach as
 * rateLimitService.consumeRateLimit — see that file for the concurrency
 * rationale. Kept as a separate collection so chat bursts never contend
 * with the per-uid counter doc, and so a different limit profile can be
 * applied without touching uid quotas.
 *
 * PRIVACY: IPs are HMAC-hashed with a server secret before becoming doc ids,
 * so rate-limit docs are not reversible personal data. Fail-open on storage
 * errors, like every limiter in this codebase.
 */

export const IP_LIMITS_COLLECTION = 'ipLimits';

export const CHAT_IP_RATE_LIMIT_MAX = Number(process.env.CHAT_IP_RATE_LIMIT_MAX) || 120;
export const CHAT_IP_RATE_LIMIT_WINDOW_MS =
  Number(process.env.CHAT_IP_RATE_LIMIT_WINDOW_MS) || 5 * 60 * 1000;

function hashIp(ip: string): string {
  // HMAC with a server-side secret (not plain SHA256): a truncated plain hash
  // of an IPv4 address is reversible by enumerating 2^32 values. HMAC with an
  // operator-controlled secret is not. Falls back to a documented dev default
  // when no secret is configured — production must set IP_HASH_SECRET.
  const secret =
    process.env.IP_HASH_SECRET ||
    process.env.RAZORPAY_WEBHOOK_SECRET ||
    'dev-only-ip-hash-secret';
  return createHmac('sha256', secret).update(ip).digest('hex');
}

/**
 * Consumes one slot of the per-IP chat budget. Throws RateLimitExceededError
 * when the address is over budget. Never throws for storage failures.
 */
export async function enforceChatIpThrottle(ip: string): Promise<void> {
  try {
    const ref = db.collection(IP_LIMITS_COLLECTION).doc(`chat:${hashIp(ip)}`);
    const snap = await ref.get();
    const now = Date.now();

    let count = 0;
    let windowStart = now;
    let windowExpired = true;
    if (snap.exists) {
      const data = snap.data() || {};
      const storedCount = typeof data.count === 'number' ? data.count : 0;
      const storedStart = typeof data.windowStart === 'number' ? data.windowStart : 0;
      if (now - storedStart < CHAT_IP_RATE_LIMIT_WINDOW_MS) {
        count = storedCount;
        windowStart = storedStart;
        windowExpired = false;
      }
    }

    if (count >= CHAT_IP_RATE_LIMIT_MAX) {
      throw new RateLimitExceededError(CHAT_IP_RATE_LIMIT_WINDOW_MS - (now - windowStart));
    }

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
    void write.catch((error: unknown) => {
      console.error('IP throttle write failed (already admitted request):', error);
    });
  } catch (error) {
    if (error instanceof RateLimitExceededError) throw error;
    // Fail-open: throttle is a cost guard, not an availability gate.
    console.error('IP throttle error (allowing request):', error);
  }
}
