/**
 * Zod Schemas for Runtime Validation
 *
 * These schemas provide runtime validation for JSON.parse results
 * to prevent type confusion attacks and ensure data integrity.
 *
 * H70 Skills Applied: typescript-strict, security-owasp
 */

import { z } from 'zod';
import { logger } from '$lib/utils/logger';
import { tryParseJson } from '$lib/utils/safe-json';

const log = logger.scope('Schema');

// =============================================================================
// Port and Connection Schemas
// =============================================================================

export const PortTypeSchema = z.enum(['text', 'number', 'boolean', 'object', 'array', 'any', 'skill']);

export const PortSchema = z.object({
	id: z.string(),
	label: z.string(),
	type: PortTypeSchema,
	required: z.boolean().optional(),
	skillId: z.string().optional()
});

export const ConnectionTypeSchema = z.enum(['data', 'control', 'skill', 'error', 'ghost']);

export const ConnectionSchema = z.object({
	id: z.string(),
	sourceNodeId: z.string(),
	sourcePortId: z.string(),
	targetNodeId: z.string(),
	targetPortId: z.string(),
	type: ConnectionTypeSchema.optional().default('data')
});

// =============================================================================
// Canvas Store Schemas (matching canvas.svelte.ts)
// =============================================================================

// Skill schema for canvas nodes (simplified version embedded in nodes)
export const CanvasSkillSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string().optional(),
	category: z.string().optional(),
	tags: z.array(z.string()).optional(),
	triggers: z.array(z.string()).optional(),
	layer: z.number().optional(),
	inputs: z.array(z.unknown()).optional(),
	outputs: z.array(z.unknown()).optional()
}).passthrough();

// Canvas node as used in canvas.svelte.ts
export const CanvasStoreNodeSchema = z.object({
	id: z.string(),
	skillId: z.string(),
	skill: CanvasSkillSchema,
	position: z.object({
		x: z.number(),
		y: z.number()
	}),
	status: z.enum(['idle', 'queued', 'running', 'success', 'error']).optional()
});

// Connection as used in canvas.svelte.ts
export const CanvasStoreConnectionSchema = z.object({
	id: z.string(),
	sourceNodeId: z.string(),
	sourcePortId: z.string(),
	targetNodeId: z.string(),
	targetPortId: z.string()
});

// SavedCanvasState as used in canvas.svelte.ts
export const CanvasStoreSavedStateSchema = z.object({
	version: z.number().optional(),
	nodes: z.array(CanvasStoreNodeSchema),
	connections: z.array(CanvasStoreConnectionSchema),
	zoom: z.number(),
	pan: z.object({
		x: z.number(),
		y: z.number()
	}),
	savedAt: z.string().optional()
});

export type CanvasStoreSavedState = z.infer<typeof CanvasStoreSavedStateSchema>;

// =============================================================================
// Canvas Node Schemas (generic)
// =============================================================================

export const SharpEdgeSchema = z.object({
	id: z.string(),
	message: z.string(),
	severity: z.enum(['warning', 'error', 'info']),
	autofix: z.string().optional()
});

export const CanvasNodeSchema = z.object({
	id: z.string(),
	type: z.string().optional().default('skill'),
	name: z.string(),
	description: z.string().optional(),
	category: z.string().optional(),
	position: z.object({
		x: z.number(),
		y: z.number()
	}),
	inputs: z.array(PortSchema).optional(),
	outputs: z.array(PortSchema).optional(),
	sharpEdges: z.array(SharpEdgeSchema).optional(),
	config: z.record(z.unknown()).optional(),
	data: z.record(z.unknown()).optional()
});

// =============================================================================
// Canvas State Schemas
// =============================================================================

export const PanSchema = z.object({
	x: z.number(),
	y: z.number()
});

export const SavedCanvasStateSchema = z.object({
	nodes: z.array(CanvasNodeSchema),
	connections: z.array(ConnectionSchema),
	zoom: z.number().optional().default(1),
	pan: PanSchema.optional().default({ x: 0, y: 0 }),
	selectedNodeId: z.string().nullable().optional()
});

export type SavedCanvasState = z.infer<typeof SavedCanvasStateSchema>;

// =============================================================================
// Pipeline Schemas
// =============================================================================

export const PipelineMetadataSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string().optional(),
	nodeCount: z.number(),
	connectionCount: z.number(),
	createdAt: z.string(),
	updatedAt: z.string(),
	thumbnail: z.string().optional()
});

export const PipelineDataSchema = z.object({
	nodes: z.array(CanvasNodeSchema),
	connections: z.array(ConnectionSchema),
	zoom: z.number().optional().default(1),
	pan: PanSchema.optional().default({ x: 0, y: 0 })
});

export const PipelinesRegistrySchema = z.object({
	pipelines: z.array(PipelineMetadataSchema),
	activePipelineId: z.string().nullable()
});

