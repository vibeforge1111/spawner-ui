import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { appendFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { relayMissionControlEvent } from '$lib/server/mission-control-relay';
import { autoDispatchPrdCanvasLoad } from '$lib/server/prd-auto-dispatch';
import {
	missionControlPathForMission,
	resolveMissionControlAccess
} from '$lib/server/mission-control-access';
import { spawnerStateDir } from '$lib/server/spawner-state';
import {
	capabilityProposalSummary,
	normalizeCapabilityProposalPacket
} from '$lib/server/capability-proposal-packet';
import { extractTraceRef, normalizeTraceRef, traceRefFromMissionId } from '$lib/server/trace-ref';
import { pendingRequestFileForRequest, readPendingRequestRecord } from '$lib/server/prd-pending-requests';
import { writeFileAtomic } from '$lib/server/atomic-write';
import {
	HarnessAuthorityError,
	assertNativeGovernorHarnessAuthority,
	resolveExecutionAuthority,
	type HarnessAuthorityVerdict
} from '$lib/server/harness-authority';
import { stripAuthorityResidue } from '$lib/server/authority-residue';
import { requireControlAuth } from '$lib/server/mcp-auth';
import { parseJsonOrThrow } from '$lib/utils/safe-json';

function getSpawnerDir(): string {
	return spawnerStateDir();
}

function getLoadArchiveDir(): string {
	return join(getSpawnerDir(), 'canvas-loads');
}

function safeLoadFileKey(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200) || 'unknown';
}

function archivedLoadFileForPipeline(pipelineId: string): string {
	return join(getLoadArchiveDir(), `${safeLoadFileKey(pipelineId)}.json`);
}

function archivedLoadFileForMission(missionId: string): string {
	return join(getLoadArchiveDir(), `mission-${safeLoadFileKey(missionId)}.json`);
}

function resultFilePath(requestId: string): string {
	const safe = requestId.replace(/[^a-zA-Z0-9_-]/g, '_');
	return join(getSpawnerDir(), 'results', `${safe}.json`);
}

async function appendPrdTrace(requestId: string, event: string, details: Record<string, unknown> = {}): Promise<void> {
	try {
		const row = {
			ts: new Date().toISOString(),
			requestId,
			event,
			...details
		};
		await appendFile(join(getSpawnerDir(), 'prd-auto-trace.jsonl'), `${JSON.stringify(row)}\n`, 'utf-8');
	} catch {
		// Trace writes are evidence only; never fail the live build path.
	}
}

function traceRefDetails(traceRef: string | null | undefined): Record<string, string> {
	return traceRef ? { traceRef } : {};
}

function normalizeTelegramRelay(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const raw = value as Record<string, unknown>;
	const relay: Record<string, unknown> = {};
	if (typeof raw.profile === 'string' && raw.profile.trim()) {
		relay.profile = raw.profile.trim();
	}
	if (typeof raw.url === 'string' && raw.url.trim()) {
		relay.url = raw.url.trim();
	}
	const port = typeof raw.port === 'number' ? raw.port : typeof raw.port === 'string' ? Number(raw.port.trim()) : NaN;
	if (Number.isFinite(port) && port > 0) {
		relay.port = Math.trunc(port);
	}
	return Object.keys(relay).length > 0 ? relay : undefined;
}

