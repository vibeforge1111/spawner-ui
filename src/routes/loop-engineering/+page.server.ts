import type { PageServerLoad } from './$types';
import { listLoopEngineeringChips } from '$lib/server/loop-engineering-registry';

export const load: PageServerLoad = async () => {
	return {
		registry: await listLoopEngineeringChips()
	};
};
