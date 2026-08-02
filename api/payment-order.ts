import { paymentOrderHandler } from '../src/routes/paymentOrder';
import { authMiddleware } from '../src/middleware/authMiddleware';
import { enforceCors } from '../src/config/cors';

export default async function handler(req: any, res: any) {
  if (!enforceCors(req, res)) return;

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  await authMiddleware(req, res, () => paymentOrderHandler(req, res));
}
