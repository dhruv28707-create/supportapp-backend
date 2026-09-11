import { paymentOrderHandler } from '../src/routes/paymentOrder';
import { protectedEndpoint } from '../src/apiWrapper';

export default protectedEndpoint('POST', paymentOrderHandler);
