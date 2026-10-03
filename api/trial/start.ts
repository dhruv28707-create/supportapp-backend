import { trialStartHandler } from '../../src/routes/trialStart';
import { protectedEndpoint } from '../../src/apiWrapper';

export default protectedEndpoint('POST', trialStartHandler);
