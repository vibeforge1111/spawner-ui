import { logger } from '$lib/utils/logger';
/**
 * Mission Builder Service
 *
 * Converts canvas workflows to Mission format for execution.
 * Maps nodes to tasks, connections to handoffs, and generates agent assignments.
 *
 * NEW: Automatically loads H70 skills based on task types and includes
 * them in the execution prompt for Claude Code guidance.
 */

import type { CanvasNode, Connection } from '$lib/stores/canvas.svelte';
import type { MissionAgent, MissionTask, MissionContext, Mission } from '$lib/services/mcp-client';
import { mcpClient } from '$lib/services/mcp-client';
import { getAllRequiredSkills, getSkillPriorities, matchTaskToSkills } from './h70-skill-matcher';
import { loadSkillsForMission, type H70SkillContent } from './h70-skills';
import type { MCPRuntimeSnapshot, MCPRuntimeTool } from './mcp-runtime';
import { SKILL_MCP_MAP } from '$lib/types/mcp';
import { browser } from '$app/environment';

const NO_BUILD_INCOMPATIBLE_SKILLS = new Set([
	'vite',
	'nextjs-app-router',
	'sveltekit',
	'svelte-kit',
	'react-patterns',
	'react-native-specialist',
	'tailwind-css',
	'tailwind-ui',
	'typescript-strict'
]);

function isNoBuildVanillaMission(options: MissionBuildOptions, tasks: MissionTask[]): boolean {
	const text = [
		options.description || '',
		options.projectType || '',
		...(options.techStack || []),
		...(options.goals || []),
		...tasks.flatMap((task) => [task.title, task.description])
	].join('\n').toLowerCase();

	return (
		/\bno\s+build\s+step\b/.test(text) ||
		/\bvanilla[-\s]?js\b/.test(text) ||
		/\bno\s+dependencies\b/.test(text) ||
		/\bopen(?:ing)?\s+index\.html\s+directly\b/.test(text)
	);
}

function filterSkillsForMissionContract(skills: string[], options: MissionBuildOptions, tasks: MissionTask[]): string[] {
	if (!isNoBuildVanillaMission(options, tasks)) return skills;
	return skills.filter((skill) => !NO_BUILD_INCOMPATIBLE_SKILLS.has(skill));
}

export interface MissionBuildOptions {
	missionId?: string;
	name: string;
	description?: string;
	mode?: Mission['mode'];
	projectPath?: string;
	projectType?: string;
	techStack?: string[];
	goals?: string[];
	/** Enable H70 skill auto-loading (default: true) */
	loadH70Skills?: boolean;
	/** Maximum skills to load per task (default: 3) */
	maxSkillsPerTask?: number;
	/** Maximum total skills to load (default: 10) */
	maxTotalSkills?: number;
}

export interface MissionBuildResult {
	success: boolean;
	mission?: Mission;
	error?: string;
	/** H70 skills loaded for this mission */
	loadedSkills?: Map<string, H70SkillContent>;
	/** Skill IDs matched per task */
	taskSkillMap?: Map<string, string[]>;
	/** MCP IDs recommended per task (derived from SKILL_MCP_MAP) */
	taskMCPMap?: Map<string, string[]>;
}

/**
 * Check if a node represents a question/decision rather than an executable task
 */
function isQuestionNode(node: CanvasNode): boolean {
	const name = node.skill.name.toLowerCase();
	const desc = (node.skill.description || '').toLowerCase();
	return (
		name.endsWith('?') ||
		desc.endsWith('?') ||
		name.startsWith('should we') ||
		name.startsWith('do we') ||
		name.startsWith('can we') ||
		name.startsWith('would') ||
		/^(what|how|why|when|where|which)\s/i.test(name)
	);
}

/**
 * Filter out non-executable nodes (questions, empty descriptions)
 * Returns filtered nodes and list of removed nodes
 */
function filterExecutableNodes(
	nodes: CanvasNode[],
	connections: Connection[]
): { nodes: CanvasNode[]; connections: Connection[]; removed: CanvasNode[] } {
	const removed: CanvasNode[] = [];
	const removedIds = new Set<string>();

	// Filter out question nodes
	const executableNodes = nodes.filter((node) => {
		if (isQuestionNode(node)) {
			removed.push(node);
			removedIds.add(node.id);
			return false;
		}
		return true;
	});

	// Remove connections to/from removed nodes
	const validConnections = connections.filter(
		(conn) => !removedIds.has(conn.sourceNodeId) && !removedIds.has(conn.targetNodeId)
	);

	if (removed.length > 0) {
		logger.info(
			`[MissionBuilder] Filtered out ${removed.length} non-executable node(s): ${removed.map((n) => n.skill.name).join(', ')}`
		);
	}

	return { nodes: executableNodes, connections: validConnections, removed };
}

/**
 * Deduplicate nodes by skill ID
 * When multiple nodes have the same skill, keep the first one
 * and merge their connections
 */
