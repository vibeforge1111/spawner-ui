import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getLoopEngineeringChipDetail } from '$lib/server/loop-engineering-registry';

export const GET: RequestHandler = async ({ params }) => {
	const chip = await getLoopEngineeringChipDetail(params.chipId);
	if (!chip) throw error(404, 'domain chip not found');
	return json({ ok: true, chip });
};
