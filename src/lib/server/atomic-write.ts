import { rename, unlink, writeFile } from 'node:fs/promises';

const TRANSIENT_RENAME_ERROR_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const MAX_RENAME_ATTEMPTS = 6;

function isTransientRenameError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		TRANSIENT_RENAME_ERROR_CODES.has(String((error as { code?: unknown }).code))
	);
}

function retryDelayMs(attempt: number): number {
	return 10 * (attempt + 1);
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		await writeFile(tempPath, content, { encoding: 'utf-8', flag: 'wx' });
		for (let attempt = 0; ; attempt += 1) {
			try {
				await rename(tempPath, filePath);
				return;
			} catch (error) {
				if (!isTransientRenameError(error) || attempt >= MAX_RENAME_ATTEMPTS - 1) {
					throw error;
				}
				await sleep(retryDelayMs(attempt));
			}
		}
	} catch (error) {
		await unlink(tempPath).catch(() => undefined);
		throw error;
	}
}