function deduplicateNodes(
	nodes: CanvasNode[],
	connections: Connection[]
): { nodes: CanvasNode[]; connections: Connection[]; merged: Map<string, string[]> } {
	const seenSkillIds = new Map<string, string>(); // skillId -> first nodeId
	const merged = new Map<string, string[]>(); // kept nodeId -> merged nodeIds
	const nodeIdMap = new Map<string, string>(); // old nodeId -> new nodeId (for remapping connections)

	const dedupedNodes: CanvasNode[] = [];

	for (const node of nodes) {
		const skillId = node.skill.id;

		if (seenSkillIds.has(skillId)) {
			// Duplicate - map to the original node
			const originalNodeId = seenSkillIds.get(skillId)!;
			nodeIdMap.set(node.id, originalNodeId);

			// Track what was merged
			const mergedList = merged.get(originalNodeId) || [];
			mergedList.push(node.id);
			merged.set(originalNodeId, mergedList);
		} else {
			// First occurrence - keep it
			seenSkillIds.set(skillId, node.id);
			nodeIdMap.set(node.id, node.id); // Maps to itself
			dedupedNodes.push(node);
		}
	}

	// Remap connections to use deduplicated node IDs
	const dedupedConnections: Connection[] = [];
	const connectionSet = new Set<string>(); // Prevent duplicate connections

	for (const conn of connections) {
		const newSourceId = nodeIdMap.get(conn.sourceNodeId) || conn.sourceNodeId;
		const newTargetId = nodeIdMap.get(conn.targetNodeId) || conn.targetNodeId;

		// Skip self-loops created by merging
		if (newSourceId === newTargetId) continue;

		const connectionKey = `${newSourceId}->${newTargetId}`;
		if (connectionSet.has(connectionKey)) continue;

		connectionSet.add(connectionKey);
		dedupedConnections.push({
			...conn,
			sourceNodeId: newSourceId,
			targetNodeId: newTargetId
		});
	}

	if (merged.size > 0) {
		const mergeInfo = [...merged.entries()].map(([kept, removed]) =>
			`${nodes.find(n => n.id === kept)?.skill.name}: merged ${removed.length} duplicates`
		);
		logger.info(`[MissionBuilder] Deduplicated nodes: ${mergeInfo.join(', ')}`);
	}

	return { nodes: dedupedNodes, connections: dedupedConnections, merged };
}

/**
 * Topologically sort nodes to determine execution order
 */
function topologicalSort(nodes: CanvasNode[], connections: Connection[]): CanvasNode[] {
	const adjacency = new Map<string, string[]>();
	const inDegree = new Map<string, number>();

	// Initialize
	for (const node of nodes) {
		adjacency.set(node.id, []);
		inDegree.set(node.id, 0);
	}

	// Build graph
	for (const conn of connections) {
		const targets = adjacency.get(conn.sourceNodeId) || [];
		targets.push(conn.targetNodeId);
		adjacency.set(conn.sourceNodeId, targets);
		inDegree.set(conn.targetNodeId, (inDegree.get(conn.targetNodeId) || 0) + 1);
	}

	// Kahn's algorithm
	const queue: string[] = [];
	for (const [nodeId, degree] of inDegree) {
		if (degree === 0) queue.push(nodeId);
	}

	const sorted: CanvasNode[] = [];
	const nodeMap = new Map(nodes.map((n) => [n.id, n]));

	while (queue.length > 0) {
		const nodeId = queue.shift()!;
		const node = nodeMap.get(nodeId);
		if (node) sorted.push(node);

		const neighbors = adjacency.get(nodeId) || [];
		for (const neighbor of neighbors) {
			const newDegree = (inDegree.get(neighbor) || 1) - 1;
			inDegree.set(neighbor, newDegree);
			if (newDegree === 0) queue.push(neighbor);
		}
	}

	// Add unconnected nodes at the end. Track inclusion via a Set so the
	// tail pass stays linear — the prior sorted.includes shape was O(N^2)
	// across the full node list.
	const sortedIds = new Set(sorted.map((n) => n.id));
	for (const node of nodes) {
		if (!sortedIds.has(node.id)) sorted.push(node);
	}

	return sorted;
}

/**
 * Generate agents from nodes based on skill categories
 */
function generateAgents(nodes: CanvasNode[]): MissionAgent[] {
	// Group nodes by category to create specialized agents
	const categoryGroups = new Map<string, CanvasNode[]>();

	for (const node of nodes) {
		const category = node.skill.category || 'general';
		const existing = categoryGroups.get(category) || [];
		existing.push(node);
		categoryGroups.set(category, existing);
	}

	const agents: MissionAgent[] = [];

	for (const [category, categoryNodes] of categoryGroups) {
		// Collect unique skills for this category
		const skills = [...new Set(categoryNodes.map((n) => n.skill.id))];

		// Create an agent for each category
		agents.push({
			id: `agent-${category.toLowerCase().replace(/\s+/g, '-')}`,
			name: `${capitalize(category)} Agent`,
			role: `Handles ${category.toLowerCase()} tasks`,
			skills,
			model: 'sonnet' // Default model
		});
	}

	// If only one agent, give it a better name
	if (agents.length === 1) {
		agents[0].name = 'Primary Agent';
		agents[0].role = 'Executes all workflow tasks';
	}

	return agents;
}

