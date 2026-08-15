import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { authMiddleware } from './middleware/authMiddleware';
import { getUserPlanHandler } from './routes/userPlan';
import { chatSendHandler } from './routes/chatSend';
import { razorpayWebhookHandler } from './routes/razorpayWebhook';
import { paymentOrderHandler } from './routes/paymentOrder';
import { paymentVerifyHandler } from './routes/paymentVerify';
import { diagnoseHandler } from './routes/diagnose';
import { isOriginAllowed } from './config/cors';

const app = express();

app.use(
  cors({
    origin: (origin, callback) => {
      // No origin (native apps, curl) → allow.
      if (!origin) return callback(null, true);
      callback(null, isOriginAllowed(origin));
    },
  })
);

// The Razorpay webhook MUST receive the raw body for HMAC signature
// verification, so it is registered before the global JSON parser.
app.post(
  '/api/webhooks/razorpay',
  express.raw({ type: 'application/json' }),
  razorpayWebhookHandler
);

app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'supportapp-backend' });
});

app.get('/api/diagnose', diagnoseHandler);

app.get('/api/user/plan', authMiddleware, getUserPlanHandler);

// The mobile app calls /api/chat; /api/chat/send is kept as an alias.
app.post('/api/chat', authMiddleware, chatSendHandler);
app.post('/api/chat/send', authMiddleware, chatSendHandler);

// Payments — same handlers as the Vercel functions, so the backend works
// identically when run via Express (`npm start`) instead of Vercel.
app.post('/api/payment-order', authMiddleware, paymentOrderHandler);
app.post('/api/payment-verify', authMiddleware, paymentVerifyHandler);

// Central error handler — never leak internals.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
