import { logger } from '$lib/utils/logger';
/**
 * MCP Store - State management for MCPs in Spawner UI
 *
 * Manages:
 * - Available MCP definitions
 * - Connected MCP instances
 * - MCP feedback
 * - Skill/Team MCP bindings
 */

import { writable, derived, get } from 'svelte/store';
import type {
	MCPDefinition,
	MCPInstance,
	MCPFeedback,
	MCPCategory,
	MCPCapability,
	MCPConfig,
	SkillMCPBinding,
	TeamMCPBinding,
	MCPConnectionStatus,
	MCPRegistryItem
} from '$lib/types/mcp';
import { TOP_100_MCPS, getMCPCategories, SKILL_MCP_MAP } from '$lib/types/mcp';
import { MCPStorageSchema, safeJsonParse } from '$lib/types/schemas';

// ============================================
// State Interface
// ============================================

export interface MCPState {
	// Available MCPs from registry
	registry: MCPRegistryItem[];
	loadingRegistry: boolean;

	// Connected instances
	instances: MCPInstance[];
	loadingInstances: boolean;

	// Feedback queue
	pendingFeedback: MCPFeedback[];
	processedFeedback: MCPFeedback[];
	feedbackLoading: boolean;

	// Bindings
	skillBindings: SkillMCPBinding[];
	teamBindings: TeamMCPBinding[];

	// UI state
	selectedMCPId: string | null;
	filterCategory: string; // Category name from TOP_100_MCPS
	filterSubcategory: string | null;
	searchQuery: string;

	// Errors
	error: string | null;
}

const initialState: MCPState = {
	registry: TOP_100_MCPS,
	loadingRegistry: false,
	instances: [],
	loadingInstances: false,
	pendingFeedback: [],
	processedFeedback: [],
	feedbackLoading: false,
	skillBindings: [],
	teamBindings: [],
	selectedMCPId: null,
	filterCategory: 'all',
	filterSubcategory: null,
	searchQuery: '',
	error: null
};

// ============================================
// Main Store
// ============================================

export const mcpStore = writable<MCPState>(initialState);

// ============================================
// Derived Stores
// ============================================

// Get unique categories from registry
export const mcpCategories = derived(mcpStore, ($state) => {
	const categories = [...new Set($state.registry.map(m => m.category))];
	return categories;
});

// Get subcategories for a category
export const getSubcategories = (category: string) => derived(mcpStore, ($state) => {
	const subcats = [...new Set(
		$state.registry
			.filter(m => m.category === category)
			.map(m => m.subcategory)
	)];
	return subcats;
});

// Filtered registry based on category, subcategory, and search
export const filteredRegistry = derived(mcpStore, ($state) => {
	let filtered = $state.registry;

	// Filter by category
	if ($state.filterCategory !== 'all') {
		filtered = filtered.filter((m) => m.category === $state.filterCategory);
	}

	// Filter by subcategory
	if ($state.filterSubcategory) {
		filtered = filtered.filter((m) => m.subcategory === $state.filterSubcategory);
	}

	// Filter by search query
	if ($state.searchQuery.trim()) {
		const query = $state.searchQuery.toLowerCase();
		filtered = filtered.filter(
			(m) =>
				m.name.toLowerCase().includes(query) ||
				m.description.toLowerCase().includes(query) ||
				m.id.toLowerCase().includes(query) ||
				m.skills.some((s) => s.toLowerCase().includes(query))
		);
	}

	// Sort by popularity
	// NOTE: .sort() mutates the input array. Use .toSorted() (ES2023) or `[...arr].sort()` to avoid surprising callers. The function signature doesn't suggest in-place sort.
	filtered = filtered.sort((a, b) => b.popularity - a.popularity);

	return filtered;
});

// Legacy alias for backwards compatibility
export const filteredDefinitions = filteredRegistry;

// Connected instances
export const connectedInstances = derived(mcpStore, ($state) =>
	$state.instances.filter((i) => i.status === 'connected')
);

