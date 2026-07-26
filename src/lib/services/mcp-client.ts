/**
 * MCP Client - Connects to Spawner MCP Server
 *
 * The MCP server uses JSON-RPC 2.0 over HTTP.
 * Local dev: set PUBLIC_MCP_URL when a local MCP bridge is running.
 * Production: https://mcp.vibeship.co
 */

export interface McpConfig {
	baseUrl: string;
	userId?: string;
}

export interface McpRequest {
	jsonrpc: '2.0';
	id: string | number;
	method: string;
	params?: Record<string, unknown>;
}

export interface McpResponse<T = unknown> {
	jsonrpc: '2.0';
	id: string | number;
	result?: {
		content?: Array<{ type: string; text: string }>;
		tools?: T;
	};
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
}

export interface McpToolResult<T = unknown> {
	success: boolean;
	data?: T;
	error?: string;
}

const GOVERNED_LIFECYCLE_ERROR =
	'Legacy MCP mission lifecycle actions are disabled. Use Harness/Governor-authorized Spawner dispatch or mission-control runtime commands.';

// Skill types from MCP
export interface McpSkill {
	id: string;
	name: string;
	description?: string;
	category: string;
	tags?: string[];
	triggers?: string[];
	handoffs?: Array<{ trigger: string; to: string }>;
	pairs_with?: string[];
	layer?: number;
}

export interface McpSkillsResponse {
	skills: McpSkill[];
	count: number;
	source?: string;
}

export interface McpToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

class McpClient {
	private config: McpConfig;
	private requestId = 0;
	private initialized = false;

	constructor(config?: Partial<McpConfig>) {
		this.config = {
			baseUrl: config?.baseUrl ?? '',
			userId: config?.userId
		};
	}

	/**
	 * Configure the MCP client
	 */
	configure(config: Partial<McpConfig>) {
		this.config = { ...this.config, ...config };
		this.initialized = false; // Reset initialization when config changes
	}

	/**
	 * Get the current base URL
	 */
	getBaseUrl(): string {
		return this.config.baseUrl;
	}

	/**
	 * Check if connected to production
	 */
	isProduction(): boolean {
		return this.config.baseUrl.includes('mcp.vibeship.co');
	}

