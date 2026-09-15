import { paymentCancelHandler } from '../src/routes/paymentCancel';
import { protectedEndpoint } from '../src/apiWrapper';

export default protectedEndpoint('POST', paymentCancelHandler);
