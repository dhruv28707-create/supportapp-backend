import { Request } from 'express';

/**
 * Best-effort client IP extraction for abuse throttling.
 *
 * Trust order (anti-spoof):
 *  1. `x-vercel-forwarded-for` — set by Vercel's edge, not client-spoofable
 *     in production. Trusted first.
 *  2. `req.ip` / socket address — the direct peer.
 *  3. `x-forwarded-for` left-most — attacker-controlled; only trusted when
 *     TRUST_FORWARDED_HEADERS=true (local dev behind a proxy). In production
 *     it is IGNORED so an attacker cannot rotate it per request for a fresh
 *     throttle bucket.
 *
 * Only used for rate limiting — never for auth or identity decisions.
 */
export function extractClientIp(req: Request): string | null {
  const vercel = req.headers['x-vercel-forwarded-for'];
  const vercelIp =
    typeof vercel === 'string'
      ? vercel.split(',')[0]?.trim()
      : Array.isArray(vercel) && vercel.length > 0
        ? vercel[0].split(',')[0]?.trim()
        : '';
  if (vercelIp) return vercelIp;

  if (process.env.TRUST_FORWARDED_HEADERS === 'true') {
    const forwarded = req.headers['x-forwarded-for'];
    const fwdIp =
      typeof forwarded === 'string'
        ? forwarded.split(',')[0]?.trim()
        : Array.isArray(forwarded) && forwarded.length > 0
          ? forwarded[0].split(',')[0]?.trim()
          : '';
    if (fwdIp) return fwdIp;
  }

  const ip = req.ip || req.socket?.remoteAddress;
  return typeof ip === 'string' && ip.length > 0 ? ip : null;
}
