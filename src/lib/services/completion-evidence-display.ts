import type { MissionControlCompletionEvidence } from '$lib/types/mission-control';

export function summarizeCompletionEvidenceForDisplay(
	evidence: MissionControlCompletionEvidence | null | undefined
): string | null {
	if (!evidence || evidence.state === 'not_terminal') return null;
	if (evidence.state === 'complete') return 'Proof complete';
	return 'Needs completion proof';
}

export function completionEvidenceTooltipForDisplay(
	evidence: MissionControlCompletionEvidence | null | undefined
): string | null {
	if (!evidence || evidence.state === 'not_terminal') return null;
	if (evidence.state === 'complete') return 'Completion proof is present.';
	return evidence.summary || 'Completion proof is incomplete.';
}
