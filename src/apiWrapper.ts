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

    await runHandler(method, routeHandler, req as AuthenticatedRequest, res);
  };
}

/**
 * Runs a route handler, converting an unexpected rejection into a logged 500
 * instead of an unhandled rejection (which the serverless runtime surfaces as
 * an opaque error with no log line).
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
 * Same as publicEndpoint, but verifies the Firebase ID token first and only
 * then delegates to the route handler.
 *
 * IMPORTANT: the route handler must be awaited. `authMiddleware` invokes its
 * `next` callback (which kicks off the async handler) and then resolves —
 * without an explicit await here the serverless invocation is considered done
 * before the response is written, so every protected endpoint returns an
 * empty/errored response while the handler quietly finishes afterwards and
 * logs a success line. (The Express app in src/app.ts is unaffected by this,
 * which is why it only ever broke on Vercel.)
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
