/**
 * Mission Builder Tests
 */

import { describe, it, expect } from 'vitest';
import { buildMissionFromCanvas, generateExecutionPrompt, validateForMission } from './mission-builder';
import type { CanvasNode, Connection } from '$lib/stores/canvas.svelte';
import type { Mission } from './mcp-client';

// Helper to create test nodes
function createNode(id: string, skillName: string = 'Test Skill'): CanvasNode {
	return {
		id,
		skillId: `skill-${id}`,
		position: { x: 100, y: 100 },
		skill: {
			id: `skill-${id}`,
			name: skillName,
			description: 'Test description',
			category: 'development',
			tier: 'free',
			tags: [],
			triggers: []
		}
	};
}

function createConnection(sourceId: string, targetId: string): Connection {
	return {
		id: `${sourceId}-${targetId}`,
		sourceNodeId: sourceId,
		targetNodeId: targetId,
		sourcePortId: 'output-0',
		targetPortId: 'input-0'
	};
}

describe('validateForMission', () => {
	it('should fail with no nodes', () => {
		const result = validateForMission([], []);
		expect(result.valid).toBe(false);
		// Check that there's at least one issue about empty canvas
		expect(result.issues.length).toBeGreaterThan(0);
	});

	it('should pass with single node', () => {
		const nodes = [createNode('1')];
		const result = validateForMission(nodes, []);
		expect(result.valid).toBe(true);
	});

	it('should pass with connected nodes', () => {
		const nodes = [
			createNode('1', 'Start'),
			createNode('2', 'End')
		];
		const connections = [createConnection('1', '2')];
		const result = validateForMission(nodes, connections);
		expect(result.valid).toBe(true);
	});

	it('should detect circular dependencies', () => {
		const nodes = [
			createNode('1'),
			createNode('2')
		];
		const connections = [
			createConnection('1', '2'),
			createConnection('2', '1')
		];
		const result = validateForMission(nodes, connections);
		expect(result.valid).toBe(false);
	});

	it('should pass complex DAG workflow', () => {
		// A -> B -> D
		//   \-> C -/
		const nodes = [
			createNode('A', 'Start'),
			createNode('B', 'Path 1'),
			createNode('C', 'Path 2'),
			createNode('D', 'End')
		];
		const connections = [
			createConnection('A', 'B'),
			createConnection('A', 'C'),
			createConnection('B', 'D'),
			createConnection('C', 'D')
		];
		const result = validateForMission(nodes, connections);
		expect(result.valid).toBe(true);
	});
});

describe('buildMissionFromCanvas', () => {
	it('preserves disconnected node order in generated tasks', async () => {
		const nodes = [
			createNode('node-c', 'Third'),
			createNode('node-a', 'First'),
			createNode('node-b', 'Second')
		];

		const result = await buildMissionFromCanvas(nodes, [], {
			name: 'Disconnected Tasks',
			projectPath: '/tmp/disconnected-tasks',
			loadH70Skills: false
		});

		expect(result.success).toBe(true);
		expect(result.mission?.tasks.map((task) => task.title)).toEqual(['Third', 'First', 'Second']);
	});

	it('does not inject framework build skills into no-build vanilla projects', async () => {
		const nodes = [
			createNode(
				'1',
				'task-1-foundation-layout: Create static app shell and responsive layout'
			)
		];
		nodes[0].skill.description = [
			'Build a vanilla-JS static app.',
			'Acceptance criteria:',
			'- No build step.',
			'- No package.json or dependency installation.',
			'- Opening index.html directly renders the app.'
		].join('\n');

		const result = await buildMissionFromCanvas(nodes, [], {
			name: 'Spark Static App',
			description: 'Build a vanilla-JS app with no build step and no dependencies.',
			projectPath: 'C:\\Users\\USER\\Desktop\\spark-static-app',
			loadH70Skills: true
		});

		expect(result.success).toBe(true);
		const skills = [...(result.taskSkillMap?.values() || [])].flat();
		expect(skills).not.toContain('react-patterns');
		expect(skills).not.toContain('tailwind-css');
		expect(skills).not.toContain('vite');
		expect(skills).not.toContain('typescript-strict');
	});
});

