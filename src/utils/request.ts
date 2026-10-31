import { Request } from 'express';

/** First non-empty value of a comma-separated forwarding header. */
function firstHeaderValue(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return '';
  return raw.split(',')[0]?.trim() ?? '';
}

/**
 * IPv4-mapped IPv6 addresses (::ffff:203.0.113.7) normalize to plain IPv4 so
 * the same client hashes to the same throttle key regardless of socket
 * configuration.
 */
function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}

/**
 * Best-effort client IP for abuse throttling (never for auth/identity).
 *
 * The per-IP defenses against account farming key on this value, so key
 * control must not be attacker-steerable. Forwarding headers are
 * attacker-controlled on any hop the attacker owns; Vercel is believed to
 * overwrite `x-vercel-forwarded-for`, but that overwrite semantics has not
 * been verified against a live deployment — if the edge ever appends
 * instead, the FIRST value would be attacker-chosen. Therefore the direct
 * peer address (req.ip / socket remote, which Vercel derives from the
 * connection) takes priority on Vercel, and forwarding headers are honored
 * only in these cases:
 *   - TRUST_FORWARDED_HEADERS=true: explicit opt-in for local dev behind a
 *     proxy (the developer owns every hop).
 *   - Vercel runtime missing req.ip entirely: fall back to the Edge-set
 *     header (better than nulling the throttle key — it degrades to the old
 *     behavior rather than disabling the backstop).
 * Set IP_FORWARDFOR_DEBUG=true to log both values per request and confirm
 * overwrite semantics on a test deployment.
 */
export function extractClientIp(req: Request): string | null {
  const peerIp = typeof req.ip === 'string' && req.ip.length > 0 ? req.ip : req.socket?.remoteAddress;

  if (process.env.VERCEL === '1') {
    const headerIp = firstHeaderValue(req.headers['x-vercel-forwarded-for']);
    const peer = typeof peerIp === 'string' && peerIp.length > 0 ? normalizeIp(peerIp) : '';
    if (process.env.IP_FORWARDFOR_DEBUG === 'true') {
      console.log(
        `[ip-debug] peer=${peer || '(none)'} x-vercel-forwarded-for=${headerIp || '(none)'}`
      );
    }
    if (peer) return peer;
    if (headerIp) return headerIp;
    return null;
  }

  if (process.env.TRUST_FORWARDED_HEADERS === 'true') {
    const forwardedIp = firstHeaderValue(req.headers['x-forwarded-for']);
    if (forwardedIp) return forwardedIp;
  }

  const ip = peerIp;
  return typeof ip === 'string' && ip.length > 0 ? normalizeIp(ip) : null;
}
