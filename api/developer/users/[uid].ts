import { getDeveloperUserHandler } from '../../../src/routes/developer';
import { developerEndpoint } from '../../../src/apiWrapper';

export default developerEndpoint('GET', getDeveloperUserHandler);
