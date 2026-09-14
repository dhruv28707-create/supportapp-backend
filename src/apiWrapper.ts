import { Request, Response } from 'express';
import { enforceCors } from './config/cors';
import { authMiddleware, AuthenticatedRequest } from './middleware/authMiddleware';

type HttpMethod = 'GET' | 'POST' | 'DELETE';

type RouteHandler = (req: AuthenticatedRequest, res: Response) => Promise<void> | void;

/**
 * Builds a Vercel serverless handler with the shared boilerplate every
 * endpoint needs: CORS enforcement, OPTIONS preflight handling, and a
 * method check. The route handler runs without authentication.
 */
export function publicEndpoint(method: HttpMethod, routeHandler: RouteHandler) {
  return async function handler(req: Request, res: Response): Promise<void> {
    if (!enforceCors(req, res)) return;

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    if (req.method !== method) {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    await routeHandler(req as AuthenticatedRequest, res);
  };
}

/**
 * Same as publicEndpoint, but verifies the Firebase ID token first and only
 * then delegates to the route handler.
 */
export function protectedEndpoint(method: HttpMethod, routeHandler: RouteHandler) {
  return async function handler(req: Request, res: Response): Promise<void> {
    if (!enforceCors(req, res)) return;

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    if (req.method !== method) {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    await authMiddleware(req as AuthenticatedRequest, res, () =>
      routeHandler(req as AuthenticatedRequest, res)
    );
  };
}