/**
 * Generate tasks from nodes with proper dependencies
 */
function generateTasks(
	nodes: CanvasNode[],
	connections: Connection[],
	agents: MissionAgent[]
): MissionTask[] {
	const sortedNodes = topologicalSort(nodes, connections);
	const tasks: MissionTask[] = [];

	// Build dependency map (which nodes lead to which)
	const dependencyMap = new Map<string, string[]>();
	for (const conn of connections) {
		const deps = dependencyMap.get(conn.targetNodeId) || [];
		deps.push(conn.sourceNodeId);
		dependencyMap.set(conn.targetNodeId, deps);
	}

	// Build handoff map (which nodes this leads to)
	const handoffMap = new Map<string, string[]>();
	for (const conn of connections) {
		const targets = handoffMap.get(conn.sourceNodeId) || [];
		targets.push(conn.targetNodeId);
		handoffMap.set(conn.sourceNodeId, targets);
	}

	for (const node of sortedNodes) {
		const skill = node.skill;

		// Find the appropriate agent based on skill category
		const category = skill.category || 'general';
		const agent = agents.find(
			(a) => a.id === `agent-${category.toLowerCase().replace(/\s+/g, '-')}`
		) || agents[0];

		// Get dependencies (tasks that must complete before this one)
		const dependsOn = dependencyMap.get(node.id) || [];

		// Get handoffs (tasks that follow this one)
		const handoffTo = handoffMap.get(node.id) || [];

		// Determine handoff type
		let handoffType: MissionTask['handoffType'] = 'sequential';
		if (handoffTo.length > 1) {
			handoffType = 'parallel';
		} else if (handoffTo.length === 0) {
			handoffType = 'sequential'; // Terminal node
		}

		tasks.push({
			id: node.id,
			title: skill.name,
			description: skill.description || `Execute ${skill.name} skill`,
			assignedTo: agent.id,
			dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
			status: 'pending',
			handoffType,
			handoffTo: handoffTo.length > 0 ? handoffTo : undefined
		});
	}

	return tasks;
}

/**
 * Build a Mission from canvas nodes and connections
 * NOTE: This builds the mission locally - no MCP call needed
 *
 * NEW: Automatically loads relevant H70 skills based on task types
 */
