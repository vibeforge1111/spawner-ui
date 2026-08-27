/**
 * MCP Client Service
 *
 * Handles real MCP connections using the MCP SDK.
 * Supports stdio transport for local MCP servers.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { env } from '$env/dynamic/private';
import { basename } from 'node:path';
import { logger } from '$lib/utils/logger';

export interface MCPClientConfig {
	/** Command to run the MCP server */
	command: string;
	/** Arguments for the command */
	args?: string[];
	/** Environment variables */
	env?: Record<string, string>;
}

export interface ConnectedMCP {
	client: Client;
	transport: StdioClientTransport;
	tools: Tool[];
	serverInfo: {
		name: string;
		version: string;
	};
}

// Active connections
const MAX_MCP_CONNECTIONS = 10;
const connections = new Map<string, ConnectedMCP>();
const COMMAND_EXT_SUFFIX = /\.(exe|cmd|bat)$/i;
const DEFAULT_ALLOWED_COMMANDS = ['npx', 'node'];
const BASE_PROCESS_ENV_KEYS = [
	'PATH',
	'Path',
	'PATHEXT',
	'HOME',
	'USERPROFILE',
	'TEMP',
	'TMP',
	'TMPDIR',
	'SystemRoot',
	'WINDIR',
	'ComSpec',
	'APPDATA',
	'LOCALAPPDATA',
	'NPM_CONFIG_CACHE'
];
const log = logger.scope('MCP');

