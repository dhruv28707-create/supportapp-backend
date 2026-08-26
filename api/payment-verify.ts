import { paymentVerifyHandler } from '../src/routes/paymentVerify';
import { protectedEndpoint } from '../src/apiWrapper';

export default protectedEndpoint('POST', paymentVerifyHandler);