export async function buildMissionFromCanvas(
	nodes: CanvasNode[],
	connections: Connection[],
	options: MissionBuildOptions
): Promise<MissionBuildResult> {
	if (nodes.length === 0) {
		return { success: false, error: 'Cannot create mission from empty canvas' };
	}

	try {
		// STEP 1: Filter out non-executable nodes (questions, decisions)
		const { nodes: executableNodes, connections: executableConns, removed } = filterExecutableNodes(nodes, connections);

		if (removed.length > 0) {
			logger.info(`[MissionBuilder] Removed ${removed.length} non-executable node(s)`);
		}

		// STEP 2: Deduplicate nodes with same skill ID
		// This prevents the same skill appearing multiple times as separate tasks
		const { nodes: dedupedNodes, connections: dedupedConnections, merged } = deduplicateNodes(executableNodes, executableConns);

		if (merged.size > 0) {
			logger.info(`[MissionBuilder] Reduced ${executableNodes.length} nodes to ${dedupedNodes.length} (merged ${executableNodes.length - dedupedNodes.length} duplicates)`);
		}

		// Generate agents based on skill categories
		const agents = generateAgents(dedupedNodes);

		// Generate tasks with dependencies
		const tasks = generateTasks(dedupedNodes, dedupedConnections, agents);

		// Build context
		const context: MissionContext = {
			projectPath: options.projectPath || '.',
			projectType: options.projectType || 'general',
			techStack: options.techStack || [],
			goals: options.goals || [options.description || `Complete ${options.name}`]
		};

		// Build mission locally (no MCP call - spawner_mission doesn't exist)
		const mission: Mission = {
			id: options.missionId || `mission-${Date.now()}`,
			user_id: 'local',
			name: options.name,
			description: options.description || '',
			status: 'ready',
			mode: options.mode || 'claude-code',
			agents,
			tasks,
			context,
			current_task_id: null,
			outputs: {},
			error: null,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			started_at: null,
			completed_at: null
		};

		// Auto-load H70 skills for the mission (browser only)
		let loadedSkills: Map<string, H70SkillContent> | undefined;
		let taskSkillMap: Map<string, string[]> | undefined;

		const shouldLoadSkills = browser && (options.loadH70Skills !== false);

		if (shouldLoadSkills) {
			// Dynamic limits based on task complexity
			// More tasks = more skills needed (cap at 50 for full H70 skill content)
			const taskCount = tasks.length;
			const defaultMaxPerTask = Math.min(5, Math.max(3, Math.ceil(taskCount / 3))); // 3-5 skills per task
			// Scale: 15 base + 2 per task, cap at 50 (full skills loaded, not condensed)
			const defaultMaxTotal = Math.min(50, Math.max(15, 15 + taskCount * 2)); // 15-50 based on complexity

			const maxPerTask = options.maxSkillsPerTask ?? defaultMaxPerTask;
			const maxTotal = options.maxTotalSkills ?? defaultMaxTotal;

			// Match tasks to skills
			taskSkillMap = new Map();
			const taskInfos = tasks.map(t => ({ name: t.title, description: t.description }));

			for (const task of tasks) {
				const matchedSkills = filterSkillsForMissionContract(
					matchTaskToSkills(task.title, task.description, maxPerTask),
					options,
					tasks
				);
				taskSkillMap.set(task.id, matchedSkills);
			}

			// Get prioritized skills (most relevant across all tasks)
			const priorities = getSkillPriorities(taskInfos).filter((priority) =>
				filterSkillsForMissionContract([priority.skillId], options, tasks).length > 0
			);
			const skillsToLoad = priorities.slice(0, maxTotal).map(p => p.skillId);

			logger.info(`[MissionBuilder] Loading ${skillsToLoad.length} H70 skills (${taskCount} tasks, max ${maxTotal}):`, skillsToLoad);

			// Load the skills
			try {
				const { skills } = await loadSkillsForMission(skillsToLoad);
				loadedSkills = skills;
				logger.info(`[MissionBuilder] Successfully loaded ${skills.size} H70 skills`);
			} catch (e) {
				console.warn('[MissionBuilder] Failed to load H70 skills:', e);
				// Continue without skills - don't fail the mission build
			}
		}

		// Build per-task MCP recommendations from SKILL_MCP_MAP
		let taskMCPMap: Map<string, string[]> | undefined;
		if (taskSkillMap) {
			taskMCPMap = new Map();
			for (const [taskId, skillIds] of taskSkillMap.entries()) {
				const mcpIds = new Set<string>();
				for (const skillId of skillIds) {
					const entries = SKILL_MCP_MAP[skillId] || [];
					for (const entry of entries) {
						if (entry.priority !== 'optional') {
							entry.mcps.forEach((m) => mcpIds.add(m));
						}
					}
				}
				if (mcpIds.size > 0) taskMCPMap.set(taskId, [...mcpIds]);
			}
			if (taskMCPMap.size > 0) {
				const totalMCPs = new Set([...taskMCPMap.values()].flat());
				logger.info(`[MissionBuilder] Mapped ${totalMCPs.size} recommended MCPs across ${taskMCPMap.size} tasks`);
			}
		}

		return {
			success: true,
			mission,
			loadedSkills,
			taskSkillMap,
			taskMCPMap
		};
	} catch (e) {
		return {
			success: false,
			error: e instanceof Error ? e.message : 'Unknown error building mission'
		};
	}
}

/**
 * Options for generating execution prompts
 */
export interface ExecutionPromptOptions {
	/** Loaded H70 skills (used for UI display, not included in prompt) */
	loadedSkills?: Map<string, H70SkillContent>;
	/** Mapping of task ID to skill IDs - these are listed in the prompt for just-in-time loading */
	taskSkillMap?: Map<string, string[]>;
	/** Mapping of task ID to recommended MCP IDs (from SKILL_MCP_MAP) */
	taskMCPMap?: Map<string, string[]>;
	/** Base URL for event reporting (defaults to window.location.origin in browser) */
	baseUrl?: string;
	/** Connected MCP tools snapshot — included in the prompt so Claude Code can use them */
	mcpSnapshot?: MCPRuntimeSnapshot;
	/** Whether to include H70 skills in the prompt (default: true) */
	includeSkills?: boolean;
	/** Whether to include MCP tools in the prompt (default: true) */
	includeMCPs?: boolean;
}

/**
 * Generate a copy-pasteable execution prompt for Claude Code
 *
 * ARCHITECTURE: Just-in-time skill loading
 * - This prompt does NOT include skill content (would be 20,000+ lines)
 * - Instead, it lists which H70 skills to load for each task
 * - Claude Code fetches FULL skill content when starting each task
 * - Skills are loaded from local files via MCP or direct read
 */
