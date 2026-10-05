import { getUsageHandler } from '../../src/routes/usage';
import { protectedEndpoint } from '../../src/apiWrapper';

export default protectedEndpoint('GET', getUsageHandler);
