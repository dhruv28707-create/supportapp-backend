import { Request, Response, NextFunction } from 'express';
import { auth } from '../config/firebaseAdmin';

export interface AuthenticatedRequest extends Request {
  user?: { uid: string; email: string };
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
    // checkRevoked: true rejects tokens issued before a user's tokens were
    // revoked (auth.revokeRefreshTokens) — this is what makes account
    // deletion able to invalidate future API access for stolen/old tokens.
    const decodedToken = await auth.verifyIdToken(token, true);
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || '',
    };
    next();
  } catch (error) {
    console.error('Auth verification failed:', error);
    res.status(401).json({ error: 'Unauthorized' });
  }
}
