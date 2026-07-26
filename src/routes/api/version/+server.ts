import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import packageMetadata from '../../../../package.json';

export const GET: RequestHandler = async () => {
	return json({
		name: packageMetadata.name,
		version: packageMetadata.version
	});
};