// Instances by status
export const instancesByStatus = derived(mcpStore, ($state) => {
	const byStatus: Record<MCPConnectionStatus, MCPInstance[]> = {
		connected: [],
		connecting: [],
		disconnected: [],
		error: []
	};

	for (const instance of $state.instances) {
		byStatus[instance.status].push(instance);
	}

	return byStatus;
});

// Feedback MCPs (ones that can provide feedback - based on capabilities)
export const feedbackMCPs = derived(mcpStore, ($state) =>
	$state.registry.filter((m) =>
		m.capabilities.includes('analytics') ||
		m.capabilities.includes('security_scan') ||
		m.capabilities.includes('code_analysis')
	)
);

// Pending feedback count
export const pendingFeedbackCount = derived(mcpStore, ($state) => $state.pendingFeedback.length);

// MCPs attached to a specific skill
export const getMCPsForSkill = (skillId: string) =>
	derived(mcpStore, ($state) => {
		const bindingIds = $state.skillBindings
			.filter((b) => b.skillId === skillId)
			.map((b) => b.mcpId);

		return $state.instances.filter((i) => bindingIds.includes(i.id));
	});

// MCPs attached to a specific team
export const getMCPsForTeam = (teamId: string) =>
	derived(mcpStore, ($state) => {
		const bindingIds = $state.teamBindings.filter((b) => b.teamId === teamId).map((b) => b.mcpId);

		return $state.instances.filter((i) => bindingIds.includes(i.id));
	});

/**
 * Get MCPs suggested for the current canvas workflow.
 * Pass an array of skill IDs from the canvas nodes.
 * Returns registry items sorted by relevance.
 */
export function getSuggestedMCPs(canvasSkillIds: string[]): MCPRegistryItem[] {
	if (canvasSkillIds.length === 0) return [];

	// Collect recommended MCP IDs from SKILL_MCP_MAP
	const mcpScores = new Map<string, number>();
	for (const skillId of canvasSkillIds) {
		const entries = SKILL_MCP_MAP[skillId] || [];
		for (const entry of entries) {
			const score = entry.priority === 'required' ? 3 : entry.priority === 'recommended' ? 2 : 1;
			for (const mcpId of entry.mcps) {
				mcpScores.set(mcpId, (mcpScores.get(mcpId) || 0) + score);
			}
		}
	}

	if (mcpScores.size === 0) return [];

	// Look up registry items
	const state = get(mcpStore);
	return state.registry
		.filter((m) => mcpScores.has(m.id))
		.sort((a, b) => (mcpScores.get(b.id) || 0) - (mcpScores.get(a.id) || 0));
}

// ============================================
// Actions
// ============================================

/**
 * Load MCP registry (Top 100 MCPs)
 */
export function loadRegistry() {
	mcpStore.update((s) => ({
		...s,
		loadingRegistry: true,
		error: null
	}));

	// Use the Top 100 MCPs registry
	mcpStore.update((s) => ({
		...s,
		registry: TOP_100_MCPS,
		loadingRegistry: false
	}));
}

// Legacy alias
export const loadDefinitions = loadRegistry;

/**
 * Add a custom MCP to registry
 */
export function addToRegistry(mcp: MCPRegistryItem) {
	mcpStore.update((s) => ({
		...s,
		registry: [...s.registry, mcp]
	}));
}

/**
 * Create a new MCP instance (connect an MCP)
 */
