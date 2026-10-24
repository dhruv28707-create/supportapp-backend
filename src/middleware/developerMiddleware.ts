import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './authMiddleware';
import { isDeveloperAccount } from '../services/developerService';

/**
 * Gate for read-only developer/admin routes. Never trusts a client-supplied
 * flag: developer status comes from a signed custom claim, the server-side
 * env allowlist, or the protected Firestore developer flag.
 */
export async function requireDeveloper(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const allowed = await isDeveloperAccount(user.uid, user.email, user.developer);
  if (!allowed) {
    res.status(403).json({ error: 'Forbidden', code: 'developer_only' });
    return;
  }

  user.developer = true;
  next();
}
