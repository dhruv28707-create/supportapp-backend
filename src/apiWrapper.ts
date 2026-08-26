import { enforceCors } from './config/cors';
import { authMiddleware } from './middleware/authMiddleware';

type RouteHandler = (req: any, res: any) => Promise<void> | void;

/**
 * Builds a Vercel serverless handler with the shared boilerplate every
 * endpoint needs: CORS enforcement, OPTIONS preflight handling, and a
 * method check. The route handler runs without authentication.
 */
export function publicEndpoint(method: 'GET' | 'POST', routeHandler: RouteHandler) {
  return async function handler(req: any, res: any): Promise<void> {
    if (!enforceCors(req, res)) return;

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    if (req.method !== method) {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    await routeHandler(req, res);
  };
}

/**
 * Same as publicEndpoint, but verifies the Firebase ID token first and only
 * then delegates to the route handler.
 */
export function protectedEndpoint(method: 'GET' | 'POST', routeHandler: RouteHandler) {
  return async function handler(req: any, res: any): Promise<void> {
    if (!enforceCors(req, res)) return;

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    if (req.method !== method) {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    await authMiddleware(req, res, () => routeHandler(req, res));
  };
}
