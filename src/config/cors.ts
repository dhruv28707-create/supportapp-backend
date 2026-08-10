/**
 * CORS configuration.
 *
 * Allowed origins come from the ALLOWED_ORIGINS env var (comma-separated,
 * or "*" for any origin). Falls back to local dev + production frontends
 * when unset, so a missing env var can never take the app down.
 *
 * Browser requests must come from an allowed origin; anything else with an
 * Origin header is rejected with 403 (in Vercel handlers) or gets no CORS
 * headers (Express, so the browser blocks it). Requests with no Origin
 * header (mobile apps, curl, server-to-server) are allowed.
 */

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  // Production frontends — safe to call the API by default so a missing
  // ALLOWED_ORIGINS env var can never take the app down.
  'https://supportapp-zeta.vercel.app',
  'https://supportapp-backend.vercel.app',
].join(',');

export function getAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS;
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return false;
  const allowed = getAllowedOrigins();
  // Explicit wildcard: ALLOWED_ORIGINS="*" allows any browser origin.
  if (allowed.includes('*')) return true;
  return allowed.includes(origin);
}

/**
 * CORS enforcement for plain Vercel-style (req, res) handlers.
 * Returns true if the request may proceed, false if a response was already sent.
 */
export function enforceCors(req: any, res: any): boolean {
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-razorpay-signature'
  );

  const origin = req.headers?.origin as string | undefined;

  // Non-browser requests (mobile, curl, server-to-server) carry no Origin.
  if (!origin) return true;

  if (isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    return true;
  }

  res.status(403).json({ error: 'Origin not allowed' });
  return false;
}