export function generateExecutionPrompt(
	mission: Mission,
	options?: ExecutionPromptOptions
): string {
	const { taskSkillMap, taskMCPMap, baseUrl, mcpSnapshot, includeSkills = true, includeMCPs = true } = options || {};

	// Use provided baseUrl, or default to the local Spawner port.
	const eventUrl = baseUrl || 'http://localhost:3333';
	const eventAuthSetup = `Before POSTing lifecycle events, derive the event bridge key from your environment:
\`\`\`bash
EVENTS_AUTH_KEY="\${EVENTS_API_KEY:-$MCP_API_KEY}"
test -n "$EVENTS_AUTH_KEY" || { echo "Missing EVENTS_API_KEY or MCP_API_KEY for /api/events"; exit 1; }
\`\`\``;

	// Build task list with skill IDs and MCP recommendations
	const taskList = mission.tasks
		.map((t, i) => {
			const deps = t.dependsOn?.length ? ` (after: ${t.dependsOn.join(', ')})` : '';
			const recommendedSkills = includeSkills ? (taskSkillMap?.get(t.id) || []) : [];
			const skillsLine = recommendedSkills.length
				? `\n   **Load H70 Skills**: ${recommendedSkills.map(s => `\`${s}\``).join(', ')}`
				: '';
			const recommendedMCPs = includeMCPs ? (taskMCPMap?.get(t.id) || []) : [];
			const mcpLine = recommendedMCPs.length
				? `\n   **Use MCP Tools**: ${recommendedMCPs.map(m => `\`${m}\``).join(', ')}`
				: '';
			return `${i + 1}. **${t.title}** (id: ${t.id})${deps}\n   ${t.description}${skillsLine}${mcpLine}`;
		})
		.join('\n\n');

	// Collect all unique skill IDs across all tasks (only if skills enabled)
	const allSkillIds = new Set<string>();
	if (includeSkills && taskSkillMap) {
		for (const skills of taskSkillMap.values()) {
			skills.forEach(s => allSkillIds.add(s));
		}
	}
	const skillIdList = [...allSkillIds].sort().join(', ');

	// Build MCP tools section if MCPs are connected and enabled
	let mcpSection = '';
	if (includeMCPs && mcpSnapshot?.connected && mcpSnapshot.tools.length > 0) {
		// Collect all MCP IDs recommended by tasks
		const missionRelevantMCPIds = new Set<string>();
		if (taskMCPMap) {
			for (const mcpIds of taskMCPMap.values()) {
				mcpIds.forEach((m) => missionRelevantMCPIds.add(m));
			}
		}

		// Group tools by MCP name
		const byMcp = new Map<string, { tools: MCPRuntimeTool[]; instanceId: string; definitionId: string }>();
		for (const tool of mcpSnapshot.tools) {
			const key = `${tool.mcpName}|||${tool.instanceId}`;
			if (!byMcp.has(key)) byMcp.set(key, { tools: [], instanceId: tool.instanceId, definitionId: tool.definitionId });
			byMcp.get(key)!.tools.push(tool);
		}

		function formatMcpGroup(key: string, data: { tools: MCPRuntimeTool[]; instanceId: string }) {
			const [mcpName] = key.split('|||');
			const toolLines = data.tools.map((t) => {
				const desc = t.description ? ` — ${t.description}` : '';
				return `- \`${t.toolName}\`${desc}`;
			}).join('\n');
			return `### ${mcpName} (instance: ${data.instanceId})\n${toolLines}`;
		}

		// Split into mission-relevant and other
		const relevant: string[] = [];
		const other: string[] = [];
		for (const [key, data] of byMcp.entries()) {
			const entry = formatMcpGroup(key, data);
			if (missionRelevantMCPIds.has(data.definitionId)) {
				relevant.push(entry);
			} else {
				other.push(entry);
			}
		}

		// If no task-level routing, show all as general
		const hasRouting = relevant.length > 0;
		const mcpEntries = hasRouting
			? `### Mission-Relevant MCPs\n\n${relevant.join('\n\n')}\n\n### Also Available\n\n${other.length > 0 ? other.join('\n\n') : '_None_'}`
			: [...byMcp.entries()].map(([key, data]) => formatMcpGroup(key, data)).join('\n\n');

		mcpSection = `
## Connected MCP Tools

The following MCP servers are connected as governed capabilities for this mission.
Use MCP tools only through an authority-bound Spark Agent tool bridge or a runtime-supplied \`executionAuthority\`.
Do not invent, copy, or omit \`executionAuthority\`, and do not call \`${eventUrl}/api/mcp/call\` with a bare payload.
If no authority-bound MCP bridge is available, report that MCP execution is unavailable and use the safest non-tool fallback.

${mcpEntries}
`;
	}

	// Build conditional sections
	const skillsRequiredSection = includeSkills
		? `## H70 Skills Required\n${skillIdList || 'None specified'}\n`
		: '';

	const skillLoadingSection = includeSkills
		? `## CRITICAL: How to Load H70 Skills

**Before starting each task**, load its H70 skills using ONE of these methods:

### Method 1: MCP Tool (Preferred)
\`\`\`
Use: mcp__spawner_h70__spawner_h70_skills
With: action="get", name="<skill-id>"
\`\`\`

### Method 2: Direct File Read
\`\`\`
Read: C:/Users/USER/Desktop/vibeship-h70/skill-lab/<skill-id>/skill.yaml
\`\`\`

**IMPORTANT**: Load the FULL skill content. Each H70 skill contains:
- **identity**: Expert persona and deep knowledge
- **owns**: What this skill handles
- **delegates**: When to hand off to other skills
- **disasters**: Real war stories and critical lessons
- **anti_patterns**: Mistakes to avoid (with code smells)
- **patterns**: Recommended implementations

`
		: '';

	const skillWorkflowSteps = includeSkills
		? `2. **Load Skills** - Fetch the H70 skills listed for this task (see "Load H70 Skills" in task)

3. **Execute** - Complete the task following the skill's patterns, avoiding anti-patterns`
		: `2. **Execute** - Complete the task`;

	const skillCompletionLines = includeSkills
		? `### Per-Task Requirements
1. **Load Skills First** - Report with the authenticated event bridge header: \`curl -X POST ${eventUrl}/api/events -H "Content-Type: application/json" -H "x-api-key: $EVENTS_AUTH_KEY" -d '{"type":"skill_loaded","skillId":"..."}'\`
2. **Execute Task** - Follow skill patterns, avoid anti-patterns
3. **Report Progress** - At 25%, 50%, 75% for long tasks
4. **Verify Before Complete** - Check artifacts exist, no errors

### DO NOT
- Skip feature tasks after infrastructure is set up
- Mark tasks "complete" without verification
- Ignore listed skills - they contain critical patterns
- Rush to "mission_completed" - complete ALL tasks first

### Task Completion Quality
Each task should produce:
- **Artifacts**: Files created/modified
- **No Errors**: Code compiles, tests pass
- **Skills Applied**: Patterns from loaded skills used`
		: `### Per-Task Requirements
1. **Execute Task** - Complete the task fully
2. **Report Progress** - At 25%, 50%, 75% for long tasks
3. **Verify Before Complete** - Check artifacts exist, no errors

### DO NOT
- Skip feature tasks after infrastructure is set up
- Mark tasks "complete" without verification
- Rush to "mission_completed" - complete ALL tasks first

### Task Completion Quality
Each task should produce:
- **Artifacts**: Files created/modified
- **No Errors**: Code compiles, tests pass`;

	return `# Mission: ${mission.name}

${mission.description || ''}

## Context
- **Mission ID**: ${mission.id}
- **Project Path**: ${mission.context.projectPath}
- **Project Type**: ${mission.context.projectType}
- **Tech Stack**: ${mission.context.techStack?.join(', ') || 'Not specified'}
- **Goals**: ${mission.context.goals?.join('; ') || mission.description}

${skillsRequiredSection}${mcpSection}
## Tasks (Execute in Order)

${taskList}

${skillLoadingSection}## Workflow Per Task

${eventAuthSetup}

For each task in order:

1. **Report Start**
   \`\`\`bash
   curl -X POST ${eventUrl}/api/events -H "Content-Type: application/json" -H "x-api-key: $EVENTS_AUTH_KEY" -d '{"type":"task_started","missionId":"${mission.id}","taskId":"TASK_ID","taskName":"TASK_NAME"}'
   \`\`\`

${skillWorkflowSteps}

4. **Report Progress** (for long tasks)
   \`\`\`bash
   curl -X POST ${eventUrl}/api/events -H "Content-Type: application/json" -H "x-api-key: $EVENTS_AUTH_KEY" -d '{"type":"progress","missionId":"${mission.id}","taskId":"TASK_ID","progress":50,"message":"Working on..."}'
   \`\`\`

5. **Verify Before Reporting Complete**
   - Run \`npm run build\` (or equivalent) — check for errors
   - Run type check if applicable (\`npx tsc --noEmit\`)
   - List files created/modified for this task

6. **Report Complete with Verification**
   \`\`\`bash
   curl -X POST ${eventUrl}/api/events -H "Content-Type: application/json" -H "x-api-key: $EVENTS_AUTH_KEY" -d '{"type":"task_completed","missionId":"${mission.id}","taskId":"TASK_ID","taskName":"TASK_NAME","data":{"success":true,"verification":{"build":true,"typecheck":true,"filesChanged":["src/file1.ts","src/file2.ts"]}}}'
   \`\`\`
   If verification fails, set the relevant field to false and \`success\` to false.

7. **Move to Next Task**${includeSkills ? " - Load the next task's skills and repeat" : ''}

## Completion Protocol

${skillCompletionLines}

## Mission Completion Gate

Do NOT send \`mission_completed\` until:
- ALL ${mission.tasks.length} tasks have been attempted and reported
- Final build passes (run \`npm run build\` or equivalent one last time)
- No unresolved TypeScript/lint errors remain

Only then send:
\`\`\`bash
curl -X POST ${eventUrl}/api/events -H "Content-Type: application/json" -H "x-api-key: $EVENTS_AUTH_KEY" -d '{"type":"mission_completed","missionId":"${mission.id}"}'
\`\`\`

The system will reconcile task statuses and generate a checkpoint for human review. If tasks are still pending, the mission will be marked as partial — not complete.

## IMPORTANT: Resume After Interruption

If execution is interrupted (crash, pause, or context loss), you can resume:

### 1. Check Active Mission State
\`\`\`bash
curl ${eventUrl}/api/mission/active
\`\`\`

This returns:
- \`active\`: Whether there's a mission to resume
- \`completedTasks\`: Tasks already finished (don't redo these)
- \`currentTask\`: Task that was in progress when interrupted
- \`resumeInstructions\`: Specific guidance on continuing

### 2. Resume From Checkpoint
- **Skip completed tasks** - Check \`completedTasks\` array
- **Continue current task** - If \`currentTask\` is set, continue from where you left off
- **Don't restart from beginning** - Only work on pending tasks

### 3. If No Active Mission Found
If \`active: false\`, the mission was either completed or needs to be restarted.
Check \`active-mission.json\` in the configured Spawner state root manually for state.

### AUTONOMOUS EXECUTION RULES
- **Do NOT stop to ask questions** during task execution
- **Do NOT pause for confirmation** between tasks
- **Complete all tasks sequentially** without human intervention
- **Only pause if blocked** by an error you cannot resolve
- If you must pause, report it: \`{"type":"mission_paused","reason":"..."}\`

---

**START**: Begin with Task 1. Load its H70 skills first, then execute.
**RESUME**: If resuming, check \`/api/mission/active\` first to see completed tasks.`;
}