export function createInstance(
	mcpId: string,
	config: MCPConfig = {},
	name?: string
): MCPInstance {
	const mcpDef = get(mcpStore).registry.find((m) => m.id === mcpId);
	if (!mcpDef) {
		throw new Error(`MCP not found in registry: ${mcpId}`);
	}

	const instance: MCPInstance = {
		id: `mcp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
		definitionId: mcpId,
		name: name || mcpDef.name,
		status: 'disconnected',
		config,
		usageCount: 0,
		feedbackCount: 0,
		attachedToSkills: [],
		attachedToTeams: [],
		attachedToMissions: [],
		autoFeedback: true,
		enabled: true,
		lastSmokeTestAt: undefined,
		lastSmokeTestStatus: undefined,
		lastSmokeTestMessage: undefined,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString()
	};

	mcpStore.update((s) => ({
		...s,
		instances: [...s.instances, instance]
	}));

	return instance;
}

/**
 * Connect an MCP instance
 */
export async function connectInstance(
	instanceId: string,
	overrides?: { command?: string; args?: string[]; envVars?: Record<string, string> }
): Promise<boolean> {
	const state = get(mcpStore);
	const instance = state.instances.find((i) => i.id === instanceId);
	if (!instance) {
		console.error(`[MCP] Instance not found: ${instanceId}`);
		return false;
	}

	mcpStore.update((s) => ({
		...s,
		instances: s.instances.map((i) =>
			i.id === instanceId ? { ...i, status: 'connecting' as MCPConnectionStatus } : i
		)
	}));

	try {
		// Look up registry info for npmPackage/defaultArgs/requiredEnvVars
		const registryItem = state.registry.find((m) => m.id === instance.definitionId);

		// Build env vars from user config (key-value pairs that match requiredEnvVars)
		const envVars: Record<string, string> = {};
		if (instance.config && registryItem?.requiredEnvVars) {
			for (const key of Object.keys(registryItem.requiredEnvVars)) {
				const val = instance.config[key];
				if (val && typeof val === 'string' && val.trim().length > 0) {
					envVars[key] = val.trim();
				}
			}
		}

		// Merge override env vars with config-derived env vars
		const mergedEnvVars = { ...envVars, ...overrides?.envVars };

		// Call the server-side MCP connection API
		const response = await fetch('/api/mcp', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				instanceId,
				mcpId: instance.definitionId,
				npmPackage: registryItem?.npmPackage,
				defaultArgs: registryItem?.defaultArgs,
				envVars: Object.keys(mergedEnvVars).length > 0 ? mergedEnvVars : undefined,
				config: instance.config,
				command: overrides?.command,
				args: overrides?.args
			})
		});

		const result = await response.json();

		if (!response.ok || result.error) {
			throw new Error(result.error || 'Connection failed');
		}

		// Successfully connected - update with server info, tools, and connection config for reconnect
		mcpStore.update((s) => ({
			...s,
			instances: s.instances.map((i) =>
				i.id === instanceId
					? {
							...i,
							status: 'connected' as MCPConnectionStatus,
							lastConnected: new Date().toISOString(),
							updatedAt: new Date().toISOString(),
							serverInfo: result.serverInfo,
							tools: result.tools,
							connectionConfig: {
								npmPackage: registryItem?.npmPackage,
								defaultArgs: registryItem?.defaultArgs,
								command: overrides?.command,
								args: overrides?.args,
								envVars: Object.keys(mergedEnvVars).length > 0 ? mergedEnvVars : undefined
							}
						}
					: i
			)
		}));

		logger.info(`[MCP] Connected to ${result.serverInfo?.name}`, result.tools);
		return true;
	} catch (error) {
		console.error(`[MCP] Connection error:`, error);
		mcpStore.update((s) => ({
			...s,
			instances: s.instances.map((i) =>
				i.id === instanceId
					? {
							...i,
							status: 'error' as MCPConnectionStatus,
							lastError: error instanceof Error ? error.message : 'Connection failed',
							updatedAt: new Date().toISOString()
						}
					: i
			),
			error: error instanceof Error ? error.message : 'Connection failed'
		}));
		return false;
	}
}

/**
 * Disconnect an MCP instance
 */
export async function disconnectInstance(instanceId: string): Promise<void> {
	try {
		// Call the server-side MCP disconnect API
		await fetch('/api/mcp', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ instanceId })
		});
	} catch (error) {
		console.error(`[MCP] Disconnect error:`, error);
	}

	mcpStore.update((s) => ({
		...s,
		instances: s.instances.map((i) =>
			i.id === instanceId
				? {
						...i,
						status: 'disconnected' as MCPConnectionStatus,
						updatedAt: new Date().toISOString()
					}
				: i
		)
	}));
}

/**
 * Reconnect all instances that have a stored connectionConfig.
 * Called on page load to restore live connections after a reload.
 */
export async function reconnectAll(): Promise<void> {
	const state = get(mcpStore);
	const staleInstances = state.instances.filter(
		(i) => i.status === 'disconnected' && i.connectionConfig
	);

	if (staleInstances.length === 0) return;

	logger.info(`[MCP] Reconnecting ${staleInstances.length} instance(s)...`);
	for (const instance of staleInstances) {
		const cc = instance.connectionConfig!;
		try {
			await connectInstance(instance.id, {
				command: cc.command,
				args: cc.args,
				envVars: cc.envVars
			});
		} catch (e) {
			console.error(`[MCP] Reconnect failed for ${instance.name}:`, e);
		}
	}
}

/**
 * Call a tool on a connected MCP instance
 */
export async function callMCPTool(
	instanceId: string,
	toolName: string,
	args: Record<string, unknown> = {}
): Promise<unknown> {
	const state = get(mcpStore);
	const instance = state.instances.find((i) => i.id === instanceId);

	if (!instance || instance.status !== 'connected') {
		throw new Error(`MCP not connected: ${instanceId}`);
	}

	try {
		const response = await fetch('/api/mcp/call', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ instanceId, toolName, args })
		});

		const result = await response.json();

		if (!response.ok || result.error) {
			throw new Error(result.error || 'Tool call failed');
		}

		// Update usage count
		mcpStore.update((s) => ({
			...s,
			instances: s.instances.map((i) =>
				i.id === instanceId
					? {
							...i,
							usageCount: i.usageCount + 1,
							updatedAt: new Date().toISOString()
						}
					: i
			)
		}));

		return result.result;
	} catch (error) {
		console.error(`[MCP] Tool call error:`, error);
		throw error;
	}
}

function buildSmokeArgs(toolName: string): Record<string, unknown> {
	const normalized = toolName.toLowerCase();
	if (normalized === 'echo') return { message: 'spawner smoke test' };
	if (normalized === 'add') return { a: 1, b: 2 };
	if (normalized === 'random_number') return { min: 0, max: 10 };
	if (normalized === 'query') return { query: 'SELECT 1' };
	return {};
}

/**
 * Run a smoke test against at least one tool on a connected MCP instance.
 */
export async function runInstanceSmokeTest(
	instanceId: string
): Promise<{ ok: boolean; toolName?: string; message: string }> {
	const state = get(mcpStore);
	const instance = state.instances.find((i) => i.id === instanceId);

	if (!instance) {
		return { ok: false, message: 'MCP instance not found' };
	}

	if (instance.status !== 'connected') {
		return { ok: false, message: 'MCP instance is not connected' };
	}

	const tools = instance.tools || [];
	const timestamp = new Date().toISOString();
	if (tools.length === 0) {
		const message = 'Connected, but no tools were reported by server';
		mcpStore.update((s) => ({
			...s,
			instances: s.instances.map((i) =>
				i.id === instanceId
					? {
						...i,
						lastSmokeTestAt: timestamp,
						lastSmokeTestStatus: 'failed',
						lastSmokeTestMessage: message,
						updatedAt: timestamp
					}
					: i
			)
		}));
		return { ok: false, message };
	}

	for (const tool of tools) {
		try {
			await callMCPTool(instanceId, tool.name, buildSmokeArgs(tool.name));
			const message = `Smoke test passed using tool "${tool.name}"`;
			mcpStore.update((s) => ({
				...s,
				instances: s.instances.map((i) =>
					i.id === instanceId
						? {
							...i,
							lastSmokeTestAt: timestamp,
							lastSmokeTestStatus: 'passed',
							lastSmokeTestMessage: message,
							updatedAt: timestamp
						}
						: i
				)
			}));
			return { ok: true, toolName: tool.name, message };
		} catch {
			// try next tool
		}
	}

	const message = `Connected, but all smoke test calls failed (${tools.length} tool${tools.length === 1 ? '' : 's'} attempted)`;
	mcpStore.update((s) => ({
		...s,
		instances: s.instances.map((i) =>
			i.id === instanceId
				? {
					...i,
					lastSmokeTestAt: timestamp,
					lastSmokeTestStatus: 'failed',
					lastSmokeTestMessage: message,
					updatedAt: timestamp
				}
				: i
		)
	}));
	return { ok: false, message };
}

/**
 * Remove an MCP instance
 */
export function removeInstance(instanceId: string) {
	mcpStore.update((s) => ({
		...s,
		instances: s.instances.filter((i) => i.id !== instanceId),
		skillBindings: s.skillBindings.filter((b) => b.mcpId !== instanceId),
		teamBindings: s.teamBindings.filter((b) => b.mcpId !== instanceId)
	}));
}

/**
 * Update instance config
 */
export function updateInstanceConfig(instanceId: string, config: Partial<MCPConfig>) {
	const sanitizedConfig = Object.fromEntries(
		Object.entries(config).filter(([, value]) => value !== undefined)
	) as MCPConfig;

	mcpStore.update((s) => ({
		...s,
		instances: s.instances.map((i) =>
			i.id === instanceId
				? {
						...i,
						config: { ...i.config, ...sanitizedConfig },
						updatedAt: new Date().toISOString()
					}
				: i
		)
	}));
}

/**
 * Attach MCP to a skill
 */
export function attachToSkill(
	mcpId: string,
	skillId: string,
	options: {
		bindingType?: 'required' | 'recommended' | 'optional';
		purpose?: string;
		autoAttach?: boolean;
		toolsUsed?: string[];
	} = {}
) {
	const binding: SkillMCPBinding = {
		mcpId,
		skillId,
		bindingType: options.bindingType || 'optional',
		purpose: options.purpose || '',
		autoAttach: options.autoAttach ?? false,
		toolsUsed: options.toolsUsed || []
	};

	mcpStore.update((s) => ({
		...s,
		skillBindings: [...s.skillBindings.filter((b) => !(b.mcpId === mcpId && b.skillId === skillId)), binding],
		instances: s.instances.map((i) =>
			i.id === mcpId
				? {
						...i,
						attachedToSkills: [...new Set([...i.attachedToSkills, skillId])],
						updatedAt: new Date().toISOString()
					}
				: i
		)
	}));
}

/**
 * Detach MCP from a skill
 */
export function detachFromSkill(mcpId: string, skillId: string) {
	mcpStore.update((s) => ({
		...s,
		skillBindings: s.skillBindings.filter((b) => !(b.mcpId === mcpId && b.skillId === skillId)),
		instances: s.instances.map((i) =>
			i.id === mcpId
				? {
						...i,
						attachedToSkills: i.attachedToSkills.filter((id) => id !== skillId),
						updatedAt: new Date().toISOString()
					}
				: i
		)
	}));
}

/**
 * Attach MCP to a team
 */
export function attachToTeam(
	mcpId: string,
	teamId: string,
	options: {
		sharedAcrossTeam?: boolean;
		purpose?: string;
		feedbackAggregation?: boolean;
	} = {}
) {
	const binding: TeamMCPBinding = {
		mcpId,
		teamId,
		sharedAcrossTeam: options.sharedAcrossTeam ?? true,
		purpose: options.purpose || '',
		feedbackAggregation: options.feedbackAggregation ?? true
	};

	mcpStore.update((s) => ({
		...s,
		teamBindings: [...s.teamBindings.filter((b) => !(b.mcpId === mcpId && b.teamId === teamId)), binding],
		instances: s.instances.map((i) =>
			i.id === mcpId
				? {
						...i,
						attachedToTeams: [...new Set([...i.attachedToTeams, teamId])],
						updatedAt: new Date().toISOString()
					}
				: i
		)
	}));
}

/**
 * Detach MCP from a team
 */
export function detachFromTeam(mcpId: string, teamId: string) {
	mcpStore.update((s) => ({
		...s,
		teamBindings: s.teamBindings.filter((b) => !(b.mcpId === mcpId && b.teamId === teamId)),
		instances: s.instances.map((i) =>
			i.id === mcpId
				? {
						...i,
						attachedToTeams: i.attachedToTeams.filter((id) => id !== teamId),
						updatedAt: new Date().toISOString()
					}
				: i
		)
	}));
}

/**
 * Add feedback to queue
 */
export function addFeedback(feedback: Omit<MCPFeedback, 'id' | 'createdAt' | 'status'>) {
	const newFeedback: MCPFeedback = {
		...feedback,
		id: `feedback_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
		status: 'pending',
		createdAt: new Date().toISOString()
	};

	mcpStore.update((s) => ({
		...s,
		pendingFeedback: [...s.pendingFeedback, newFeedback]
	}));

	return newFeedback;
}