describe('generateExecutionPrompt', () => {
	it('requires authenticated event bridge reporting in provider prompts', () => {
		const mission: Mission = {
			id: 'mission-event-auth',
			user_id: 'test-user',
			name: 'Event Auth Mission',
			description: 'Validate event bridge auth wording',
			mode: 'multi-llm-orchestrator',
			status: 'ready',
			agents: [],
			tasks: [
				{
					id: 'task-1',
					title: 'Report progress',
					description: 'Emit lifecycle events only through keyed bridge.',
					assignedTo: 'agent-1',
					status: 'pending',
					handoffType: 'sequential'
				}
			],
			context: {
				projectPath: 'C:\\Users\\USER\\Desktop\\event-auth-mission',
				projectType: 'typescript',
				goals: ['preserve event bridge authority boundary']
			},
			current_task_id: null,
			outputs: {},
			error: null,
			created_at: '2026-06-05T00:00:00.000Z',
			updated_at: '2026-06-05T00:00:00.000Z',
			started_at: null,
			completed_at: null
		};

		const prompt = generateExecutionPrompt(mission, {
			includeSkills: true,
			baseUrl: 'http://127.0.0.1:3333'
		});

		expect(prompt).toContain('EVENTS_AUTH_KEY="${EVENTS_API_KEY:-$MCP_API_KEY}"');
		expect(prompt).toContain('-H "x-api-key: $EVENTS_AUTH_KEY"');
		expect(prompt).toContain('Missing EVENTS_API_KEY or MCP_API_KEY for /api/events');
		expect(prompt).not.toContain('curl POST http://127.0.0.1:3333/api/events');
	});

	it('keeps MCP tool instructions behind an authority-bound bridge', () => {
		const mission: Mission = {
			id: 'mission-mcp-authority',
			user_id: 'test-user',
			name: 'MCP Authority Mission',
			description: 'Validate governed MCP prompt wording',
			mode: 'multi-llm-orchestrator',
			status: 'ready',
			agents: [],
			tasks: [
				{
					id: 'task-1',
					title: 'Use governed MCP context',
					description: 'Inspect the available tool boundary.',
					assignedTo: 'agent-1',
					status: 'pending',
					handoffType: 'sequential'
				}
			],
			context: {
				projectPath: 'C:\\Users\\USER\\Desktop\\mcp-authority-mission',
				projectType: 'typescript',
				goals: ['preserve MCP authority boundary']
			},
			current_task_id: null,
			outputs: {},
			error: null,
			created_at: '2026-06-05T00:00:00.000Z',
			updated_at: '2026-06-05T00:00:00.000Z',
			started_at: null,
			completed_at: null
		};

		const prompt = generateExecutionPrompt(mission, {
			includeSkills: false,
			baseUrl: 'http://127.0.0.1:3333',
			mcpSnapshot: {
				connected: true,
				connectedCount: 1,
				capabilities: ['custom'],
				tools: [
					{
						instanceId: 'mcp-instance-1',
						definitionId: 'spawner-h70',
						mcpName: 'Spawner H70',
						toolName: 'spawner_h70_skills',
						description: 'Read H70 skills.',
						capabilities: ['custom']
					}
				]
			}
		});

		expect(prompt).toContain('Use MCP tools only through an authority-bound Spark Agent tool bridge');
		expect(prompt).toContain('runtime-supplied `executionAuthority`');
		expect(prompt).toContain('do not call `http://127.0.0.1:3333/api/mcp/call` with a bare payload');
		expect(prompt).not.toContain('curl -X POST http://127.0.0.1:3333/api/mcp/call');
	});
});
