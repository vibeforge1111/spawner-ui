import { resolve, sep } from 'node:path';

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export class PathSafetyError extends Error {
	status: 400 | 403;

	constructor(message: string, status: 400 | 403) {
		super(message);
		this.name = 'PathSafetyError';
		this.status = status;
	}
}

export function assertSafeId(id: string, label: string): void {
	if (!SAFE_ID_PATTERN.test(id)) {
		throw new PathSafetyError(`Invalid ${label}`, 400);
	}
}

export function resolveWithinBaseDir(baseDir: string, fileName: string): string {
	const normalizedBase = resolve(baseDir);
	const targetPath = resolve(normalizedBase, fileName);

	if (targetPath === normalizedBase) {
		throw new PathSafetyError('Refusing to operate on base directory path', 403);
	}

	const basePrefix = `${normalizedBase}${sep}`;
	if (!targetPath.startsWith(basePrefix)) {
		throw new PathSafetyError('Path escapes allowed directory', 403);
	}

	return targetPath;
}