function normalizeRequestId(requestId: string): string {
	return requestId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function missionIdFromRequestId(requestId: string): string {
	const normalized = normalizeRequestId(requestId);
	const stamp = normalized.match(/(\d{10,})$/)?.[1];
	return `mission-${stamp || normalized}`;
}

interface TaskRecord {
	id: string;
	title: string;
	summary?: string;
	description?: string;
	skills?: string[];
	dependencies?: string[];
	workspaceTargets?: string[];
	acceptanceCriteria?: string[];
	verificationCommands?: string[];
}

function executionTextFromResult(parsed: {
	projectName?: string;
	executionPrompt?: string;
	tasks?: TaskRecord[];
}): string {
	if (typeof parsed.executionPrompt === 'string' && parsed.executionPrompt.trim()) {
		return parsed.executionPrompt;
	}
	const lines = [
		`Build ${parsed.projectName || 'the requested project'} from the structured PRD canvas.`,
		...(parsed.tasks || []).flatMap((task) => [
			`Task ${task.id}: ${task.title}`,
			...(task.summary ? [`Summary: ${task.summary}`] : []),
			...(task.description ? [`Description: ${task.description}`] : []),
			...((task.acceptanceCriteria || []).map((criterion) => `Acceptance: ${criterion}`)),
			...((task.verificationCommands || []).map((command) => `Verify: ${command}`))
		])
	];
	return lines.join('\n');
}

function storedCanvasLoad(load: Record<string, unknown>): Record<string, unknown> {
	const { executionPrompt: _executionPrompt, metadata, ...rest } = load;
	const metadataRecord = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
		? (metadata as Record<string, unknown>)
		: {};
	return stripAuthorityResidue({
		...rest,
		metadata: {
			...metadataRecord,
			instructionTextRedacted: true,
			instructionTextStorage: 'ephemeral_dispatch_only'
		},
		instructionTextRedacted: true
	});
}

function taskSkillId(taskId: string): string {
	const normalized = taskId.trim() || 'task';
	return normalized.startsWith('task-') ? normalized : `task-${normalized}`;
}

function taskDisplayName(task: TaskRecord): string {
	const title = (task.title || task.id || 'Untitled task').trim();
	const prefix = `${task.id}:`;
	return title.startsWith(prefix) ? title.slice(prefix.length).trim() || title : title;
}

function taskSkillTags(task: TaskRecord): string[] {
	return [...new Set((task.skills || []).map((skill) => skill.trim()).filter(Boolean))];
}

function buildTaskDescription(task: TaskRecord): string {
	const lines = [task.summary || task.description || task.title];

	if (task.workspaceTargets?.length) {
		lines.push('', 'Workspace targets:', ...task.workspaceTargets.map((target) => `- ${target}`));
	}

	if (task.acceptanceCriteria?.length) {
		lines.push('', 'Acceptance criteria:', ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`));
	}

	if (task.verificationCommands?.length) {
		lines.push('', 'Verification commands:', ...task.verificationCommands.map((command) => `- ${command}`));
	}

	return lines.join('\n');
}

function taskToNode(task: TaskRecord, index: number) {
	const row = Math.floor(index / 3);
	const col = index % 3;
	const skills = taskSkillTags(task);
	return {
		skill: {
			id: taskSkillId(task.id),
			name: taskDisplayName(task),
			description: buildTaskDescription(task),
			category: 'project',
			tier: 'free',
			tags: skills,
			skillChain: skills,
			chainDescription: skills.length > 0 ? `Paired skills: ${skills.join(', ')}` : undefined,
			triggers: ['prd-import']
		},
		position: { x: 160 + col * 320, y: 140 + row * 200 }
	};
}

function buildConnections(tasks: TaskRecord[]): Array<{ sourceIndex: number; targetIndex: number }> {
	const idxById = new Map<string, number>();
	tasks.forEach((t, i) => idxById.set(t.id, i));

	const conns: Array<{ sourceIndex: number; targetIndex: number }> = [];
	for (let i = 0; i < tasks.length; i++) {
		const deps = tasks[i].dependencies || [];
		for (const dep of deps) {
			const src = idxById.get(dep);
			if (src !== undefined) conns.push({ sourceIndex: src, targetIndex: i });
		}
	}
	return conns;
}

function canvasMaterializationSummary(nodes: ReturnType<typeof taskToNode>[]) {
	const pairedNodeCount = nodes.filter((node) => node.skill.skillChain.length > 0).length;
	const skillCount = new Set(nodes.flatMap((node) => node.skill.skillChain)).size;
	return {
		materialized: true,
		nodeCount: nodes.length,
		pairedNodeCount,
		skillCount,
		pairingStatus: nodes.length === 0 || pairedNodeCount === 0
			? 'missing'
			: pairedNodeCount === nodes.length
				? 'complete'
				: 'partial'
	};
}

function boardPathForMission(missionId: string): string {
	return `/kanban?mission=${encodeURIComponent(missionId)}`;
}

function canvasPathForPipeline(pipelineId: string, missionId: string): string {
	return `/canvas?pipeline=${encodeURIComponent(pipelineId)}&mission=${encodeURIComponent(missionId)}`;
}

function workflowHandoffFromDispatch(input: {
	canvasReadyForHandoff: boolean;
	canvasUrl: string;
	autoDispatchResult: Awaited<ReturnType<typeof autoDispatchPrdCanvasLoad>>;
}) {
	if (!input.canvasReadyForHandoff) {
		return {
			status: 'withheld',
			reason: 'canvas_handoff_requires_materialized_nodes_and_complete_skill_pairings',
			canvasUrl: null
		};
	}
	if (input.autoDispatchResult.started) {
		return {
			status: 'ready',
			reason: 'canvas_nodes_skill_pairings_and_workflow_execution_created',
			canvasUrl: input.canvasUrl
		};
	}
	return {
		status: 'withheld',
		reason: input.autoDispatchResult.error || input.autoDispatchResult.reason || 'workflow_execution_was_not_created',
		canvasUrl: null
	};
}

export const POST: RequestHandler = async (event) => {
	const unauthorized = requireControlAuth(event, {
		surface: 'PRDBridgeLoadToCanvas',
		apiKeyEnvVar: 'SPARK_BRIDGE_API_KEY',
		fallbackApiKeyEnvVars: ['EVENTS_API_KEY', 'MCP_API_KEY'],
		apiKeyQueryParam: 'apiKey',
		apiKeyCookieName: 'spawner_events_api_key',
		allowLoopbackWithoutKey: false,
		allowedOriginsEnvVar: 'EVENTS_ALLOWED_ORIGINS'
	});
	if (unauthorized) return unauthorized;

	try {
		const { request } = event;
		const { requestId, autoRun, telegramRelay, missionId, chatId, userId, goal, buildMode: bodyBuildMode, buildModeReason: bodyBuildModeReason, traceRef, trace_ref, executionAuthority, execution_authority } = await request.json();
		const normalizedTelegramRelay = normalizeTelegramRelay(telegramRelay);
		if (!requestId || typeof requestId !== 'string') {
			return json({ error: 'requestId (string) required' }, { status: 400 });
		}
		const resolvedMissionId = typeof missionId === 'string' && missionId.trim()
			? missionId.trim()
			: missionIdFromRequestId(requestId);
		let resolvedTraceRef = normalizeTraceRef(traceRef ?? trace_ref);

		const path = resultFilePath(requestId);
		const spawnerDir = getSpawnerDir();
		const pendingLoadFile = join(spawnerDir, 'pending-load.json');
		const lastLoadFile = join(spawnerDir, 'last-canvas-load.json');
		const pendingRequestFile = join(spawnerDir, 'pending-request.json');
		if (!existsSync(path)) {
			await appendPrdTrace(requestId, 'canvas_load_waiting_for_result', {
				missionId: resolvedMissionId,
				...traceRefDetails(resolvedTraceRef)
			});
			return json({ error: 'No analysis result found for that request.' }, { status: 404 });
		}

		const raw = await readFile(path, 'utf-8');
		const parsed = parseJsonOrThrow<{
			success?: boolean;
			projectName?: string;
			projectType?: string;
			executionPrompt?: string;
			tier?: string;
			tasks?: TaskRecord[];
			metadata?: Record<string, unknown>;
			capabilityProposalPacket?: unknown;
			capability_proposal_packet?: unknown;
		}>(raw, `prd-result:${requestId}`);

		if (!parsed.success || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
			await appendPrdTrace(requestId, 'canvas_load_rejected_empty_result', {
				missionId: resolvedMissionId,
				...traceRefDetails(resolvedTraceRef)
			});
			return json({ error: 'Result has no tasks to load' }, { status: 422 });
		}

		const nodes = parsed.tasks.map(taskToNode);
		const connections = buildConnections(parsed.tasks);
		const canvasMaterialization = canvasMaterializationSummary(nodes);
		const deterministicStaticResult =
			parsed.projectType === 'static-exact-file-proof' || parsed.projectType === 'static-single-file-html';
		let effectiveAutoRun = autoRun !== false && !deterministicStaticResult;
		let dispatchAuthority: unknown;
		let dispatchAuthorityVerdict: HarnessAuthorityVerdict | undefined;
		let dispatchAuthorityBlock: HarnessAuthorityVerdict | undefined;
		if (effectiveAutoRun) {
			dispatchAuthority = resolveExecutionAuthority(executionAuthority, execution_authority);
			try {
				dispatchAuthorityVerdict = assertNativeGovernorHarnessAuthority({
					authority: dispatchAuthority,
					toolName: 'spawner.dispatch',
					ownerSystem: 'spawner-ui',
					mutationClass: 'launches_mission',
					requestId
				});
			} catch (error) {
				if (!(error instanceof HarnessAuthorityError)) throw error;
				dispatchAuthority = undefined;
				dispatchAuthorityBlock = error.verdict;
				effectiveAutoRun = false;
				await appendPrdTrace(requestId, 'canvas_auto_run_authority_withheld', {
					missionId: resolvedMissionId,
					...traceRefDetails(resolvedTraceRef),
					reasonCodes: dispatchAuthorityBlock.reasonCodes,
					source: dispatchAuthorityBlock.source,
					governorOutcome: dispatchAuthorityBlock.governorOutcome ?? null
				});
			}
		}

		if (!existsSync(spawnerDir)) {
			await mkdir(spawnerDir, { recursive: true });
		}
		await mkdir(getLoadArchiveDir(), { recursive: true });

		let relay: Record<string, unknown> | undefined;
		let buildMode: 'direct' | 'advanced_prd' = bodyBuildMode === 'advanced_prd' ? 'advanced_prd' : 'direct';
		let buildModeReason = typeof bodyBuildModeReason === 'string' ? bodyBuildModeReason : '';
		let pendingRequestMeta: Record<string, unknown> | null = null;
		let capabilityProposalPacket = normalizeCapabilityProposalPacket(
			parsed.capabilityProposalPacket ?? parsed.capability_proposal_packet
		);
		{
			try {
				const pending = ((await readPendingRequestRecord(spawnerDir, requestId)) ?? {}) as {
					requestId?: string;
					relay?: Record<string, unknown>;
					buildMode?: 'direct' | 'advanced_prd';
					buildModeReason?: string;
					tier?: string;
				};
				if (pending.requestId === requestId) {
					pendingRequestMeta = pending as Record<string, unknown>;
					resolvedTraceRef =
						resolvedTraceRef ||
						extractTraceRef(pendingRequestMeta, parsed) ||
						traceRefFromMissionId(resolvedMissionId);
					capabilityProposalPacket =
						normalizeCapabilityProposalPacket(pendingRequestMeta.capabilityProposalPacket) ||
						capabilityProposalPacket;
				}
				if (pending.requestId === requestId) {
					buildMode = pending.buildMode === 'advanced_prd' ? 'advanced_prd' : 'direct';
					buildModeReason = typeof pending.buildModeReason === 'string' ? pending.buildModeReason : '';
				}
				if (pending.requestId === requestId && pending.relay) {
					relay = {
						...pending.relay,
						missionId: resolvedMissionId,
						...(typeof pending.tier === 'string' ? { tier: pending.tier } : {}),
						...(normalizedTelegramRelay ? { telegramRelay: normalizedTelegramRelay } : {}),
						requestId,
						...(resolvedTraceRef ? { traceRef: resolvedTraceRef } : {}),
						autoRun: effectiveAutoRun,
						buildMode,
						buildModeReason
					};
				}
			} catch {
				// Relay metadata is best-effort; canvas loading should still work.
			}
		}
		resolvedTraceRef = resolvedTraceRef || extractTraceRef(parsed) || traceRefFromMissionId(resolvedMissionId);
		const capabilitySummary = capabilityProposalSummary(capabilityProposalPacket);
		if (!relay && (typeof chatId === 'string' || typeof userId === 'string' || typeof goal === 'string' || normalizedTelegramRelay)) {
			relay = {
				missionId: resolvedMissionId,
				...(typeof chatId === 'string' && chatId.trim() ? { chatId: chatId.trim() } : {}),
				...(typeof userId === 'string' && userId.trim() ? { userId: userId.trim() } : {}),
				requestId,
				...(resolvedTraceRef ? { traceRef: resolvedTraceRef } : {}),
				...(typeof goal === 'string' && goal.trim() ? { goal } : {}),
				...(normalizedTelegramRelay ? { telegramRelay: normalizedTelegramRelay } : {}),
				autoRun: effectiveAutoRun,
				buildMode,
				buildModeReason,
				...(dispatchAuthority ? { executionAuthority: dispatchAuthority } : {})
			};
		}
		if (relay && !relay.missionId) {
			relay.missionId = resolvedMissionId;
		}
		if (relay && resolvedTraceRef && !relay.traceRef) {
			relay.traceRef = resolvedTraceRef;
		}
		if (relay && dispatchAuthority && !relay.executionAuthority) {
			relay.executionAuthority = dispatchAuthority;
		}
		if (relay) {
			relay.autoRun = effectiveAutoRun;
		}

		const executionText = executionTextFromResult(parsed);
		const load = {
			requestId,
			missionId: resolvedMissionId,
			...(resolvedTraceRef ? { traceRef: resolvedTraceRef } : {}),
			pipelineId: `prd-${requestId}`,
			pipelineName: parsed.projectName || `PRD ${requestId}`,
			nodes,
			connections,
			source: 'prd-bridge',
			autoRun: effectiveAutoRun,
			buildMode,
			buildModeReason,
			tier: typeof pendingRequestMeta?.tier === 'string'
				? pendingRequestMeta.tier
				: typeof parsed.tier === 'string'
					? parsed.tier
					: 'base',
			executionPrompt: executionText,
			...(capabilityProposalPacket ? { capabilityProposalPacket } : {}),
			...(capabilitySummary ? { capabilityProposalSummary: capabilitySummary } : {}),
			...(dispatchAuthority ? { executionAuthority: dispatchAuthority } : {}),
			metadata: {
				...(parsed.metadata && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata)
					? parsed.metadata
					: {}),
				...(resolvedTraceRef ? { traceRef: resolvedTraceRef } : {}),
				...(capabilityProposalPacket ? { capabilityProposalPacket } : {}),
				...(capabilitySummary ? { capabilityProposalSummary: capabilitySummary } : {}),
				...(dispatchAuthority ? { executionAuthority: dispatchAuthority } : {}),
				...(dispatchAuthorityVerdict ? { dispatchAuthority: dispatchAuthorityVerdict } : {}),
				...(dispatchAuthorityBlock ? { dispatchAuthorityBlock } : {})
			},
			relay,
			timestamp: new Date().toISOString()
		};
		const missionControlAccess = resolveMissionControlAccess(missionControlPathForMission(resolvedMissionId));
		const boardUrl = boardPathForMission(resolvedMissionId);
		const canvasUrl = canvasPathForPipeline(load.pipelineId, resolvedMissionId);
		const canvasReadyForHandoff =
			canvasMaterialization.nodeCount > 0 &&
			canvasMaterialization.pairedNodeCount === canvasMaterialization.nodeCount &&
			canvasMaterialization.pairingStatus === 'complete';
		const canvasHandoff = {
			status: canvasReadyForHandoff ? 'ready' : 'withheld',
			reason: canvasReadyForHandoff
				? 'nodes_and_skill_pairings_materialized'
				: 'canvas_handoff_requires_materialized_nodes_and_complete_skill_pairings',
			boardFirst: true,
			canvasUrl: canvasReadyForHandoff ? canvasUrl : null
		};

		const persistedLoad = storedCanvasLoad(load);
		const persistedLoadJson = JSON.stringify(persistedLoad, null, 2);
		await writeFileAtomic(pendingLoadFile, persistedLoadJson);
		await writeFileAtomic(lastLoadFile, persistedLoadJson);
		await writeFileAtomic(archivedLoadFileForPipeline(load.pipelineId), persistedLoadJson);
		await writeFileAtomic(archivedLoadFileForMission(resolvedMissionId), persistedLoadJson);
		await appendPrdTrace(requestId, 'canvas_load_materialized', {
			missionId: resolvedMissionId,
			...traceRefDetails(resolvedTraceRef),
			pipelineId: load.pipelineId,
			archivedLoadRefs: [
				`canvas-loads/${safeLoadFileKey(load.pipelineId)}.json`,
				`canvas-loads/mission-${safeLoadFileKey(resolvedMissionId)}.json`
			],
			autoRunRequested: autoRun !== false,
			autoRunEffective: effectiveAutoRun,
			canvasReadyForHandoff,
			canvasMaterialization
		});
		if (pendingRequestMeta) {
			const updatedPendingRequest = JSON.stringify(
				{
					...pendingRequestMeta,
					status: 'canvas_loaded',
					canvasLoadedAt: new Date().toISOString(),
					...(resolvedTraceRef ? { traceRef: resolvedTraceRef } : {}),
					pipelineId: load.pipelineId,
					boardUrl,
					...(canvasReadyForHandoff ? { canvasUrl } : {}),
					canvasHandoff,
					missionControlAccess,
					...(capabilityProposalPacket ? { capabilityProposalPacket } : {}),
					...(capabilitySummary ? { capabilityProposalSummary: capabilitySummary } : {})
				},
				null,
				2
			);
			// RequestId-scoped record is the source of truth; the singleton stays
			// a back-compat pointer and is only refreshed when it still points at
			// this request.
			const scopedPendingRequestFile = pendingRequestFileForRequest(spawnerDir, requestId);
			if (existsSync(scopedPendingRequestFile)) {
				await writeFileAtomic(scopedPendingRequestFile, updatedPendingRequest);
			}
			if (existsSync(pendingRequestFile)) {
				try {
					const singleton = JSON.parse(await readFile(pendingRequestFile, 'utf-8')) as Record<string, unknown>;
					if (singleton.requestId === requestId) {
						await writeFileAtomic(pendingRequestFile, updatedPendingRequest);
					}
				} catch {
					await writeFileAtomic(pendingRequestFile, updatedPendingRequest);
				}
			} else {
				await writeFileAtomic(pendingRequestFile, updatedPendingRequest);
			}
		}
		// Guard against duplicate lifecycle relays when the upstream caller
		// (Telegram bot, MCP) retries this POST after a transient network error.
		// pendingRequestMeta.status === 'canvas_loaded' means a prior successful
		// call already fired these relays; skipping them here keeps the
		// operator-facing notifications (and downstream board entries) one-shot.
		const alreadyLoaded =
			!!pendingRequestMeta && pendingRequestMeta.status === 'canvas_loaded';
		if (!alreadyLoaded) void relayMissionControlEvent({
			type: 'task_completed',
			missionId: resolvedMissionId,
			missionName: load.pipelineName,
			taskName: 'PRD analysis',
			message: `PRD analysis completed for ${load.pipelineName}.`,
			source: 'prd-bridge',
			data: {
				requestId,
				...(resolvedTraceRef ? { traceRef: resolvedTraceRef } : {}),
				pipelineId: load.pipelineId,
				executionPolicy: 'read_only',
				buildMode,
				buildModeReason
			}
		});
		if (!alreadyLoaded) void relayMissionControlEvent({
			type: 'mission_created',
			missionId: resolvedMissionId,
			missionName: load.pipelineName,
			taskName: 'Canvas ready',
			message: `Canvas ready for ${load.pipelineName}. ${nodes.length} task(s) queued.`,
			source: 'prd-bridge',
			data: {
				requestId,
				...(resolvedTraceRef ? { traceRef: resolvedTraceRef } : {}),
				pipelineId: load.pipelineId,
				executionPolicy: 'read_only',
				buildMode,
				buildModeReason,
				...(capabilitySummary ? { capabilityProposal: capabilitySummary } : {}),
				...(parsed.metadata?.taskQuality ? { taskQuality: parsed.metadata.taskQuality } : {}),
				plannedTasks: parsed.tasks.map((task) => ({
					title: task.title,
					skills: task.skills || []
				})),
				...(relay?.projectLineage ? { projectLineage: relay.projectLineage } : {}),
				...(relay ? { telegramRelay: relay.telegramRelay } : {})
			}
		});

		const autoDispatchResult = effectiveAutoRun
			? await autoDispatchPrdCanvasLoad(load, { allowExistingNonTerminalMission: true })
			: {
					started: false,
					skipped: true,
					reason: deterministicStaticResult
						? 'deterministic static artifacts already written'
						: dispatchAuthorityBlock
							? `autoRun requires native GovernorDecisionV1 authority: ${dispatchAuthorityBlock.reasonCodes.join(', ')}`
							: 'autoRun disabled',
					missionId: resolvedMissionId
				};
		await appendPrdTrace(requestId, autoDispatchResult.started ? 'canvas_auto_dispatch_started' : 'canvas_auto_dispatch_withheld', {
			missionId: resolvedMissionId,
			...traceRefDetails(resolvedTraceRef),
			pipelineId: load.pipelineId,
			started: autoDispatchResult.started,
			skipped: Boolean(autoDispatchResult.skipped),
			reason: autoDispatchResult.reason || null,
			error: autoDispatchResult.error || null
		});
		const workflowHandoff = workflowHandoffFromDispatch({
			canvasReadyForHandoff,
			canvasUrl,
			autoDispatchResult
		});
		if (!autoDispatchResult.started && autoDispatchResult.skipped) {
			void relayMissionControlEvent({
				type: 'log',
				missionId: resolvedMissionId,
				missionName: load.pipelineName,
				taskName: 'Workflow start withheld',
				message: `Workflow start withheld: ${autoDispatchResult.reason || 'autoRun disabled'}.`,
				source: 'prd-bridge',
				data: {
					requestId,
					...(resolvedTraceRef ? { traceRef: resolvedTraceRef } : {}),
					executionPolicy: 'read_only',
					buildMode,
					buildModeReason,
					reason: autoDispatchResult.reason,
					...(dispatchAuthorityBlock ? { authority: dispatchAuthorityBlock } : {}),
					...(relay?.projectLineage ? { projectLineage: relay.projectLineage } : {}),
					...(relay ? { telegramRelay: relay.telegramRelay } : {})
				}
			});
		}
		if (!autoDispatchResult.started && !autoDispatchResult.skipped) {
			void relayMissionControlEvent({
				type: 'log',
				missionId: resolvedMissionId,
				missionName: load.pipelineName,
				taskName: 'Auto-start',
				message: `Canvas auto-start failed: ${autoDispatchResult.error || 'unknown error'}`,
				source: 'prd-auto-dispatch',
				data: {
					requestId,
					...(resolvedTraceRef ? { traceRef: resolvedTraceRef } : {}),
					buildMode,
					buildModeReason,
					error: autoDispatchResult.error,
					...(relay?.projectLineage ? { projectLineage: relay.projectLineage } : {}),
					...(relay ? { telegramRelay: relay.telegramRelay } : {})
				}
			});
		}

		return json({
			success: true,
			pipelineId: load.pipelineId,
			pipelineName: load.pipelineName,
			...(resolvedTraceRef ? { traceRef: resolvedTraceRef } : {}),
			taskCount: nodes.length,
			connectionCount: connections.length,
			autoDispatch: autoDispatchResult,
			...(dispatchAuthorityVerdict ? { authority: dispatchAuthorityVerdict } : {}),
			...(dispatchAuthorityBlock ? { authority: dispatchAuthorityBlock } : {}),
			canvasMaterialized: canvasMaterialization.materialized,
			canvasMaterialization,
			boardUrl,
			canvasHandoff,
			workflowHandoff,
			...(canvasReadyForHandoff ? { canvasUrl } : {}),
			missionControlAccess
		});
	} catch (error) {
		return json({ error: 'Failed to load PRD result into canvas.' }, { status: 500 });
	}
};