/**
 * Generate a resume execution prompt for partial missions.
 * Only includes pending/failed tasks — completed tasks are listed as context.
 */
export function generateResumeExecutionPrompt(
	mission: Mission,
	pendingTasks: MissionTask[],
	options?: ExecutionPromptOptions
): string {
	const { taskSkillMap, baseUrl } = options || {};
	const eventUrl = baseUrl || 'http://localhost:3333';
	const eventAuthSetup = `Before POSTing lifecycle events, derive the event bridge key from your environment:
\`\`\`bash
EVENTS_AUTH_KEY="\${EVENTS_API_KEY:-$MCP_API_KEY}"
test -n "$EVENTS_AUTH_KEY" || { echo "Missing EVENTS_API_KEY or MCP_API_KEY for /api/events"; exit 1; }
\`\`\``;

	const completedTasks = mission.tasks.filter(t => t.status === 'completed');
	const failedTasks = mission.tasks.filter(t => t.status === 'failed');

	const completedList = completedTasks.length > 0
		? completedTasks.map(t => `- [DONE] ${t.title} (${t.id})`).join('\n')
		: '- None';

	const failedList = failedTasks.length > 0
		? failedTasks.map(t => `- [FAILED] ${t.title} (${t.id})`).join('\n')
		: '';

	const taskList = pendingTasks
		.map((t, i) => {
			const deps = t.dependsOn?.length ? ` (after: ${t.dependsOn.join(', ')})` : '';
			const recommendedSkills = taskSkillMap?.get(t.id) || [];
			const skillsLine = recommendedSkills.length
				? `\n   **Load H70 Skills**: ${recommendedSkills.map(s => `\`${s}\``).join(', ')}`
				: '';
			return `${i + 1}. **${t.title}** (id: ${t.id})${deps}\n   ${t.description}${skillsLine}`;
		})
		.join('\n\n');

	return `# RESUME Mission: ${mission.name}

**This is a RESUME of a partial mission. Some tasks are already completed.**

## Context
- **Mission ID**: ${mission.id}
- **Project Path**: ${mission.context.projectPath}
- **Project Type**: ${mission.context.projectType}
- **Tech Stack**: ${mission.context.techStack?.join(', ') || 'Not specified'}

## Already Completed (DO NOT re-do these)
${completedList}
${failedList ? `\n## Previously Failed\n${failedList}\n` : ''}
## Remaining Tasks (Execute These)

${taskList}

## Workflow Per Task

${eventAuthSetup}

For each remaining task:

1. **Report Start**
   \`\`\`bash
   curl -X POST ${eventUrl}/api/events -H "Content-Type: application/json" -H "x-api-key: $EVENTS_AUTH_KEY" -d '{"type":"task_started","missionId":"${mission.id}","taskId":"TASK_ID","taskName":"TASK_NAME"}'
   \`\`\`

2. **Execute** - Complete the task fully

3. **Verify Before Complete** - Run \`npm run build\`, check for errors

4. **Report Complete**
   \`\`\`bash
   curl -X POST ${eventUrl}/api/events -H "Content-Type: application/json" -H "x-api-key: $EVENTS_AUTH_KEY" -d '{"type":"task_completed","missionId":"${mission.id}","taskId":"TASK_ID","taskName":"TASK_NAME","data":{"success":true,"verification":{"build":true,"typecheck":true,"filesChanged":["..."]}}}'
   \`\`\`

## Mission Completion Gate

Do NOT send \`mission_completed\` until ALL ${pendingTasks.length} remaining tasks have been attempted.

\`\`\`bash
curl -X POST ${eventUrl}/api/events -H "Content-Type: application/json" -H "x-api-key: $EVENTS_AUTH_KEY" -d '{"type":"mission_completed","missionId":"${mission.id}"}'
\`\`\`

### AUTONOMOUS EXECUTION RULES
- **Do NOT re-do completed tasks** listed above
- **Do NOT stop to ask questions** during task execution
- **Complete all remaining tasks sequentially**

---

**START**: Begin with the first remaining task above.`;
}

