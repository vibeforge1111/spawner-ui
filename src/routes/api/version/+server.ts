import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	return json({ name: 'spawner-ui', version: '0.0.1' });
};
