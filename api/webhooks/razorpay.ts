import { razorpayWebhookHandler } from '../../src/routes/razorpayWebhook';
import { enforceCors } from '../../src/config/cors';

// Ask the platform not to pre-parse the JSON body so the handler can verify
// the HMAC over the exact raw bytes. The handler also works if this is ignored.
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req: any, res: any) {
  if (!enforceCors(req, res)) return;

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  await razorpayWebhookHandler(req, res);
}
