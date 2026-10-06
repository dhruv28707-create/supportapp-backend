import { createHmac } from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/firebaseAdmin';
import { RateLimitExceededError } from './rateLimitService';

/**
 * Per-IP throttles. Uid-keyed quotas alone can't cap spend because Firebase
 * accounts are free to create, so each sensitive endpoint also gets a
 * per-IP cap. Generous by design (shared NAT must not suffer); tune via env.
 *
 * IPs are HMAC-hashed with a server secret before becoming doc ids, so the
 * docs aren't reversible personal data. Fail-open on storage errors.
 */

export const IP_LIMITS_COLLECTION = 'ipLimits';

// Defaults; use the getters below per request so env tuning applies without
// an import-time freeze (tests stub env after import).
export const CHAT_IP_RATE_LIMIT_MAX = 120;
export const CHAT_IP_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

// Trial abuse lives here too: one script farming fresh accounts must not get
// a trial per account from a single address.
export const TRIAL_IP_RATE_LIMIT_MAX = 10;
export const TRIAL_IP_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

// Same idea for payment orders: per-uid limits don't stop multi-account
// order minting from one machine.
export const ORDER_IP_RATE_LIMIT_MAX = 20;
export const ORDER_IP_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

/** Per-request reads so env tuning applies without redeploying code. */
export function getChatIpRateLimitMax(): number {
  const raw = Number(process.env.CHAT_IP_RATE_LIMIT_MAX);
  return Number.isFinite(raw) && raw > 0 ? raw : CHAT_IP_RATE_LIMIT_MAX;
}

/** Per-request reads so env tuning applies without redeploying code. */
export function getChatIpRateLimitWindowMs(): number {
  const raw = Number(process.env.CHAT_IP_RATE_LIMIT_WINDOW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : CHAT_IP_RATE_LIMIT_WINDOW_MS;
}

function hashIp(ip: string): string {
  // HMAC, not plain hash: a plain hash of an IPv4 address is reversible by
  // enumeration. Falls back to the webhook secret when no dedicated secret
  // is set; dev default is fail-open with a warning.
  const secret = process.env.IP_HASH_SECRET || process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.warn(
      '[fail-open] IP throttle has no IP_HASH_SECRET/RAZORPAY_WEBHOOK_SECRET — using dev-only default'
    );
    return createHmac('sha256', 'dev-only-ip-hash-secret').update(ip).digest('hex');
  }
  return createHmac('sha256', secret).update(ip).digest('hex');
}

/**
 * Consumes one slot of the per-IP budget for a scope. Throws
 * RateLimitExceededError when the address is over budget. Never throws for
 * storage failures (fail-open; set RATE_LIMIT_FAIL_CLOSED=true to deny).
 */
export async function enforceIpThrottle(
  ip: string,
  scope: string,
  max: number,
  windowMs: number
): Promise<void> {
  try {
    const ref = db.collection(IP_LIMITS_COLLECTION).doc(`${scope}:${hashIp(ip)}`);
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
        count = storedCount;
        windowStart = storedStart;
        windowExpired = false;
      }
    }

    if (count >= max) {
      throw new RateLimitExceededError(windowMs - (now - windowStart));
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
    console.error('[fail-open] IP throttle error (allowing request):', error);
    if (process.env.RATE_LIMIT_FAIL_CLOSED === 'true') {
      throw new RateLimitExceededError(windowMs);
    }
  }
}

/** Per-IP chat budget (120 msgs / 5 min by default). */
export async function enforceChatIpThrottle(ip: string): Promise<void> {
  await enforceIpThrottle(ip, 'chat', getChatIpRateLimitMax(), getChatIpRateLimitWindowMs());
}

/** Per-IP trial-start budget. Stops one address farming trials across accounts. */
export async function enforceTrialIpThrottle(ip: string): Promise<void> {
  await enforceIpThrottle(ip, 'trial', TRIAL_IP_RATE_LIMIT_MAX, TRIAL_IP_RATE_LIMIT_WINDOW_MS);
}

/** Per-IP payment-order budget. Stops one address minting orders across accounts. */
export async function enforceOrderIpThrottle(ip: string): Promise<void> {
  await enforceIpThrottle(ip, 'order', ORDER_IP_RATE_LIMIT_MAX, ORDER_IP_RATE_LIMIT_WINDOW_MS);
}
