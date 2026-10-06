import { Request, Response } from 'express';

/**
 * CORS config. Allowed origins come from ALLOWED_ORIGINS (comma-separated,
 * or "*" for any). Browser requests need an allowed Origin; requests with
 * no Origin header (mobile, curl, server-to-server) are allowed.
 */

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://supportapp.in',
  'https://www.supportapp.in',
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
 * CORS enforcement for Vercel-style (req, res) handlers.
 * Returns true when the request may proceed.
 */
export function enforceCors(req: Request, res: Response): boolean {
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-razorpay-signature, x-firebase-appcheck'
  );
  // Cache per-origin so a CDN can't serve the wrong Allow-Origin.
  res.setHeader('Vary', 'Origin');

  const origin = req.headers?.origin;

  if (!origin) return true;

  if (isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    return true;
  }

  res.status(403).json({ error: 'Origin not allowed' });
  return false;
}
