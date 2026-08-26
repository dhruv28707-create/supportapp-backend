import { chatSendHandler } from '../src/routes/chatSend';
import { protectedEndpoint } from '../src/apiWrapper';

export default protectedEndpoint('POST', chatSendHandler);