export type PipelineData = z.infer<typeof PipelineDataSchema>;
export type PipelineMetadata = z.infer<typeof PipelineMetadataSchema>;

// =============================================================================
// Skill Schemas
// =============================================================================

export const SkillSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string().optional(),
	category: z.string().optional(),
	tags: z.array(z.string()).optional(),
	triggers: z.array(z.string()).optional(),
	layer: z.number().optional()
});

export const SkillArraySchema = z.array(SkillSchema);

export type Skill = z.infer<typeof SkillSchema>;

// =============================================================================
// Service State Schemas (for status-storage)
// =============================================================================

export const ServiceStatusSchema = z.enum(['operational', 'degraded', 'down', 'unknown']);

export const ServiceSchema = z.object({
	id: z.string(),
	name: z.string(),
	url: z.string(),
	status: ServiceStatusSchema.optional(),
	lastCheck: z.string().optional(),
	enabled: z.boolean().optional().default(true)
});

export const HealthCheckSchema = z.object({
	id: z.string(),
	serviceId: z.string(),
	status: ServiceStatusSchema,
	responseTime: z.number().optional(),
	timestamp: z.string(),
	error: z.string().optional()
});

export const IncidentSchema = z.object({
	id: z.string(),
	serviceId: z.string(),
	title: z.string(),
	description: z.string().optional(),
	status: z.enum(['investigating', 'identified', 'monitoring', 'resolved']),
	createdAt: z.string(),
	updatedAt: z.string(),
	resolvedAt: z.string().optional()
});

export const AlertConfigSchema = z.object({
	id: z.string(),
	serviceId: z.string(),
	type: z.enum(['email', 'webhook', 'slack']),
	destination: z.string(),
	enabled: z.boolean().optional().default(true)
});

export const ServiceArraySchema = z.array(ServiceSchema);
export const HealthCheckArraySchema = z.array(HealthCheckSchema);
export const IncidentArraySchema = z.array(IncidentSchema);
export const AlertConfigArraySchema = z.array(AlertConfigSchema);

// =============================================================================
// Event Bridge Schemas
// =============================================================================

export const BridgeEventTypeSchema = z.enum([
	'mission_started',
	'mission_progress',
	'mission_completed',
	'mission_failed',
	'mission_cancelled',
	'task_started',
	'task_progress',
	'task_completed',
	'task_failed',
	'task_cancelled',
	'learning_captured',
	'sync_state',
	'control_pause',
	'control_resume',
	'control_cancel'
]);

export const BridgeEventSchema = z.object({
	type: BridgeEventTypeSchema,
	data: z.record(z.unknown()).optional(),
	timestamp: z.string().optional()
});

export type BridgeEvent = z.infer<typeof BridgeEventSchema>;

// =============================================================================
// MCP Schemas
// =============================================================================

export const MCPConfigSchema = z.object({
	command: z.string().optional(),
	args: z.array(z.string()).optional(),
	env: z.record(z.string()).optional()
});

export const MCPStateSchema = z.object({
	status: z.enum(['disconnected', 'connecting', 'connected', 'error']),
	error: z.string().optional(),
	tools: z.array(z.record(z.unknown())).optional()
});

// =============================================================================
// Agent Memory Metadata Schema
// =============================================================================

export const AgentMemoryMetadataSchema = z.object({
	agent_id: z.string().optional(),
	mission_id: z.string().optional(),
	task_id: z.string().optional(),
	pattern_type: z.string().optional(),
	outcome: z.string().optional(),
	confidence: z.number().optional(),
	tags: z.array(z.string()).optional()
}).passthrough(); // Allow additional unknown properties

export type AgentMemoryMetadata = z.infer<typeof AgentMemoryMetadataSchema>;

// =============================================================================
// Sync Event Schema
// =============================================================================

export const SyncEventSchema = z.object({
	type: z.string(),
	data: z.record(z.unknown()).optional(),
	timestamp: z.number().optional()
});

export type SyncEvent = z.infer<typeof SyncEventSchema>;

// =============================================================================
// Claude Analysis Schema (for API responses)
// =============================================================================

export const ClaudeAnalysisSchema = z.object({
	summary: z.string().optional(),
	suggestions: z.array(z.string()).optional(),
	skills: z.array(z.string()).optional(),
	confidence: z.number().optional()
}).passthrough(); // Allow additional properties from Claude

export type ClaudeAnalysis = z.infer<typeof ClaudeAnalysisSchema>;

// =============================================================================
// Import/Export Schemas
// =============================================================================

export const ImportDataSchema = z.object({
	version: z.string().optional(),
	exportedAt: z.string().optional(),
	data: z.record(z.unknown())
}).passthrough();

// =============================================================================
// Skills Store Schemas (for localStorage)
// =============================================================================

