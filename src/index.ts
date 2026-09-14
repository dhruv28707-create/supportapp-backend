// Load .env for local/self-hosted runs. Must come before other imports so env
// vars are set before firebaseAdmin and the route modules read them at import
// time. On Vercel env vars come from the dashboard and .env doesn't exist, so
// this is a no-op there.
import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { authMiddleware } from './middleware/authMiddleware';
import { getUserPlanHandler } from './routes/userPlan';
import { chatSendHandler } from './routes/chatSend';
import { razorpayWebhookHandler } from './routes/razorpayWebhook';
import { paymentOrderHandler } from './routes/paymentOrder';
import { paymentVerifyHandler } from './routes/paymentVerify';
import { deleteAccountHandler } from './routes/accountDelete';
import { diagnoseHandler } from './routes/diagnose';
import { isOriginAllowed } from './config/cors';
import { db } from './config/firebaseAdmin';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      callback(null, isOriginAllowed(origin));
    },
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

app.get('/api/user/plan', authMiddleware, getUserPlanHandler);

app.post('/api/chat', authMiddleware, chatSendHandler);
app.post('/api/chat/send', authMiddleware, chatSendHandler);

app.post('/api/payment-order', authMiddleware, paymentOrderHandler);
app.post('/api/payment-verify', authMiddleware, paymentVerifyHandler);

app.delete('/api/account', authMiddleware, deleteAccountHandler);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const shutdown = (signal: string) => {
  console.log(`${signal} received, shutting down gracefully...`);
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
