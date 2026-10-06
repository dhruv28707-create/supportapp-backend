import { Request } from 'express';
import { appCheck } from '../config/firebaseAdmin';

/**
 * Firebase App Check verification (opt-in via ENABLE_APP_CHECK=true).
 * Attests the request comes from a genuine app build, which blunts
 * account-farming scripts that uid quotas alone can't stop.
 *
 * When enforced: valid passes, invalid is rejected (401), missing passes
 * but falls through to the tighter per-IP throttle (lets old clients keep
 * working during rollout).
 */

export type AppCheckResult = 'valid' | 'invalid' | 'missing';

export function isAppCheckEnforced(): boolean {
  return process.env.ENABLE_APP_CHECK === 'true';
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
