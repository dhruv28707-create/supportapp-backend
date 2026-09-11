import { getUserPlanHandler } from '../../src/routes/userPlan';
import { protectedEndpoint } from '../../src/apiWrapper';

export default protectedEndpoint('GET', getUserPlanHandler);
