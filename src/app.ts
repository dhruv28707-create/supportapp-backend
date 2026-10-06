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
import { isOriginAllowed } from './config/cors';
import { db } from './config/firebaseAdmin';

/**
 * Express app factory (tests drive these same routes via supertest;
 * index.ts only adds listen + shutdown).
 */
export function createApp(): express.Express {
  const app = express();

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
