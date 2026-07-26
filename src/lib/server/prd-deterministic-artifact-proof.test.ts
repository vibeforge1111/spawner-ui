import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	createWrittenDeterministicArtifactProof,
	deterministicArtifactProofFromMetadata,
	hasWrittenDeterministicStaticArtifacts,
	sha256Text,
	stripProviderDeterministicArtifactProof,
	verifyWrittenDeterministicArtifactProof
} from './prd-deterministic-artifact-proof';

const cleanupPaths: string[] = [];

function createExactStaticFixture() {
	const allowedRoot = mkdtempSync(join(tmpdir(), 'spark-bound-proof-'));
	const targetRoot = join(allowedRoot, 'project');
	const prdContent = 'Create exactly index.html and README.md for this bound proof.';
	mkdirSync(targetRoot, { recursive: true });
	writeFileSync(join(targetRoot, 'index.html'), '<h1>Bound proof</h1>\n', 'utf-8');
	writeFileSync(join(targetRoot, 'README.md'), '# Bound proof\n', 'utf-8');
	cleanupPaths.push(allowedRoot);
	return { allowedRoot, targetRoot, prdContent };
}

afterEach(() => {
	for (const path of cleanupPaths.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

describe('deterministic PRD artifact proof', () => {
	it('rejects non-written and legacy unbound metadata before it can suppress auto-run', () => {
		expect(
			hasWrittenDeterministicStaticArtifacts({
				projectType: 'static-exact-file-proof',
				metadata: {
					deterministicArtifactProof: {
						status: 'not_written',
						fileCount: 0,
						reason: 'safe_exact_artifact_target_unavailable'
					}
				}
			})
		).toBe(false);
		const legacyUnboundMetadata = {
			deterministicArtifactProof: {
				status: 'written',
				fileCount: 2,
				reason: 'artifacts_written'
			}
		};
		expect(deterministicArtifactProofFromMetadata(legacyUnboundMetadata)).toBeNull();
		expect(
			hasWrittenDeterministicStaticArtifacts({
				projectType: 'static-exact-file-proof',
				metadata: legacyUnboundMetadata
			})
		).toBe(false);
	});

	it('creates and verifies a server-bound proof for the exact deterministic files', () => {
		const { allowedRoot, targetRoot, prdContent } = createExactStaticFixture();
		const requestId = 'bound-proof-request';
		const proof = createWrittenDeterministicArtifactProof({
			requestId,
			prdContent,
			targetRoot,
			expectedRelativeFiles: ['index.html', 'README.md'],
			allowedRoots: [allowedRoot]
		});
		const metadata = { deterministicArtifactProof: proof };

		expect(proof).toMatchObject({
			status: 'written',
			fileCount: 2,
			reason: 'artifacts_written_and_bound',
			schemaVersion: 'spark.deterministic_artifact_proof.v1',
			source: 'spawner_prd_deterministic_writer',
			requestId,
			prdContentSha256: sha256Text(prdContent),
			expectedRelativeFiles: ['index.html', 'README.md']
		});
		expect(Object.keys(proof.fileSha256).sort()).toEqual(['README.md', 'index.html']);
		expect(proof.receiptNonce).toMatch(/^[a-f0-9]{32}$/);
		expect(proof.proofHmacSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(Object.values(proof.fileSha256)).toEqual([
			expect.stringMatching(/^[a-f0-9]{64}$/),
			expect.stringMatching(/^[a-f0-9]{64}$/)
		]);
		expect(deterministicArtifactProofFromMetadata(metadata)).toEqual(proof);
		expect(
			hasWrittenDeterministicStaticArtifacts({
				projectType: 'static-exact-file-proof',
				metadata
			})
		).toBe(true);
		expect(
			verifyWrittenDeterministicArtifactProof({
				metadata,
				requestId,
				prdContent,
				projectType: 'static-exact-file-proof',
				allowedRoots: [allowedRoot],
				expectedTargetRoot: targetRoot
			})
		).toEqual({
			ok: true,
			reason: 'server_bound_artifacts_verified',
			proof
		});
	});

	it('fails closed for replayed requests, changed PRD content, file lists, and file bytes', () => {
		const { allowedRoot, targetRoot, prdContent } = createExactStaticFixture();
		const requestId = 'bound-proof-replay-source';
		const proof = createWrittenDeterministicArtifactProof({
			requestId,
			prdContent,
			targetRoot,
			expectedRelativeFiles: ['index.html', 'README.md'],
			allowedRoots: [allowedRoot]
		});
		const metadata = { deterministicArtifactProof: proof };
		const verification = (overrides: Partial<Parameters<typeof verifyWrittenDeterministicArtifactProof>[0]>) =>
			verifyWrittenDeterministicArtifactProof({
				metadata,
				requestId,
				prdContent,
				projectType: 'static-exact-file-proof',
				allowedRoots: [allowedRoot],
				expectedTargetRoot: targetRoot,
				...overrides
			});

		expect(verification({ requestId: 'different-request' })).toMatchObject({
			ok: false,
			reason: 'artifact_proof_request_mismatch'
		});
		expect(verification({ prdContent: `${prdContent}\nChanged.` })).toMatchObject({
			ok: false,
			reason: 'artifact_proof_prd_content_mismatch'
		});
		expect(verification({ projectType: 'static-single-file-html' })).toMatchObject({
			ok: false,
			reason: 'artifact_proof_expected_files_mismatch'
		});
		expect(verification({ expectedTargetRoot: allowedRoot })).toMatchObject({
			ok: false,
			reason: 'artifact_proof_expected_target_mismatch'
		});

		const unexpectedFile = join(targetRoot, 'malicious.js');
		writeFileSync(unexpectedFile, 'unexpected', 'utf-8');
		expect(verification({})).toMatchObject({
			ok: false,
			reason: 'artifact_proof_unexpected_directory_entries'
		});
		rmSync(unexpectedFile, { force: true });

		writeFileSync(join(targetRoot, 'index.html'), '<h1>Tampered after proof</h1>\n', 'utf-8');
		expect(verification({})).toMatchObject({
			ok: false,
			reason: 'artifact_proof_file_digest_mismatch'
		});
	});

	it('rejects forged receipt signatures and strips provider-supplied proof metadata', () => {
		const { allowedRoot, targetRoot, prdContent } = createExactStaticFixture();
		const requestId = 'bound-proof-forgery';
		const proof = createWrittenDeterministicArtifactProof({
			requestId,
			prdContent,
			targetRoot,
			expectedRelativeFiles: ['index.html', 'README.md'],
			allowedRoots: [allowedRoot]
		});
		const forged = { ...proof, proofHmacSha256: '0'.repeat(64) };
		expect(
			verifyWrittenDeterministicArtifactProof({
				metadata: { deterministicArtifactProof: forged },
				requestId,
				prdContent,
				projectType: 'static-exact-file-proof',
				allowedRoots: [allowedRoot],
				expectedTargetRoot: targetRoot
			})
		).toMatchObject({ ok: false, reason: 'artifact_proof_signature_invalid' });
		expect(
			stripProviderDeterministicArtifactProof({
				deterministicArtifactProof: proof,
				providerMetric: 'retained'
			})
		).toEqual({ providerMetric: 'retained' });
	});
});
