import { writable, derived } from 'svelte/store';

export type AgentRole =
	| 'planner'
	| 'frontend'
	| 'backend'
	| 'database'
	| 'testing'
	| 'devops'
	| 'payments'
	| 'email'
	| 'search'
	| 'ai'
	| 'security'
	| 'mobile';

export type McpType = 'spawner' | 'scanner' | 'filesystem' | 'github' | 'browser';

export interface Agent {
	id: string;
	name: string;
	role: AgentRole;
	description: string;
	icon: string;
	skills: string[]; // skill IDs this agent uses
	tier: 'free' | 'premium';
	required?: boolean; // e.g., planner is always required
}

export interface MCP {
	id: string;
	name: string;
	type: McpType;
	description: string;
	icon: string;
	installCommand: string;
	configExample: string;
	tier: 'free' | 'premium';
}

export interface StackState {
	agents: Agent[];
	mcps: MCP[];
	selectedAgentIds: string[];
	selectedMcpIds: string[];
	projectDescription: string;
	projectType: 'saas' | 'marketplace' | 'ai-app' | 'web3' | 'tool' | 'other';
}

// Available agents
const defaultAgents: Agent[] = [
	{
		id: 'planner',
		name: 'Planner',
		role: 'planner',
		description: 'Orchestrates other agents, breaks down tasks, and coordinates execution',
		icon: '🎯',
		skills: ['system-designer', 'debugging-master'],
		tier: 'free',
		required: true
	},
	{
		id: 'frontend',
		name: 'Frontend',
		role: 'frontend',
		description: 'React, Vue, Svelte, Next.js, styling, and UI/UX implementation',
		icon: '🎨',
		skills: ['nextjs-app-router', 'react-patterns', 'tailwind-ui', 'accessibility-audit'],
		tier: 'free'
	},
	{
		id: 'backend',
		name: 'Backend',
		role: 'backend',
		description: 'APIs, server logic, authentication, and business logic',
		icon: '⚙️',
		skills: ['api-design', 'authentication-oauth', 'microservices-patterns'],
		tier: 'free'
	},
	{
		id: 'database',
		name: 'Database',
		role: 'database',
		description: 'PostgreSQL, Redis, migrations, queries, and data modeling',
		icon: '🗄️',
		skills: ['postgres-wizard', 'redis-specialist', 'supabase-backend'],
		tier: 'free'
	},
	{
		id: 'testing',
		name: 'Testing',
		role: 'testing',
		description: 'Unit tests, integration tests, E2E tests, and test strategies',
		icon: '🧪',
		skills: ['integration-testing', 'performance-profiling'],
		tier: 'free'
	},
	{
		id: 'devops',
		name: 'DevOps',
		role: 'devops',
		description: 'CI/CD, Docker, Kubernetes, deployment, and infrastructure',
		icon: '🚀',
		skills: ['aws-services', 'gcp-services', 'azure-services', 'disaster-recovery'],
		tier: 'free'
	},
	{
		id: 'payments',
		name: 'Payments',
		role: 'payments',
		description: 'Stripe, subscriptions, billing, and payment processing',
		icon: '💳',
		skills: ['stripe-payments', 'fintech-integration'],
		tier: 'free'
	},
	{
		id: 'email',
		name: 'Email',
		role: 'email',
		description: 'Transactional emails, templates, and email service integration',
		icon: '📧',
		skills: ['email-templating'],
		tier: 'free'
	},
	{
		id: 'search',
		name: 'Search',
		role: 'search',
		description: 'Full-text search, Elasticsearch, and search optimization',
		icon: '🔍',
		skills: ['elasticsearch-search'],
		tier: 'free'
	},
	{
		id: 'ai',
		name: 'AI/ML',
		role: 'ai',
		description: 'LLM integration, embeddings, RAG, and ML pipelines',
		icon: '🧠',
		skills: ['autonomous-agents', 'llm-fine-tuning', 'ml-ops', 'computer-vision-deep'],
		tier: 'free'
	},
	{
		id: 'security',
		name: 'Security',
		role: 'security',
		description: 'Security audits, vulnerability scanning, and compliance',
		icon: '🔒',
		skills: ['gdpr-privacy', 'compliance-automation'],
		tier: 'premium'
	},
	{
		id: 'mobile',
		name: 'Mobile',
		role: 'mobile',
		description: 'React Native, Flutter, and mobile app development',
		icon: '📱',
		skills: ['flutter-mobile'],
		tier: 'premium'
	}
];

