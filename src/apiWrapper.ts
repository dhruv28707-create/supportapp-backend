import { Request, Response } from 'express';
import { enforceCors } from './config/cors';
import { authMiddleware, AuthenticatedRequest } from './middleware/authMiddleware';

type HttpMethod = 'GET' | 'POST' | 'DELETE';

type RouteHandler = (req: AuthenticatedRequest, res: Response) => Promise<void> | void;

/**
 * Builds a Vercel handler with shared CORS, preflight, and method checks.
 * No authentication — for public endpoints.
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

    await runHandler(method, routeHandler, req as AuthenticatedRequest, res);
  };
}

/**
 * Runs a route handler, converting an unexpected rejection into a logged
 * 500 instead of an opaque runtime error.
 */
async function runHandler(
  method: HttpMethod,
  routeHandler: RouteHandler,
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    await routeHandler(req, res);
  } catch (error) {
    console.error(`[api] Unhandled error in ${method} handler:`, error);
    if (!res.writableEnded && !res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}

/**
 * Same as publicEndpoint, plus Firebase ID-token verification. The handler
 * must be awaited after auth: without it the serverless invocation finishes
 * before the response is written and every protected endpoint returns empty.
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

    // authMiddleware either sets req.user and calls next(), or writes a 401
    // and resolves without calling next. Track which happened, then await the
    // real handler.
    let authenticated = false;
    await authMiddleware(req as AuthenticatedRequest, res, () => {
      authenticated = true;
    });
    if (!authenticated) return;

    await runHandler(method, routeHandler, req as AuthenticatedRequest, res);
  };
}
