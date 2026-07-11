import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listLoopEngineeringChips } from '$lib/server/loop-engineering-registry';

export const GET: RequestHandler = async () => {
	const registry = await listLoopEngineeringChips();
	return json({ ok: true, registry });
};
