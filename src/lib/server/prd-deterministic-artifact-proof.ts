import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
	recheckContainedDirectoryInRoots,
	resolveContainedPathInRoots
} from './spark-run-workspace';

export type DeterministicArtifactStatus = 'written' | 'not_written' | 'not_applicable';

interface DeterministicArtifactProofBase {
	status: DeterministicArtifactStatus;
	fileCount: number;
	reason: string;
}

export interface WrittenDeterministicArtifactProof extends DeterministicArtifactProofBase {
	status: 'written';
	schemaVersion: 'spark.deterministic_artifact_proof.v1';
	source: 'spawner_prd_deterministic_writer';
	requestId: string;
	prdContentSha256: string;
	targetRoot: string;
	expectedRelativeFiles: string[];
	fileSha256: Record<string, string>;
	receiptNonce: string;
	proofHmacSha256: string;
}

export interface NonWrittenDeterministicArtifactProof extends DeterministicArtifactProofBase {
	status: 'not_written' | 'not_applicable';
}

export type DeterministicArtifactProof =
	| WrittenDeterministicArtifactProof
	| NonWrittenDeterministicArtifactProof;

export interface DeterministicArtifactVerification {
	ok: boolean;
	reason: string;
	proof: WrittenDeterministicArtifactProof | null;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const NONCE_PATTERN = /^[a-f0-9]{32}$/;
// Process-local by design: provider subprocesses never inherit the signing key.
// A Spawner restart invalidates old receipts and falls back to governed dispatch.
const proofHmacKey = randomBytes(32);

export function sha256Text(value: string): string {
	return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sha256File(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function safeExpectedRelativeFile(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim().replace(/\\/g, '/');
	if (!normalized || isAbsolute(normalized) || normalized.startsWith('/')) return null;
	const segments = normalized.split('/');
	if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
	return normalized;
}

export function expectedRelativeFilesForProjectType(projectType?: string): string[] {
	if (projectType === 'static-exact-file-proof') return ['index.html', 'README.md'];
	if (projectType === 'static-single-file-html') return ['index.html'];
	return [];
}

function sameOrderedStrings(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameResolvedPath(left: string, right: string): boolean {
	const leftResolved = resolve(left);
	const rightResolved = resolve(right);
	return process.platform === 'win32'
		? leftResolved.toLowerCase() === rightResolved.toLowerCase()
		: leftResolved === rightResolved;
}

function proofSignaturePayload(
	proof: Omit<WrittenDeterministicArtifactProof, 'proofHmacSha256'>
): string {
	return JSON.stringify({
		schemaVersion: proof.schemaVersion,
		source: proof.source,
		status: proof.status,
		fileCount: proof.fileCount,
		reason: proof.reason,
		requestId: proof.requestId,
		prdContentSha256: proof.prdContentSha256,
		targetRoot: proof.targetRoot,
		expectedRelativeFiles: proof.expectedRelativeFiles,
		fileSha256: Object.fromEntries(Object.entries(proof.fileSha256).sort(([left], [right]) => left.localeCompare(right))),
		receiptNonce: proof.receiptNonce
	});
}

function signProof(proof: Omit<WrittenDeterministicArtifactProof, 'proofHmacSha256'>): string {
	return createHmac('sha256', proofHmacKey).update(proofSignaturePayload(proof), 'utf8').digest('hex');
}

function hasValidProofSignature(proof: WrittenDeterministicArtifactProof): boolean {
	const expected = Buffer.from(signProof(proof), 'hex');
	const actual = Buffer.from(proof.proofHmacSha256, 'hex');
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function stripProviderDeterministicArtifactProof(metadata: unknown): Record<string, unknown> {
	if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
	const {
		deterministicArtifactProof: _untrustedProviderProof,
		...safeMetadata
	} = metadata as Record<string, unknown>;
	return safeMetadata;
}

export function expectedDeterministicArtifactTargetFromPending(value: unknown): string | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const evidence = (value as Record<string, unknown>).projectPathEvidence;
	if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null;
	const record = evidence as Record<string, unknown>;
	if (record.evidenceOnly === true) return null;
	const usedProjectPath = record.usedProjectPath;
	return typeof usedProjectPath === 'string' && usedProjectPath.trim() && isAbsolute(usedProjectPath)
		? usedProjectPath.trim()
		: null;
}

export function deterministicArtifactProofFromMetadata(
	metadata: unknown
): DeterministicArtifactProof | null {
	if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
	const candidate = (metadata as Record<string, unknown>).deterministicArtifactProof;
	if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
	const record = candidate as Record<string, unknown>;
	const status = record.status;
	const fileCount = record.fileCount;
	const reason = record.reason;
	if (status !== 'written' && status !== 'not_written' && status !== 'not_applicable') return null;
	if (typeof fileCount !== 'number' || !Number.isInteger(fileCount) || fileCount < 0) return null;
	if (typeof reason !== 'string' || !reason.trim()) return null;
	if (status !== 'written') {
		return { status, fileCount, reason: reason.trim() };
	}
	if (record.schemaVersion !== 'spark.deterministic_artifact_proof.v1') return null;
	if (record.source !== 'spawner_prd_deterministic_writer') return null;
	if (typeof record.requestId !== 'string' || !record.requestId.trim()) return null;
	if (typeof record.prdContentSha256 !== 'string' || !SHA256_PATTERN.test(record.prdContentSha256)) return null;
	if (typeof record.targetRoot !== 'string' || !record.targetRoot.trim() || !isAbsolute(record.targetRoot)) return null;
	if (!Array.isArray(record.expectedRelativeFiles)) return null;
	const expectedRelativeFiles = record.expectedRelativeFiles.map(safeExpectedRelativeFile);
	if (expectedRelativeFiles.some((file) => file === null)) return null;
	const safeFiles = expectedRelativeFiles as string[];
	if (safeFiles.length === 0 || fileCount !== safeFiles.length || new Set(safeFiles).size !== safeFiles.length) return null;
	if (!record.fileSha256 || typeof record.fileSha256 !== 'object' || Array.isArray(record.fileSha256)) return null;
	const fileSha256 = record.fileSha256 as Record<string, unknown>;
	if (!sameOrderedStrings(Object.keys(fileSha256).sort(), [...safeFiles].sort())) return null;
	if (Object.values(fileSha256).some((digest) => typeof digest !== 'string' || !SHA256_PATTERN.test(digest))) return null;
	if (typeof record.receiptNonce !== 'string' || !NONCE_PATTERN.test(record.receiptNonce)) return null;
	if (typeof record.proofHmacSha256 !== 'string' || !SHA256_PATTERN.test(record.proofHmacSha256)) return null;
	return {
		status: 'written',
		fileCount,
		reason: reason.trim(),
		schemaVersion: 'spark.deterministic_artifact_proof.v1',
		source: 'spawner_prd_deterministic_writer',
		requestId: record.requestId.trim(),
		prdContentSha256: record.prdContentSha256,
		targetRoot: record.targetRoot.trim(),
		expectedRelativeFiles: safeFiles,
		fileSha256: Object.fromEntries(Object.entries(fileSha256).map(([file, digest]) => [file, String(digest)])),
		receiptNonce: record.receiptNonce,
		proofHmacSha256: record.proofHmacSha256
	};
}

export function createWrittenDeterministicArtifactProof(input: {
	requestId: string;
	prdContent: string;
	targetRoot: string;
	expectedRelativeFiles: string[];
	allowedRoots: string[];
}): WrittenDeterministicArtifactProof {
	const canonicalTarget = recheckContainedDirectoryInRoots(
		input.allowedRoots,
		input.targetRoot,
		'Deterministic artifact target'
	);
	const expectedRelativeFiles = input.expectedRelativeFiles.map(safeExpectedRelativeFile);
	if (expectedRelativeFiles.some((file) => file === null) || expectedRelativeFiles.length === 0) {
		throw new Error('Deterministic artifact proof requires safe relative files.');
	}
	const safeFiles = expectedRelativeFiles as string[];
	const directoryEntries = readdirSync(canonicalTarget).sort();
	if (!sameOrderedStrings(directoryEntries, [...safeFiles].sort())) {
		throw new Error('Deterministic artifact target must contain exactly the expected files.');
	}
	const fileSha256: Record<string, string> = {};
	for (const relativeFile of safeFiles) {
		const canonicalFile = realpathSync(join(canonicalTarget, relativeFile));
		resolveContainedPathInRoots([canonicalTarget], canonicalFile, 'Deterministic artifact file');
		if (!statSync(canonicalFile).isFile()) {
			throw new Error(`Deterministic artifact is not a file: ${relativeFile}`);
		}
		fileSha256[relativeFile] = sha256File(canonicalFile);
	}
	const unsignedProof: Omit<WrittenDeterministicArtifactProof, 'proofHmacSha256'> = {
		status: 'written',
		fileCount: safeFiles.length,
		reason: 'artifacts_written_and_bound',
		schemaVersion: 'spark.deterministic_artifact_proof.v1',
		source: 'spawner_prd_deterministic_writer',
		requestId: input.requestId,
		prdContentSha256: sha256Text(input.prdContent),
		targetRoot: canonicalTarget,
		expectedRelativeFiles: safeFiles,
		fileSha256,
		receiptNonce: randomBytes(16).toString('hex')
	};
	return { ...unsignedProof, proofHmacSha256: signProof(unsignedProof) };
}

export function verifyWrittenDeterministicArtifactProof(input: {
	metadata: unknown;
	requestId: string;
	prdContent: string;
	projectType?: string;
	allowedRoots: string[];
	expectedTargetRoot: string;
}): DeterministicArtifactVerification {
	const parsed = deterministicArtifactProofFromMetadata(input.metadata);
	if (!parsed || parsed.status !== 'written') {
		return { ok: false, reason: 'missing_server_bound_written_proof', proof: null };
	}
	if (!hasValidProofSignature(parsed)) {
		return { ok: false, reason: 'artifact_proof_signature_invalid', proof: null };
	}
	if (parsed.requestId !== input.requestId) {
		return { ok: false, reason: 'artifact_proof_request_mismatch', proof: null };
	}
	if (parsed.prdContentSha256 !== sha256Text(input.prdContent)) {
		return { ok: false, reason: 'artifact_proof_prd_content_mismatch', proof: null };
	}
	const expectedForType = expectedRelativeFilesForProjectType(input.projectType);
	if (!sameOrderedStrings(parsed.expectedRelativeFiles, expectedForType)) {
		return { ok: false, reason: 'artifact_proof_expected_files_mismatch', proof: null };
	}
	let canonicalTarget: string;
	try {
		canonicalTarget = recheckContainedDirectoryInRoots(
			input.allowedRoots,
			parsed.targetRoot,
			'Deterministic artifact target'
		);
	} catch {
		return { ok: false, reason: 'artifact_proof_target_not_contained', proof: null };
	}
	if (!sameResolvedPath(canonicalTarget, parsed.targetRoot)) {
		return { ok: false, reason: 'artifact_proof_target_changed', proof: null };
	}
	let canonicalExpectedTarget: string;
	try {
		canonicalExpectedTarget = recheckContainedDirectoryInRoots(
			input.allowedRoots,
			input.expectedTargetRoot,
			'Expected deterministic artifact target'
		);
	} catch {
		return { ok: false, reason: 'artifact_proof_expected_target_invalid', proof: null };
	}
	if (!sameResolvedPath(canonicalTarget, canonicalExpectedTarget)) {
		return { ok: false, reason: 'artifact_proof_expected_target_mismatch', proof: null };
	}
	try {
		const directoryEntries = readdirSync(canonicalTarget).sort();
		if (!sameOrderedStrings(directoryEntries, [...parsed.expectedRelativeFiles].sort())) {
			return { ok: false, reason: 'artifact_proof_unexpected_directory_entries', proof: null };
		}
	} catch {
		return { ok: false, reason: 'artifact_proof_directory_unreadable', proof: null };
	}
	try {
		for (const relativeFile of parsed.expectedRelativeFiles) {
			const canonicalFile = realpathSync(join(canonicalTarget, relativeFile));
			resolveContainedPathInRoots([canonicalTarget], canonicalFile, 'Deterministic artifact file');
			if (!statSync(canonicalFile).isFile()) {
				return { ok: false, reason: 'artifact_proof_file_missing', proof: null };
			}
			if (sha256File(canonicalFile) !== parsed.fileSha256[relativeFile]) {
				return { ok: false, reason: 'artifact_proof_file_digest_mismatch', proof: null };
			}
		}
	} catch {
		return { ok: false, reason: 'artifact_proof_file_unreadable', proof: null };
	}
	return { ok: true, reason: 'server_bound_artifacts_verified', proof: parsed };
}

export function hasWrittenDeterministicStaticArtifacts(input: {
	projectType?: string;
	metadata?: unknown;
}): boolean {
	const proof = deterministicArtifactProofFromMetadata(input.metadata);
	if (!proof || proof.status !== 'written') return false;
	if (!hasValidProofSignature(proof)) return false;
	return sameOrderedStrings(
		proof.expectedRelativeFiles,
		expectedRelativeFilesForProjectType(input.projectType)
	);
}
