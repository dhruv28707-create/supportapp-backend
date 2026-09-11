import { diagnoseHandler } from '../src/routes/diagnose';
import { publicEndpoint } from '../src/apiWrapper';

export default publicEndpoint('GET', diagnoseHandler);
