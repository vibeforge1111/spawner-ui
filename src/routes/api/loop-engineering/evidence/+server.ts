import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolveLoopEngineeringEvidenceRef } from '$lib/server/loop-engineering-evidence';

export const GET: RequestHandler = async ({ url }) => {
	const ref = url.searchParams.get('ref') || '';
	const chipKey = url.searchParams.get('chipKey');
	const evidence = await resolveLoopEngineeringEvidenceRef({ ref, chipKey });
	if (!evidence.ref || evidence.error === 'evidence ref required') {
		return json({ ok: false, error: evidence.error || 'evidence ref required' }, { status: 400 });
	}
	return json({ ok: true, evidence });
};
