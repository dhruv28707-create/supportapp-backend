import { Request } from 'express';

/** First non-empty value of a comma-separated forwarding header. */
function firstHeaderValue(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return '';
  return raw.split(',')[0]?.trim() ?? '';
}

/**
 * Best-effort client IP for abuse throttling (never for auth/identity).
 *
 * x-vercel-forwarded-for is set by Vercel's edge, but it is an ordinary
 * request header everywhere else — trusting it unconditionally would let a
 * self-hosted client spoof its throttle key. It is honored only when running
 * on Vercel. x-forwarded-for is attacker-controlled too, so it is honored
 * only with TRUST_FORWARDED_HEADERS=true (local dev behind a proxy).
 * Otherwise the direct peer address is used.
 */
export function extractClientIp(req: Request): string | null {
  if (process.env.VERCEL === '1') {
    const vercelIp = firstHeaderValue(req.headers['x-vercel-forwarded-for']);
    if (vercelIp) return vercelIp;
  }

  if (process.env.TRUST_FORWARDED_HEADERS === 'true') {
    const forwardedIp = firstHeaderValue(req.headers['x-forwarded-for']);
    if (forwardedIp) return forwardedIp;
  }

  const ip = req.ip || req.socket?.remoteAddress;
  return typeof ip === 'string' && ip.length > 0 ? ip : null;
}
