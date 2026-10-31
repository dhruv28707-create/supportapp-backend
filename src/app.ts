import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { authMiddleware } from './middleware/authMiddleware';
import { getUserPlanHandler } from './routes/userPlan';
import { getUsageHandler } from './routes/usage';
import { chatSendHandler } from './routes/chatSend';
import { razorpayWebhookHandler } from './routes/razorpayWebhook';
import { paymentOrderHandler } from './routes/paymentOrder';
import { paymentVerifyHandler } from './routes/paymentVerify';
import { paymentCancelHandler } from './routes/paymentCancel';
import { deleteAccountHandler } from './routes/accountDelete';
import { diagnoseHandler } from './routes/diagnose';
import { trialStartHandler } from './routes/trialStart';
import { plansHandler } from './routes/plans';
import { developerRouter } from './routes/developer';
import { vercelLogDrainHandler } from './routes/vercelLogDrain';
import { MAX_RAW_BODY_BYTES as MAX_DRAIN_RAW_BODY_BYTES } from './routes/vercelLogDrain';
import { isOriginAllowed } from './config/cors';
import { db } from './config/firebaseAdmin';

/**
 * Express app factory (tests drive these same routes via supertest;
 * index.ts only adds listen + shutdown).
 */
/**
 * Raw-body passthrough for the Vercel drain: `express.raw` either inflates
 * gzip bodies itself (breaking the HMAC-over-wire-bytes contract) or refuses
 * them (415), so this route reads the exact bytes off the socket instead —
 * capped, unbuffered beyond the limit, and content-encoding-agnostic. The
 * drain handler then verifies the HMAC over these true raw bytes and opens
 * gzip through its own size-capped streaming decompressor.
 */
function rawDrainBody(limitBytes: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > limitBytes) {
        settled = true;
        req.resume();
        res.status(413).json({ error: 'Payload too large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      req.body = Buffer.concat(chunks);
      next();
    });
  };
}

export function createApp(): express.Express {
  const app = express();

  // Reject disallowed browser origins up front, matching the Vercel wrapper
  // (enforceCors). The cors middleware alone only omits the response header,
  // which still serves the request.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && !isOriginAllowed(origin)) {
      res.status(403).json({ error: 'Origin not allowed' });
      return;
    }
    next();
  });

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        callback(null, isOriginAllowed(origin));
      },
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'x-razorpay-signature',
        'x-firebase-appcheck',
      ],
    })
  );

  app.post(
    '/api/webhooks/razorpay',
    express.raw({ type: 'application/json' }),
    razorpayWebhookHandler
  );

  // Vercel Log Drains receiver: raw wire bytes (HMAC must be computed over
  // what Vercel signed); gzip bodies are opened only by the route handler's
  // size-capped streaming gunzip, so a compression bomb never expands
  // unbounded anywhere in the chain.
  app.post('/api/logs/vercel', rawDrainBody(MAX_DRAIN_RAW_BODY_BYTES), vercelLogDrainHandler);

  app.use(express.json());

  app.get('/api/health', async (_req: Request, res: Response) => {
    try {
      await db.collection('__health').doc('check').get();
      res.json({ status: 'ok', service: 'supportapp-backend', firebase: 'connected' });
    } catch {
      res.status(503).json({ status: 'degraded', service: 'supportapp-backend', firebase: 'disconnected' });
    }
  });

  app.get('/api/diagnose', diagnoseHandler);

  app.get('/api/plans', plansHandler);

  // Read-only developer/admin API. Every route inside is gated by
  // requireDeveloper (signed claim / env allowlist / protected Firestore flag).
  app.use('/api/developer', authMiddleware, developerRouter);

  app.get('/api/user/plan', authMiddleware, getUserPlanHandler);
  // /api/user/plan is legacy compat; new clients use /api/user/usage.
  app.get('/api/user/usage', authMiddleware, getUsageHandler);

  app.post('/api/chat', authMiddleware, chatSendHandler);
  app.post('/api/chat/send', authMiddleware, chatSendHandler);

  app.post('/api/trial/start', authMiddleware, trialStartHandler);

  app.post('/api/payment-order', authMiddleware, paymentOrderHandler);
  app.post('/api/payment-verify', authMiddleware, paymentVerifyHandler);
  app.post('/api/payment-cancel', authMiddleware, paymentCancelHandler);

  app.delete('/api/account', authMiddleware, deleteAccountHandler);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

const app = createApp();
export default app;
