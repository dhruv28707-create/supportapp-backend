import { Request, Response, NextFunction } from 'express';
import { auth } from '../config/firebaseAdmin';

export interface AuthenticatedRequest extends Request {
  user?: { uid: string; email: string };
}

/**
 * Signup race retries: a brand-new user's token can arrive before the Auth
 * backend replica has the user record (verifyIdToken with checkRevoked
 * throws auth/user-not-found). The JWT itself is valid, so retry twice.
 * Every other failure fails fast.
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
      // Expected auth failure (bad/expired/revoked token, deleted user).
      // The `code` lets the client react (e.g. sign out on user-not-found).
      console.warn(`[auth] Token verification failed: ${code}`);
      res.status(401).json({ error: 'Unauthorized', code });
      return;
    }
    console.error('Auth verification failed:', error);
    res.status(401).json({ error: 'Unauthorized' });
  }
}