/**
 * Preview mission structure without creating it
 */
export function previewMission(
	nodes: CanvasNode[],
	connections: Connection[],
	options: MissionBuildOptions
): { agents: MissionAgent[]; tasks: MissionTask[]; duplicatesRemoved: number } {
	// Deduplicate before preview
	const { nodes: dedupedNodes, connections: dedupedConnections } = deduplicateNodes(nodes, connections);
	const duplicatesRemoved = nodes.length - dedupedNodes.length;

	const agents = generateAgents(dedupedNodes);
	const tasks = generateTasks(dedupedNodes, dedupedConnections, agents);
	return { agents, tasks, duplicatesRemoved };
}

/**
 * Validate canvas is suitable for mission conversion
 * Returns errors (blocking) and warnings (non-blocking like orphans)
 */
export function validateForMission(
	nodes: CanvasNode[],
	connections: Connection[]
): { valid: boolean; issues: string[]; errors: string[]; warnings: string[]; duplicateCount: number } {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (nodes.length === 0) {
		errors.push('Canvas is empty');
	}

	// Check for duplicate skills (warning, will be auto-merged)
	const skillIdCounts = new Map<string, number>();
	for (const node of nodes) {
		const count = skillIdCounts.get(node.skill.id) || 0;
		skillIdCounts.set(node.skill.id, count + 1);
	}

	const duplicates = [...skillIdCounts.entries()].filter(([_, count]) => count > 1);
	const duplicateCount = duplicates.reduce((sum, [_, count]) => sum + count - 1, 0);

	if (duplicates.length > 0) {
		const duplicateInfo = duplicates.map(([id, count]) => `${id} (${count}x)`).join(', ');
		warnings.push(`${duplicateCount} duplicate skill(s) will be merged: ${duplicateInfo}`);
	}

	// Check for circular dependencies (blocking error)
	const visited = new Set<string>();
	const stack = new Set<string>();

	function hasCycle(nodeId: string): boolean {
		visited.add(nodeId);
		stack.add(nodeId);

		const outgoing = connections.filter((c) => c.sourceNodeId === nodeId);
		for (const conn of outgoing) {
			if (!visited.has(conn.targetNodeId)) {
				if (hasCycle(conn.targetNodeId)) return true;
			} else if (stack.has(conn.targetNodeId)) {
				return true;
			}
		}

		stack.delete(nodeId);
		return false;
	}

	for (const node of nodes) {
		if (!visited.has(node.id) && hasCycle(node.id)) {
			errors.push('Circular dependency detected - missions must have linear flow');
			break;
		}
	}

	// Check for orphaned nodes (warning, not blocking error)
	const connectedNodes = new Set<string>();
	for (const conn of connections) {
		connectedNodes.add(conn.sourceNodeId);
		connectedNodes.add(conn.targetNodeId);
	}

	const orphans = nodes.filter((n) => !connectedNodes.has(n.id));
	if (orphans.length > 0 && nodes.length > 1) {
		warnings.push(
			`${orphans.length} node(s) not connected to workflow: ${orphans.map((n) => n.skill.name).join(', ')}`
		);
	}

	// Check for question nodes (not executable tasks)
	const questionNodes = nodes.filter((n) => {
		const name = n.skill.name.toLowerCase();
		const desc = (n.skill.description || '').toLowerCase();
		return (
			name.endsWith('?') ||
			desc.endsWith('?') ||
			name.startsWith('should we') ||
			name.startsWith('do we') ||
			name.startsWith('can we') ||
			name.startsWith('would') ||
			/^(what|how|why|when|where|which)\s/i.test(name)
		);
	});

	if (questionNodes.length > 0) {
		warnings.push(
			`${questionNodes.length} node(s) appear to be questions, not tasks: ${questionNodes.map((n) => n.skill.name).slice(0, 3).join(', ')}${questionNodes.length > 3 ? '...' : ''}`
		);
	}

	// Check for nodes with empty/missing descriptions
	const emptyDescNodes = nodes.filter((n) => {
		const desc = n.skill.description?.trim();
		const name = n.skill.name?.trim();
		return !desc || desc === name || desc.length < 10;
	});

	if (emptyDescNodes.length > 0) {
		warnings.push(
			`${emptyDescNodes.length} node(s) have empty/minimal descriptions: ${emptyDescNodes.map((n) => n.skill.name).slice(0, 3).join(', ')}${emptyDescNodes.length > 3 ? '...' : ''}`
		);
	}

	// Combine for backwards compatibility
	const issues = [...errors, ...warnings];

	// Only errors make it invalid - warnings are allowed
	return { valid: errors.length === 0, issues, errors, warnings, duplicateCount };
}

// Helper
function capitalize(str: string): string {
	return str.charAt(0).toUpperCase() + str.slice(1);
}