/**
 * Process feedback (store locally)
 */
export async function processFeedback(feedbackId: string): Promise<boolean> {
	const state = get(mcpStore);
	const feedback = state.pendingFeedback.find((f) => f.id === feedbackId);

	if (!feedback) return false;

	mcpStore.update((s) => ({
		...s,
		feedbackLoading: true
	}));

	try {
		const processedFeedback: MCPFeedback = {
			...feedback,
			status: 'processed',
			processedAt: new Date().toISOString()
		};

		mcpStore.update((s) => ({
			...s,
			pendingFeedback: s.pendingFeedback.filter((f) => f.id !== feedbackId),
			processedFeedback: [...s.processedFeedback, processedFeedback],
			feedbackLoading: false,
			instances: s.instances.map((i) =>
				i.id === feedback.mcpId
					? {
							...i,
							feedbackCount: i.feedbackCount + 1,
							updatedAt: new Date().toISOString()
						}
					: i
			)
		}));

		return true;
	} catch (e) {
		mcpStore.update((s) => ({
			...s,
			feedbackLoading: false,
			error: e instanceof Error ? e.message : 'Failed to process feedback'
		}));
		return false;
	}
}

/**
 * Process all pending feedback
 */
export async function processAllFeedback(): Promise<number> {
	const state = get(mcpStore);
	let processed = 0;

	for (const feedback of state.pendingFeedback) {
		const success = await processFeedback(feedback.id);
		if (success) processed++;
	}

	return processed;
}

