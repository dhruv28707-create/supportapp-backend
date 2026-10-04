import { publicEndpoint } from '../src/apiWrapper';
import { db } from '../src/config/firebaseAdmin';

export default publicEndpoint('GET', async (_req, res) => {
  try {
    await db.collection('__health').doc('check').get();
    res.json({ status: 'ok', service: 'supportapp-backend', firebase: 'connected' });
  } catch {
    res
      .status(503)
      .json({ status: 'degraded', service: 'supportapp-backend', firebase: 'disconnected' });
  }
});
