import { publicEndpoint } from '../src/apiWrapper';

export default publicEndpoint('GET', (_req, res) => {
  res.json({ status: 'ok', service: 'supportapp-backend' });
});