export const StoredSkillSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string(),
	category: z.string(),
	tier: z.string(),
	tags: z.array(z.string()),
	triggers: z.array(z.string()),
	tokenEstimate: z.number().optional(),
	version: z.string().optional(),
	handoffs: z.array(z.object({
		trigger: z.string(),
		to: z.string()
	})).optional(),
	pairsWell: z.array(z.string()).optional()
});

export const StoredSkillArraySchema = z.array(StoredSkillSchema);

// =============================================================================
// Project Docs Store Schemas
// =============================================================================

export const ProjectDocsSchema = z.object({
	prd: z.string(),
	architecture: z.string(),
	implementation: z.string(),
	projectName: z.string(),
	lastUpdated: z.string()
});

export type ProjectDocs = z.infer<typeof ProjectDocsSchema>;

// =============================================================================
// MCP Store Schemas (for localStorage)
// =============================================================================

export const MCPInstanceStorageSchema = z.object({
	id: z.string(),
	definitionId: z.string(),
	name: z.string(),
	status: z.enum(['connected', 'connecting', 'disconnected', 'error']),
	config: z.record(z.unknown()).optional(),
	usageCount: z.number(),
	feedbackCount: z.number(),
	attachedToSkills: z.array(z.string()),
	attachedToTeams: z.array(z.string()),
	attachedToMissions: z.array(z.string()),
	autoFeedback: z.boolean().optional(),
	enabled: z.boolean().optional(),
	lastSmokeTestAt: z.string().optional(),
	lastSmokeTestStatus: z.enum(['passed', 'failed']).optional(),
	lastSmokeTestMessage: z.string().optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
	lastConnected: z.string().optional(),
	lastError: z.string().optional(),
	serverInfo: z.record(z.unknown()).optional(),
	tools: z.array(z.record(z.unknown())).optional()
});

export const SkillMCPBindingSchema = z.object({
	mcpId: z.string(),
	skillId: z.string(),
	bindingType: z.enum(['required', 'recommended', 'optional']),
	purpose: z.string(),
	autoAttach: z.boolean(),
	toolsUsed: z.array(z.string())
});

export const TeamMCPBindingSchema = z.object({
	mcpId: z.string(),
	teamId: z.string(),
	sharedAcrossTeam: z.boolean(),
	purpose: z.string(),
	feedbackAggregation: z.boolean()
});

export const MCPStorageSchema = z.object({
	instances: z.array(MCPInstanceStorageSchema).optional().default([]),
	skillBindings: z.array(SkillMCPBindingSchema).optional().default([]),
	teamBindings: z.array(TeamMCPBindingSchema).optional().default([])
});

// =============================================================================
// Services Store Schemas (for localStorage - status dashboard)
// =============================================================================

export const DashboardServiceSchema = z.object({
	id: z.string(),
	name: z.string(),
	url: z.string(),
	description: z.string().optional(),
	status: z.enum(['healthy', 'degraded', 'down', 'unknown']),
	lastCheck: z.string().nullable(),
	lastResponseTime: z.number().nullable(),
	uptimePercentage: z.number(),
	consecutiveFailures: z.number(),
	createdAt: z.string(),
	tags: z.array(z.string()).optional()
});

export const DashboardServiceArraySchema = z.array(DashboardServiceSchema);

export const DashboardAlertConfigSchema = z.object({
	id: z.string(),
	serviceId: z.string(),
	enabled: z.boolean(),
	responseTimeThreshold: z.number(),
	consecutiveFailuresThreshold: z.number(),
	notifyOnRecovery: z.boolean()
});

export const DashboardAlertConfigArraySchema = z.array(DashboardAlertConfigSchema);

// =============================================================================
// Status Storage Schemas (status-storage.ts - separate from services.svelte.ts)
// =============================================================================

export const StatusServiceSchema = z.object({
	id: z.string(),
	name: z.string(),
	url: z.string(),
	description: z.string().optional(),
	status: z.enum(['healthy', 'degraded', 'down', 'unknown']),
	lastCheck: z.string().nullable(),
	lastResponseTime: z.number().nullable(),
	uptimePercentage: z.number(),
	consecutiveFailures: z.number(),
	createdAt: z.string(),
	tags: z.array(z.string()).optional()
});

export const StatusServiceArraySchema = z.array(StatusServiceSchema);

export const StatusHealthCheckSchema = z.object({
	id: z.string(),
	serviceId: z.string(),
	status: z.enum(['healthy', 'degraded', 'down', 'unknown']),
	responseTime: z.number(),
	timestamp: z.string(),
	error: z.string().optional(),
	metadata: z.record(z.unknown()).optional()
});

export const StatusHealthCheckArraySchema = z.array(StatusHealthCheckSchema);

