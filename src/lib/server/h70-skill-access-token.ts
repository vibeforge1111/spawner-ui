import { chmod, mkdir, readFile, writeFile, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { join } from 'path';
import { assertSafeId, PathSafetyError, resolveWithinBaseDir } from './path-safety';
import { spawnerStateDir } from './spawner-state';

const TOKEN_PREFIX = 'spark-h70';
const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000;

interface StoredH70SkillAccessToken {
	schemaVersion: 'spark.h70_skill_access_token.v1';
	tokenHash: string;
	missionId: string;
	skillIds: string[];
	createdAt: string;
	expiresAt: string;
}

export interface H70SkillAccessTokenOptions {
	missionId: string;
	skillIds: string[];
	ttlMs?: number;
	now?: Date;
}

export interface H70SkillAccessProof {
	tokenFile: string;
}

function tokenDir(): string {
	return join(spawnerStateDir(), 'h70-skill-access-tokens');
}

function runtimeTokenDir(): string {
	return join(tokenDir(), 'runtime');
}

function tokenHash(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

function bearerToken(request: Request): string | null {
	const authorization = request.headers.get('authorization') || '';
	const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
	return token?.startsWith(`${TOKEN_PREFIX}-`) ? token : null;
}

function uniqueSkillIds(skillIds: string[]): string[] {
	return [...new Set(skillIds.map((skillId) => skillId.trim()).filter(Boolean))].sort();
}

export async function createH70SkillAccessToken(options: H70SkillAccessTokenOptions): Promise<string | null> {
	const skillIds = uniqueSkillIds(options.skillIds);
	if (skillIds.length === 0) return null;
	assertSafeId(options.missionId, 'missionId');
	for (const skillId of skillIds) {
		assertSafeId(skillId, 'skillId');
	}

	const issuedAt = options.now || new Date();
	const expiresAt = new Date(issuedAt.getTime() + (options.ttlMs ?? DEFAULT_TTL_MS));
	const token = `${TOKEN_PREFIX}-${randomBytes(24).toString('base64url')}`;
	const hash = tokenHash(token);
	const record: StoredH70SkillAccessToken = {
		schemaVersion: 'spark.h70_skill_access_token.v1',
		tokenHash: hash,
		missionId: options.missionId,
		skillIds,
		createdAt: issuedAt.toISOString(),
		expiresAt: expiresAt.toISOString()
	};

	const dir = tokenDir();
	await mkdir(dir, { recursive: true });
	const tokenRecordPath = resolveWithinBaseDir(dir, `${hash}.json`);
        const tokenRecordTmp = tokenRecordPath + '.tmp';
        await writeFile(tokenRecordTmp, JSON.stringify(record, null, 2), 'utf-8');
        await rename(tokenRecordTmp, tokenRecordPath);
	return token;
}

export async function createH70SkillAccessProof(
	options: H70SkillAccessTokenOptions
): Promise<H70SkillAccessProof | null> {
	const token = await createH70SkillAccessToken(options);
	if (!token) return null;

	const dir = runtimeTokenDir();
	await mkdir(dir, { recursive: true });
	const tokenFile = resolveWithinBaseDir(dir, `${options.missionId}.token`);
	const tokenFileTmp = tokenFile + '.tmp';
        await writeFile(tokenFileTmp, token, { encoding: 'utf-8', mode: 0o600 });
        await rename(tokenFileTmp, tokenFile);
	await chmod(tokenFile, 0o600);
	return { tokenFile };
}

export async function verifyH70SkillAccessToken(
	request: Request,
	skillId: string,
	options: { now?: Date } = {}
): Promise<boolean> {
	const token = bearerToken(request);
	if (!token) return false;
	assertSafeId(skillId, 'skillId');
	const hash = tokenHash(token);
	try {
		const file = resolveWithinBaseDir(tokenDir(), `${hash}.json`);
		if (!existsSync(file)) return false;
		const record = JSON.parse(await readFile(file, 'utf-8')) as StoredH70SkillAccessToken;
		if (record.schemaVersion !== 'spark.h70_skill_access_token.v1') return false;
		if (record.tokenHash !== hash) return false;
		if (!record.skillIds.includes(skillId)) return false;
		const now = options.now || new Date();
		return new Date(record.expiresAt).getTime() > now.getTime();
	} catch (error) {
		if (error instanceof PathSafetyError) throw error;
		return false;
	}
}