// Available MCP servers
const defaultMcps: MCP[] = [
	{
		id: 'spawner',
		name: 'Spawner',
		type: 'spawner',
		description: 'Load Spark skill graphs, validate code, and get sharp edges',
		icon: '⚡',
		installCommand: 'npx @anthropic/spawner-mcp',
		configExample: `{
  "mcpServers": {
    "spawner": {
      "command": "npx",
      "args": ["@anthropic/spawner-mcp"]
    }
  }
}`,
		tier: 'free'
	},
	{
		id: 'scanner',
		name: 'Scanner',
		type: 'scanner',
		description: 'Security scanning with Opengrep, Trivy, and Gitleaks',
		icon: '🔍',
		installCommand: 'npx @anthropic/scanner-mcp',
		configExample: `{
  "mcpServers": {
    "scanner": {
      "command": "npx",
      "args": ["@anthropic/scanner-mcp"]
    }
  }
}`,
		tier: 'free'
	},
	{
		id: 'filesystem',
		name: 'Filesystem',
		type: 'filesystem',
		description: 'Read and write files in allowed directories',
		icon: '📁',
		installCommand: 'npx @modelcontextprotocol/server-filesystem',
		configExample: `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
    }
  }
}`,
		tier: 'free'
	},
	{
		id: 'github',
		name: 'GitHub',
		type: 'github',
		description: 'Create repos, manage issues, and work with GitHub API',
		icon: '🐙',
		installCommand: 'npx @modelcontextprotocol/server-github',
		configExample: `{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "your-token"
      }
    }
  }
}`,
		tier: 'free'
	},
	{
		id: 'browser',
		name: 'Browser',
		type: 'browser',
		description: 'Web scraping, browser automation, and page screenshots',
		icon: '🌐',
		installCommand: 'npx @anthropic/browser-mcp',
		configExample: `{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["@anthropic/browser-mcp"]
    }
  }
}`,
		tier: 'premium'
	}
];

// Initial state
const initialState: StackState = {
	agents: defaultAgents,
	mcps: defaultMcps,
	selectedAgentIds: ['planner'], // Planner always selected
	selectedMcpIds: ['spawner'], // Core MCPs
	projectDescription: '',
	projectType: 'saas'
};

// Create the store
function createStackStore() {
	const { subscribe, set, update } = writable<StackState>(initialState);

	return {
		subscribe,

		toggleAgent: (id: string) => {
			update(state => {
				const agent = state.agents.find(a => a.id === id);
				if (agent?.required) return state; // Can't deselect required agents

				const isSelected = state.selectedAgentIds.includes(id);
				return {
					...state,
					selectedAgentIds: isSelected
						? state.selectedAgentIds.filter(aid => aid !== id)
						: [...state.selectedAgentIds, id]
				};
			});
		},

		toggleMcp: (id: string) => {
			update(state => {
				const isSelected = state.selectedMcpIds.includes(id);
				return {
					...state,
					selectedMcpIds: isSelected
						? state.selectedMcpIds.filter(mid => mid !== id)
						: [...state.selectedMcpIds, id]
				};
			});
		},

		setProjectDescription: (description: string) => {
			update(state => ({ ...state, projectDescription: description }));
		},

		setProjectType: (type: StackState['projectType']) => {
			update(state => ({ ...state, projectType: type }));
		},

		selectAgents: (ids: string[]) => {
			update(state => ({ ...state, selectedAgentIds: ids }));
		},

		selectMcps: (ids: string[]) => {
			update(state => ({ ...state, selectedMcpIds: ids }));
		},

		reset: () => set(initialState)
	};
}

export const stackStore = createStackStore();

// Derived stores
export const selectedAgents = derived(stackStore, $store =>
	$store.agents.filter(a => $store.selectedAgentIds.includes(a.id))
);

export const selectedMcps = derived(stackStore, $store =>
	$store.mcps.filter(m => $store.selectedMcpIds.includes(m.id))
);

export const freeAgents = derived(stackStore, $store =>
	$store.agents.filter(a => a.tier === 'free')
);

export const premiumAgents = derived(stackStore, $store =>
	$store.agents.filter(a => a.tier === 'premium')
);

export const allSkillIds = derived(selectedAgents, $agents => {
	const skillSet = new Set<string>();
	for (const agent of $agents) {
		for (const skillId of agent.skills) {
			skillSet.add(skillId);
		}
	}
	return Array.from(skillSet);
});

// Recommendations based on project type
export const recommendedAgents = derived(stackStore, $store => {
	const recommendations: Record<StackState['projectType'], string[]> = {
		'saas': ['planner', 'frontend', 'backend', 'database', 'payments', 'email'],
		'marketplace': ['planner', 'frontend', 'backend', 'database', 'payments', 'search'],
		'ai-app': ['planner', 'frontend', 'backend', 'ai', 'database'],
		'web3': ['planner', 'frontend', 'backend', 'security'],
		'tool': ['planner', 'frontend', 'backend', 'testing'],
		'other': ['planner', 'frontend', 'backend']
	};
	return recommendations[$store.projectType] || recommendations.other;
});

// Generate config for export
export const generatedConfig = derived([selectedAgents, selectedMcps], ([$agents, $mcps]) => {
	const mcpConfig: Record<string, Record<string, unknown>> = {};
	for (const mcp of $mcps) {
		try {
			const parsed = JSON.parse(mcp.configExample);
			mcpConfig[mcp.id] = parsed.mcpServers?.[mcp.id] || {};
		} catch (e: unknown) {
			mcpConfig[mcp.id] = {};
		}
	}

	return {
		mcpServers: mcpConfig,
		agents: $agents.map(a => ({
			id: a.id,
			name: a.name,
			skills: a.skills
		}))
	};
});