export const StatusIncidentSchema = z.object({
	id: z.string(),
	serviceId: z.string(),
	startTime: z.string(),
	endTime: z.string().nullable(),
	status: z.enum(['ongoing', 'resolved']),
	type: z.enum(['degraded', 'down']),
	description: z.string().optional()
});

export const StatusIncidentArraySchema = z.array(StatusIncidentSchema);

export const StatusAlertConfigSchema = z.object({
	id: z.string(),
	serviceId: z.string(),
	responseTimeThreshold: z.number(),
	consecutiveFailuresThreshold: z.number(),
	enabled: z.boolean(),
	notifyOnRecovery: z.boolean()
});

export const StatusAlertConfigArraySchema = z.array(StatusAlertConfigSchema);

export const DashboardSettingsSchema = z.object({
	refreshInterval: z.number(),
	showResponseTimes: z.boolean(),
	showUptimeHistory: z.boolean(),
	darkMode: z.boolean()
}).partial();

// =============================================================================
// Event Bridge Client Schemas
// =============================================================================

export const ClientBridgeEventSchema = z.object({
	id: z.string().optional(),
	type: z.string(),
	missionId: z.string().optional(),
	taskId: z.string().optional(),
	taskName: z.string().optional(),
	progress: z.number().optional(),
	message: z.string().optional(),
	data: z.record(z.unknown()).optional(),
	timestamp: z.string(),
	source: z.string()
});

// =============================================================================
// Sync Client Schemas
// =============================================================================

export const SyncMessageSchema = z.object({
	type: z.string(),
	data: z.record(z.unknown()).optional(),
	timestamp: z.number().optional()
});

// =============================================================================
// Learnings Export/Import Schema
// =============================================================================

export const LearningsExportDataSchema = z.object({
	version: z.string(),
	exportedAt: z.string().optional(),
	source: z.string().optional(),
	memories: z.array(z.object({
		content: z.string(),
		content_type: z.string().optional(),
		temporal_level: z.number().optional(),
		salience: z.number().optional()
	}).passthrough()),
	stats: z.object({
		totalCount: z.number(),
		byType: z.record(z.number())
	}).optional()
});

// =============================================================================
// Persistence Backup Schemas
// =============================================================================

export const BackupDataSchema = z.object({
	_version: z.number().optional(),
	_timestamp: z.string().optional()
}).passthrough();  // Allow any spawner-* keys

export const MissionStateSchema = z.object({
	version: z.number().optional(),
	executionPrompt: z.string().optional(),
	status: z.string().optional(),
	mission: z.record(z.unknown()).optional()
}).passthrough();

// =============================================================================
// Canvas Drag/Drop Skill Schema
// =============================================================================

export const DroppedSkillSchema = z.object({
	id: z.string(),
	name: z.string().optional(),
	description: z.string().optional(),
	category: z.string().optional(),
	tier: z.union([z.number(), z.enum(['free', 'premium'])]).optional(),
	tags: z.array(z.string()).optional(),
	triggers: z.array(z.string()).optional(),
	handoffs: z.array(z.object({
		trigger: z.string(),
		to: z.string()
	})).optional(),
	pairsWell: z.array(z.string()).optional(),
	owns: z.array(z.string()).optional(),
	delegates: z.array(z.string()).optional()
}).passthrough();

// =============================================================================
// Claude API Analysis Response Schema (for /api/analyze)
// =============================================================================

export const ClaudeApiAnalysisSchema = z.object({
	suggestedSkills: z.array(z.union([
		z.string(),
		z.object({
			id: z.string(),
			reason: z.string().optional(),
			tier: z.number().optional()
		})
	])).optional(),
	technologies: z.array(z.string()).optional(),
	features: z.array(z.string()).optional(),
	domains: z.array(z.string()).optional(),
	reasoning: z.string().optional(),
	confidence: z.number().optional()
}).passthrough();

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Safely parse JSON with Zod validation
 * Returns undefined if parsing fails instead of throwing
 */
export function safeJsonParse<T>(
	json: string,
	schema: z.ZodType<T>,
	context?: string
): T | undefined {
	const parsed = tryParseJson<unknown | undefined>(json, undefined, context || 'schema-json');
	if (!parsed.ok) {
		log.warn(`JSON parse failed${context ? ` for ${context}` : ''}:`, parsed.error);
		return undefined;
	}
	const result = schema.safeParse(parsed.value);
	if (result.success) {
		return result.data;
	}
	log.warn(`Validation failed${context ? ` for ${context}` : ''}:`, result.error.issues);
	return undefined;
}

/**
 * Parse JSON with Zod validation, returning default value on failure
 */
export function parseJsonWithDefault<T>(
	json: string,
	schema: z.ZodType<T>,
	defaultValue: T,
	context?: string
): T {
	return safeJsonParse(json, schema, context) ?? defaultValue;
}