	/**
	 * Send a raw JSON-RPC request
	 */
	private async request<T>(method: string, params?: Record<string, unknown>): Promise<McpResponse<T>> {
		if (!this.config.baseUrl) {
			throw new Error('MCP URL is not configured');
		}

		const id = ++this.requestId;

		const body: McpRequest = {
			jsonrpc: '2.0',
			id,
			method,
			params
		};

		const headers: Record<string, string> = {
			'Content-Type': 'application/json'
		};

		if (this.config.userId) {
			headers['X-User-ID'] = this.config.userId;
		}

		const response = await fetch(this.config.baseUrl, {
			method: 'POST',
			headers,
			body: JSON.stringify(body)
		});

		if (!response.ok) {
			if (response.status === 404) {
				throw new Error(
					`MCP request HTTP 404 (not found) at ${this.config.baseUrl}: ${response.statusText}. ` +
					`The configured MCP base URL does not expose the JSON-RPC endpoint; check the MCP URL in the node configuration.`
				);
			}
			if (response.status === 401 || response.status === 403) {
				throw new Error(
					`MCP request HTTP ${response.status} at ${this.config.baseUrl}: ${response.statusText}. ` +
					`The MCP server rejected the request; check the X-User-ID header and the MCP server access list.`
				);
			}
			if (response.status === 503) {
				throw new Error(
					`MCP request HTTP 503 (service unavailable) at ${this.config.baseUrl}: ${response.statusText}. ` +
					`The MCP server is reachable but not ready; retry after a short delay.`
				);
			}
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		return response.json();
	}

	/**
	 * Initialize connection to MCP server
	 */
	async initialize(): Promise<McpToolResult<{ serverInfo: { name: string; version: string } }>> {
		try {
			const response = await this.request<{ serverInfo: { name: string; version: string } }>('initialize');

			if (response.error) {
				return { success: false, error: response.error.message };
			}

			this.initialized = true;
			return { success: true, data: response.result as { serverInfo: { name: string; version: string } } };
		} catch (e) {
			return { success: false, error: e instanceof Error ? e.message : 'Failed to initialize' };
		}
	}

	/**
	 * Check if MCP server is available
	 */
	async ping(): Promise<boolean> {
		try {
			const response = await this.request('ping');
			return !response.error;
		} catch {
			return false;
		}
	}

	/**
	 * List available MCP tools
	 */
	async listTools(): Promise<McpToolResult<McpToolDefinition[]>> {
		try {
			const response = await this.request<McpToolDefinition[]>('tools/list');

			if (response.error) {
				return { success: false, error: response.error.message };
			}

			return { success: true, data: response.result?.tools ?? [] };
		} catch (e) {
			return { success: false, error: e instanceof Error ? e.message : 'Failed to list tools' };
		}
	}

	/**
	 * Call an MCP tool
	 */
	async callTool<T = unknown>(name: string, args?: Record<string, unknown>): Promise<McpToolResult<T>> {
		try {
			const response = await this.request('tools/call', {
				name,
				arguments: args ?? {}
			});

			if (response.error) {
				return { success: false, error: response.error.message };
			}

			// Extract the text content and parse as JSON
			const content = response.result?.content;
			if (content && content.length > 0 && content[0].type === 'text') {
				try {
					const data = JSON.parse(content[0].text);
					return { success: true, data };
				} catch {
					// If not JSON, return as string
					return { success: true, data: content[0].text as T };
				}
			}

			return { success: true, data: response.result as T };
		} catch (e) {
			return { success: false, error: e instanceof Error ? e.message : 'Failed to call tool' };
		}
	}

	// ============================================
	// Spawner-specific tool wrappers
	// ============================================

	/**
	 * Search for skills
	 */
	async searchSkills(query?: string, options?: {
		tag?: string;
		layer?: number;
		source?: 'all' | 'v1' | 'v2';
		limit?: number;
		category?: string;
	}): Promise<McpToolResult<McpSkillsResponse>> {
		return this.callTool<McpSkillsResponse>('spawner_skills', {
			action: 'search',
			query,
			...options
		});
	}

	/**
	 * List all skills
	 */
	async listSkills(options?: {
		tag?: string;
		layer?: number;
		source?: 'all' | 'v1' | 'v2';
	}): Promise<McpToolResult<McpSkillsResponse>> {
		return this.callTool<McpSkillsResponse>('spawner_skills', {
			action: 'list',
			...options
		});
	}

	/**
	 * Get a specific skill by name
	 */
	async getSkill(name: string): Promise<McpToolResult<{ skill: McpSkill; content: string }>> {
		return this.callTool('spawner_skills', {
			action: 'get',
			name
		});
	}

	/**
	 * Get local skill file paths
	 */
	async getLocalSkillPaths(): Promise<McpToolResult<{ paths: string[]; base_path: string }>> {
		return this.callTool('spawner_skills', {
			action: 'local'
		});
	}

	/**
	 * Orchestrate - main entry point for spawner
	 */
	async orchestrate(options: {
		cwd: string;
		user_message?: string;
		files?: string[];
		package_json?: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
	}): Promise<McpToolResult<unknown>> {
		return this.callTool('spawner_orchestrate', options);
	}

	/**
	 * Validate code
	 */
	async validate(code: string, filePath: string, checkTypes?: ('security' | 'patterns' | 'production')[]): Promise<McpToolResult<unknown>> {
		return this.callTool('spawner_validate', {
			code,
			file_path: filePath,
			check_types: checkTypes
		});
	}

	/**
	 * Get sharp edges / gotchas
	 */
	async watchOut(options?: {
		stack?: string[];
		situation?: string;
		code_context?: string;
	}): Promise<McpToolResult<unknown>> {
		return this.callTool('spawner_watch_out', options);
	}

	/**
	 * Analyze a codebase
	 */
	async analyze(options: {
		files?: string[];
		dependencies?: Record<string, string>;
		code_samples?: Array<{ path: string; content: string }>;
		question?: string;
	}): Promise<McpToolResult<unknown>> {
		return this.callTool('spawner_analyze', options);
	}

	// ============================================
	// Mission Management
	// ============================================

	/**
	 * Create a new mission
	 */
	async createMission(options: {
		name: string;
		description?: string;
		mode?: 'claude-code' | 'api' | 'sdk' | 'multi-llm-orchestrator';
		agents?: MissionAgent[];
		tasks?: MissionTask[];
		context?: Partial<MissionContext>;
	}): Promise<McpToolResult<{ success: boolean; mission: Mission; _instruction: string }>> {
		return this.callTool('spawner_mission', {
			action: 'create',
			...options
		});
	}

	/**
	 * Get a mission by ID
	 */
	async getMission(missionId: string): Promise<McpToolResult<{ mission: Mission; execution_prompt: string; _instruction: string }>> {
		return this.callTool('spawner_mission', {
			action: 'get',
			mission_id: missionId
		});
	}

	/**
	 * List missions
	 */
	async listMissions(options?: {
		status?: Mission['status'];
		limit?: number;
	}): Promise<McpToolResult<{ missions: Mission[]; count: number; _instruction: string }>> {
		return this.callTool('spawner_mission', {
			action: 'list',
			...options
		});
	}

	/**
	 * Update a mission
	 */
	async updateMission(missionId: string, updates: {
		name?: string;
		description?: string;
		agents?: MissionAgent[];
		tasks?: MissionTask[];
		context?: MissionContext;
		status?: Mission['status'];
		current_task_id?: string;
		outputs?: Record<string, unknown>;
	}): Promise<McpToolResult<{ success: boolean; mission: Mission }>> {
		return this.callTool('spawner_mission', {
			action: 'update',
			mission_id: missionId,
			...updates
		});
	}

	/**
	 * Start a mission
	 */
	async startMission(missionId: string): Promise<McpToolResult<{ success: boolean; mission: Mission; _instruction: string }>> {
		void missionId;
		return { success: false, error: GOVERNED_LIFECYCLE_ERROR };
	}

	/**
	 * Complete a mission
	 */
	async completeMission(missionId: string, outputs?: Record<string, unknown>): Promise<McpToolResult<{ success: boolean; mission: Mission; _instruction: string }>> {
		void missionId;
		void outputs;
		return { success: false, error: GOVERNED_LIFECYCLE_ERROR };
	}

	/**
	 * Fail a mission
	 */
	async failMission(missionId: string, error?: string): Promise<McpToolResult<{ success: boolean; mission: Mission; _instruction: string }>> {
		void missionId;
		void error;
		return { success: false, error: GOVERNED_LIFECYCLE_ERROR };
	}

	/**
	 * Delete a mission
	 */
	async deleteMission(missionId: string): Promise<McpToolResult<{ success: boolean; message: string }>> {
		return this.callTool('spawner_mission', {
			action: 'delete',
			mission_id: missionId
		});
	}

	/**
	 * Add a log entry to a mission
	 */
	async addMissionLog(missionId: string, options: {
		log_type: 'start' | 'progress' | 'handoff' | 'complete' | 'error';
		message: string;
		agent_id?: string;
		task_id?: string;
		data?: Record<string, unknown>;
	}): Promise<McpToolResult<{ success: boolean; log: MissionLog }>> {
		return this.callTool('spawner_mission', {
			action: 'log',
			mission_id: missionId,
			...options
		});
	}

	/**
	 * Get mission logs
	 */
	async getMissionLogs(missionId: string, options?: {
		since?: string;
		limit?: number;
	}): Promise<McpToolResult<{ logs: MissionLog[]; count: number; mission_id: string }>> {
		return this.callTool('spawner_mission', {
			action: 'logs',
			mission_id: missionId,
			...options
		});
	}

}

// Mission types (matching spawner-v2)
export interface MissionAgent {
	id: string;
	name: string;
	role: string;
	skills: string[];
	systemPrompt?: string;
	model?: 'sonnet' | 'opus' | 'haiku';
}

export interface MissionTask {
	id: string;
	title: string;
	description: string;
	assignedTo: string;
	dependsOn?: string[];
	status: 'pending' | 'in_progress' | 'blocked' | 'completed' | 'failed';
	handoffType: 'sequential' | 'parallel' | 'conditional' | 'review';
	handoffTo?: string[];
}

export interface MissionContext {
	projectPath: string;
	projectType: string;
	techStack?: string[];
	constraints?: string[];
	goals: string[];
}

export interface Mission {
	id: string;
	user_id: string;
	name: string;
	description: string | null;
	mode: 'claude-code' | 'api' | 'sdk' | 'multi-llm-orchestrator';
	status: 'draft' | 'ready' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
	agents: MissionAgent[];
	tasks: MissionTask[];
	context: MissionContext;
	current_task_id: string | null;
	outputs: Record<string, unknown>;
	error: string | null;
	created_at: string;
	updated_at: string;
	started_at: string | null;
	completed_at: string | null;
}

export interface MissionLog {
	id: string;
	mission_id: string;
	agent_id: string | null;
	task_id: string | null;
	type: 'start' | 'progress' | 'handoff' | 'complete' | 'error';
	message: string;
	data: Record<string, unknown>;
	created_at: string;
}

// Singleton instance
export const mcpClient = new McpClient();

// Export class for testing or multiple instances
export { McpClient };
