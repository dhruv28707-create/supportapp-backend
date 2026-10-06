import { Request } from 'express';

/**
 * Best-effort client IP for abuse throttling (never for auth/identity).
 * Trusts x-vercel-forwarded-for (edge-set) first, then the direct peer.
 * x-forwarded-for is attacker-controlled, so it's only honored with
 * TRUST_FORWARDED_HEADERS=true (local dev behind a proxy).
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
