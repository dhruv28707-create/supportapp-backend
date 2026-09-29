import { Request } from 'express';
import { appCheck } from '../config/firebaseAdmin';

/**
 * Firebase App Check verification (opt-in).
 *
 * WHY: uid-keyed quotas cannot cap the AI bill, because creating Firebase
 * accounts is free. App Check attests the request comes from a genuine
 * build of the app (Play Integrity on Android, DeviceCheck/App Attest on
 * iOS, reCAPTCHA on web), which kills the trivial account-farming script.
 *
 * WHY SOFT ENFORCEMENT BY DEFAULT: App Check requires an app-release
 * rollout and a verification window first — hard-enabling it server-side
 * before clients send tokens would lock out the entire existing userbase.
 * Enable with ENABLE_APP_CHECK=true once client builds ship tokens.
 *
 * Semantics when enforced:
 *  - valid token      -> pass
 *  - invalid token    -> 401 (caller rejects)
 *  - missing token    -> pass, caller applies its tighter IP throttle
 *                        (gradual rollout: old clients keep working but
 *                        hit the per-IP cap)
 *
 * Unenforced (default): everything passes, zero added latency (no verify
 * call is made without a token present).
 */

export type AppCheckResult = 'valid' | 'invalid' | 'missing';

export function isAppCheckEnforced(): boolean {
  return process.env.ENABLE_APP_CHECK === 'true';
}

/** True when the request carries an App Check token at all. */
export function hasAppCheckToken(req: Request): boolean {
  return typeof req.headers['x-firebase-appcheck'] === 'string';
}

export async function verifyAppCheckToken(req: Request): Promise<AppCheckResult> {
  const token = req.headers['x-firebase-appcheck'];
  if (typeof token !== 'string' || token.length === 0) {
    return 'missing';
  }

  try {
    // Replay hardening: default consume:false keeps retried requests working
    // (throttle-tolerant). Set APP_CHECK_CONSUME=true once clients use
    // single-use tokens to make a stolen token unreplayable.
    const consume = process.env.APP_CHECK_CONSUME === 'true';
    await appCheck.verifyToken(token, { consume });
    return 'valid';
  } catch (error) {
    console.warn('[app-check] Token verification failed:', error);
    return 'invalid';
  }
}
