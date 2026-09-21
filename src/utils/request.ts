import { Request } from 'express';

/**
 * Best-effort client IP extraction for abuse throttling.
 *
 * Vercel sets `x-vercel-forwarded-for` (and the standard `x-forwarded-for`)
 * on incoming requests; Express also fills `req.ip` from the socket. There
 * is no way to get a *guaranteed* client IP behind a shared proxy, so this
 * is deliberately conservative and only used for rate limiting — never for
 * auth or identity decisions.
 *
 * Returns the LEFT-MOST (client) entry, trimmed. IPv6 with port or multi-hop
 * chains still produce a stable-enough key for a throttle; spoofed entries
 * only waste the attacker's own quota key.
 */
export function extractClientIp(req: Request): string | null {
  const candidates: string[] = [];

  const vercel = req.headers['x-vercel-forwarded-for'];
  if (typeof vercel === 'string') candidates.push(vercel);
  else if (Array.isArray(vercel) && vercel.length > 0) candidates.push(vercel[0]);

  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') candidates.push(forwarded);
  else if (Array.isArray(forwarded) && forwarded.length > 0) candidates.push(forwarded[0]);

  for (const candidate of candidates) {
    const first = candidate.split(',')[0]?.trim();
    if (first) return first;
  }

  const ip = req.ip || req.socket?.remoteAddress;
  return typeof ip === 'string' && ip.length > 0 ? ip : null;
}
