import { razorpayWebhookHandler } from '../../src/routes/razorpayWebhook';
import { publicEndpoint } from '../../src/apiWrapper';

// Ask the platform not to pre-parse the JSON body so the handler can verify
// the HMAC over the exact raw bytes. The handler also works if this is ignored.
export const config = {
  api: {
    bodyParser: false,
  },
};

export default publicEndpoint('POST', razorpayWebhookHandler);