function parseCsv(value: string | undefined): string[] {
	if (!value) {
		return [];
	}
	return value
		.split(',')
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function normalizeCommand(command: string): string {
	return basename(command).replace(COMMAND_EXT_SUFFIX, '').toLowerCase();
}

function getAllowedCommands(): Set<string> {
	const configured = parseCsv(env.MCP_ALLOWED_COMMANDS);
	const allowed = configured.length > 0 ? configured : DEFAULT_ALLOWED_COMMANDS;
	return new Set(allowed.map((command) => normalizeCommand(command)));
}

function assertCommandAllowed(command: string): void {
	const normalized = normalizeCommand(command);
	const allowed = getAllowedCommands();
	if (!allowed.has(normalized)) {
		throw new Error(
			`MCP command "${command}" is not allowed. Allowed commands: ${Array.from(allowed).join(', ')}`
		);
	}
}

// Common MCP env vars allowed by default in local dev
const DEFAULT_ALLOWED_ENV_KEYS = new Set([
	'GITHUB_PERSONAL_ACCESS_TOKEN',
	'GITLAB_PERSONAL_ACCESS_TOKEN',
	'GITLAB_API_URL',
	'BRAVE_API_KEY',
	'SLACK_BOT_TOKEN',
	'SLACK_TEAM_ID',
	'POSTGRES_CONNECTION_STRING',
	'OPENAI_API_KEY',
	'ANTHROPIC_API_KEY',
]);

function sanitizeEnv(envVars?: Record<string, string>): Record<string, string> | undefined {
	if (!envVars) {
		return undefined;
	}

	const configuredKeys = parseCsv(env.MCP_ALLOWED_ENV_KEYS);
	const allowedKeys = configuredKeys.length > 0
		? new Set(configuredKeys)
		: DEFAULT_ALLOWED_ENV_KEYS;
	const envEntries = Object.entries(envVars);

	if (envEntries.length === 0) {
		return undefined;
	}

	const sanitized: Record<string, string> = {};
	for (const [key, value] of envEntries) {
		if (!allowedKeys.has(key)) {
			console.warn(`[MCP] Environment variable "${key}" is not in the allowed list, skipping`);
			continue;
		}
		sanitized[key] = value;
	}

	return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function baseProcessEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const base: Record<string, string> = {};
	for (const key of BASE_PROCESS_ENV_KEYS) {
		const value = source[key];
		if (typeof value === 'string' && value.length > 0) {
			base[key] = value;
		}
	}
	return base;
}

export function buildMcpProcessEnv(
	requestedEnv?: Record<string, string>,
	sourceEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
	return {
		...baseProcessEnv(sourceEnv),
		...sanitizeEnv(requestedEnv)
	};
}

export function mcpCustomConfigAllowed(): boolean {
	return env.MCP_ALLOW_CUSTOM_CONFIG?.trim() === '1';
}

/**
 * Connect to an MCP server via stdio
 */
export async function connectMCP(
	instanceId: string,
	config: MCPClientConfig
): Promise<ConnectedMCP> {
	// Check if already connected
	if (connections.has(instanceId)) {
		const existing = connections.get(instanceId)!;
		return existing;
	}

	assertCommandAllowed(config.command);
	const safeEnv = sanitizeEnv(config.env);

	log.info(`Connecting to: ${config.command} ${config.args?.join(' ') || ''}`);

	// Create transport
	const transport = new StdioClientTransport({
		command: config.command,
		args: config.args || [],
		env: buildMcpProcessEnv(safeEnv),
	});

	// Create client
	const client = new Client(
		{
			name: 'spawner-ui',
			version: '1.0.0',
		},
		{
			capabilities: {},
		}
	);

	// Connect
	await client.connect(transport);

	// Get server info
	const serverInfo = client.getServerVersion() || { name: 'unknown', version: '0.0.0' };

	// List available tools
	const toolsResult = await client.listTools();
	const tools = toolsResult.tools || [];

	log.info(`Connected to ${serverInfo.name} v${serverInfo.version}`);
	log.info(`Available tools: ${tools.map((t) => t.name).join(', ')}`);

	const connection: ConnectedMCP = {
		client,
		transport,
		tools,
		serverInfo: {
			name: serverInfo.name || 'unknown',
			version: serverInfo.version || '0.0.0',
		},
	};

	connections.set(instanceId, connection);
	return connection;
}

/**
 * Disconnect from an MCP server
 */
export async function disconnectMCP(instanceId: string): Promise<void> {
	const connection = connections.get(instanceId);
	if (!connection) {
		log.info(`No connection found for ${instanceId}`);
		return;
	}

	try {
		await connection.client.close();
		log.info(`Disconnected from ${connection.serverInfo.name}`);
	} catch (e) {
		console.error(`[MCP] Error disconnecting:`, e);
	}

	connections.delete(instanceId);
}

/**
 * Call a tool on an MCP server
 */
export async function callTool(
	instanceId: string,
	toolName: string,
	args: Record<string, unknown> = {}
): Promise<unknown> {
	const connection = connections.get(instanceId);
	if (!connection) {
		throw new Error(`Not connected to MCP: ${instanceId}`);
	}

	log.info(`Calling tool: ${toolName}`, args);

	const result = await connection.client.callTool({
		name: toolName,
		arguments: args,
	});

	log.info('Tool result:', result);
	return result;
}

/**
 * Get tools for a connected MCP
 */
export function getTools(instanceId: string): Tool[] {
	const connection = connections.get(instanceId);
	return connection?.tools || [];
}

/**
 * Check if an MCP is connected
 */
export function isConnected(instanceId: string): boolean {
	return connections.has(instanceId);
}

/**
 * Get all active connections
 */
export function getConnections(): Map<string, ConnectedMCP> {
	return connections;
}

/**
 * Get connection info for an instance
 */
export function getConnectionInfo(instanceId: string): ConnectedMCP | undefined {
	return connections.get(instanceId);
}

// Pre-configured MCP servers (no auth required)
export const PRECONFIGURED_MCPS: Record<string, MCPClientConfig> = {
	'test-server': {
		command: 'npx',
		args: ['tsx', 'src/lib/services/mcp/test-server.ts'],
	},
	'filesystem': {
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-filesystem', process.cwd()],
	},
	'everything': {
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-everything'],
	},
	'memory': {
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-memory'],
	},
};

export function isValidNpmPackageSpec(value: string): boolean {
	if (!value || value.length > 256 || value.trim() !== value) return false;
	if (value.startsWith('-') || value.includes('\\') || value.includes('://')) return false;
	return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9~^*][a-z0-9._+~^*-]*)?$/i.test(value);
}

/**
 * Build MCPClientConfig from a registry item's npmPackage field.
 * Falls back to PRECONFIGURED_MCPS if no npmPackage is set.
 */
export function buildConfigFromRegistry(
	mcpId: string,
	npmPackage?: string,
	defaultArgs?: string[],
	userEnv?: Record<string, string>
): MCPClientConfig | null {
	// Check preconfigured first
	if (PRECONFIGURED_MCPS[mcpId]) {
		const base = PRECONFIGURED_MCPS[mcpId];
		if (userEnv && Object.keys(userEnv).length > 0) {
			return { ...base, env: { ...base.env, ...userEnv } };
		}
		return base;
	}

	// Build from npmPackage
	if (npmPackage) {
		if (!isValidNpmPackageSpec(npmPackage)) {
			throw new Error('MCP npm package name is invalid');
		}
		return {
			command: 'npx',
			args: ['-y', npmPackage, ...(defaultArgs || [])],
			env: userEnv,
		};
	}

	return null;
}
