import { Request, Response, NextFunction } from 'express';
import { auth } from '../config/firebaseAdmin';

export interface AuthenticatedRequest extends Request {
  user?: { uid: string; email: string };
}

/**
 * Retries for the signup race: a brand-new user's ID token is issued
 * immediately by the client SDK, but `verifyIdToken(token, true)` must fetch
 * the user record from the Auth backend to enforce revocation — and for a
 * just-created account that lookup can briefly hit a replica that does not
 * have the user yet, throwing `auth/user-not-found`. The JWT itself is valid;
 * only the record is lagging. A couple of short retries closes that window.
 *
 * Every OTHER failure (bad signature, malformed token, expired, revoked) is
 * permanent w.r.t. this request and fails fast with no retry.
 */
const USER_NOT_FOUND_RETRY_DELAYS_MS = [250, 600];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Extracts an `auth/...` error code from a FirebaseAdmin error, if present. */
function firebaseErrorCode(error: unknown): string | null {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('auth/')) return code;
  }
  return null;
}

async function verifyIdTokenWithRetry(token: string): Promise<{ uid: string; email: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= USER_NOT_FOUND_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      console.warn(
        `[auth] user record not found yet (attempt ${attempt}) — retrying in ${USER_NOT_FOUND_RETRY_DELAYS_MS[attempt - 1]}ms (signup replication race)`
      );
      await sleep(USER_NOT_FOUND_RETRY_DELAYS_MS[attempt - 1]);
    }
    try {
      // checkRevoked: true rejects tokens issued before a user's tokens were
      // revoked (auth.revokeRefreshTokens) — this is what makes account
      // deletion able to invalidate future API access for stolen/old tokens.
      const decodedToken = await auth.verifyIdToken(token, true);
      return { uid: decodedToken.uid, email: decodedToken.email || '' };
    } catch (error) {
      lastError = error;
      if (firebaseErrorCode(error) !== 'auth/user-not-found') throw error;
    }
  }
  throw lastError;
}

export async function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const token = authHeader.split('Bearer ')[1];
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    req.user = await verifyIdTokenWithRetry(token);
    next();
  } catch (error) {
    const code = firebaseErrorCode(error);
    if (code) {
      // Expected auth failures (bad token, expired, revoked, or a user record
      // that genuinely does not exist anymore, e.g. a stale session after
      // account deletion). Warn-level with the code — no stack spam — and a
      // machine-readable `code` in the body so the client can react
      // (e.g. auto-sign-out on auth/user-not-found).
      console.warn(`[auth] Token verification failed: ${code}`);
      res.status(401).json({ error: 'Unauthorized', code });
      return;
    }
    console.error('Auth verification failed:', error);
    res.status(401).json({ error: 'Unauthorized' });
  }
}
