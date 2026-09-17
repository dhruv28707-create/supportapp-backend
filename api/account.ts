import { deleteAccountHandler } from '../src/routes/accountDelete';
import { protectedEndpoint } from '../src/apiWrapper';

export default protectedEndpoint('DELETE', deleteAccountHandler);