// ============================================
// UI Actions
// ============================================

export function setSelectedMCP(mcpId: string | null) {
	mcpStore.update((s) => ({ ...s, selectedMCPId: mcpId }));
}

export function setFilterCategory(category: string) {
	mcpStore.update((s) => ({
		...s,
		filterCategory: category,
		filterSubcategory: null // Reset subcategory when category changes
	}));
}

export function setFilterSubcategory(subcategory: string | null) {
	mcpStore.update((s) => ({ ...s, filterSubcategory: subcategory }));
}

export function setSearchQuery(query: string) {
	mcpStore.update((s) => ({ ...s, searchQuery: query }));
}

export function clearError() {
	mcpStore.update((s) => ({ ...s, error: null }));
}

// ============================================
// Persistence
// ============================================

const STORAGE_KEY = 'spawner_mcps';

export function saveToStorage() {
	const state = get(mcpStore);
	const toSave = {
		instances: state.instances,
		skillBindings: state.skillBindings,
		teamBindings: state.teamBindings
	};

	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
	} catch (e) {
		console.error('Failed to save MCP state:', e);
	}
}

export function loadFromStorage() {
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved) {
			// SECURITY: Validate JSON with Zod schema
			const data = safeJsonParse(saved, MCPStorageSchema, 'mcp-storage');
			if (!data) {
				console.warn('[MCP] Invalid stored data, skipping load');
				return;
			}
			// Mark previously-connected instances as disconnected (stdio processes are dead after reload)
			const instances = ((data.instances || []) as unknown as MCPInstance[]).map((i) =>
				i.status === 'connected' ? { ...i, status: 'disconnected' as MCPConnectionStatus } : i
			);
			mcpStore.update((s) => ({
				...s,
				instances,
				skillBindings: (data.skillBindings || []) as unknown as SkillMCPBinding[],
				teamBindings: (data.teamBindings || []) as unknown as TeamMCPBinding[]
			}));
		}
	} catch (e) {
		console.error('Failed to load MCP state:', e);
	}
}

// ============================================
// Initialize
// ============================================

export function initializeMCPStore() {
	loadDefinitions();
	loadFromStorage();
}
