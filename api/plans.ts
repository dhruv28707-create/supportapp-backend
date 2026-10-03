import { plansHandler } from '../src/routes/plans';
import { publicEndpoint } from '../src/apiWrapper';

export default publicEndpoint('GET', plansHandler);
