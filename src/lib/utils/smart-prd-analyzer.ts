/**
 * Smart PRD Analyzer v2
 *
 * FIXES from v1:
 * 1. NO fixed task counts - tasks based on actual PRD content
 * 2. NO automatic infrastructure - only if explicitly needed
 * 3. Transforms observations into actionable tasks
 * 4. Generates delivery-focused missions (dynamic cap)
 * 5. Each task has verification criteria
 *
 * Philosophy: complete delivery over shallow scaffolds.
 */

import type { Skill, SkillCategory } from '$lib/stores/skills.svelte';

// =============================================================================
// TYPES
// =============================================================================

export interface SmartPRDAnalysis {
	projectName: string;
	projectType: ProjectType;
	/** Explicitly requested features (not inferred) */
	explicitFeatures: ActionableFeature[];
	/** Tech stack mentioned in PRD */
	techStack: TechStack;
	/** What infrastructure is EXPLICITLY required */
	infrastructure: InfrastructureNeeds;
	/** Recommended pipeline template */
	pipelineType: PipelineType;
	/** Confidence in analysis (0-1) */
	confidence: number;
}

export interface ActionableFeature {
	id: string;
	/** Action verb + object (e.g., "Implement user dashboard") */
	title: string;
	/** What this feature does */
	description: string;
	/** How to verify it's done */
	verification: VerificationCriteria;
	/** Priority based on PRD language */
	priority: 'critical' | 'important' | 'nice-to-have';
	/** Skills needed */
	skills: string[];
	/** Estimated complexity (1-3) */
	complexity: 1 | 2 | 3;
}

export interface VerificationCriteria {
	/** Files that must exist when done */
	files?: string[];
	/** Commands that must succeed */
	commands?: string[];
	/** Human-readable acceptance criteria */
	criteria: string[];
}

export interface TechStack {
	framework?: string;      // next, svelte, react, etc.
	language?: string;       // typescript, javascript
	styling?: string;        // tailwind, css, styled-components
	database?: string;       // postgres, supabase, mongodb
	auth?: string;           // clerk, supabase, custom
	deployment?: string;     // vercel, docker, aws
}

export interface InfrastructureNeeds {
	/** User said they need auth (login, signup, etc.) */
	needsAuth: boolean;
	authReason?: string;
	/** User said they need a database */
	needsDatabase: boolean;
	databaseReason?: string;
	/** User said they need API endpoints */
	needsAPI: boolean;
	apiReason?: string;
	/** User said they need real-time features */
	needsRealtime: boolean;
	realtimeReason?: string;
}

export type ProjectType =
	| 'frontend-only'    // No backend, just UI
	| 'fullstack'        // Frontend + backend
	| 'api-only'         // Just API, no UI
	| 'static-site'      // Static content
	| 'ai-app'           // LLM/AI focused
	| 'mobile-app'       // React Native/Flutter
	| 'cli-tool'         // Command line
	| 'library';         // npm package

export type PipelineType =
	| 'minimal'          // setup → features → done (3-4 tasks)
	| 'frontend'         // setup → design → features → done (4-6 tasks)
	| 'fullstack'        // setup → design → api → features → tests → done (6-8 tasks)
	| 'ai-app'           // setup → llm-setup → features → done (4-6 tasks)
	| 'api-only';        // setup → api → tests → done (3-5 tasks)

export interface SmartTask {
	id: string;
	title: string;
	description: string;
	skills: string[];
	verification: VerificationCriteria;
	dependsOn: string[];
	phase: number;
}

export interface SmartMission {
	name: string;
	projectType: ProjectType;
	pipelineType: PipelineType;
	tasks: SmartTask[];
	totalTasks: number;
	estimatedComplexity: 'simple' | 'moderate' | 'complex';
}

// =============================================================================
// DETECTION PATTERNS (EXPLICIT ONLY)
// =============================================================================

/**
 * Patterns that EXPLICITLY indicate auth is needed
 * NOT just "user" or "account" mentions
 */
const AUTH_EXPLICIT_PATTERNS = [
	/\b(user\s+)?authentication\b/i,
	/\blogin\s+(page|flow|system|form)\b/i,
	/\bsign\s*up\s+(page|flow|system|form)\b/i,
	/\buser\s+registration\b/i,
	/\bprotected\s+routes?\b/i,
	/\brequires?\s+authentication\b/i,
	/\bmust\s+(be\s+)?authenticated\b/i,
	/\bauth(orization)?\s+required\b/i,
	/\boauth\b/i,
	/\bsso\b/i,
	/\bsession\s+management\b/i,
];

/**
 * Patterns that EXPLICITLY indicate database is needed
 */
const DATABASE_EXPLICIT_PATTERNS = [
	/\bdatabase\s+(schema|design|setup)\b/i,
	/\bdata\s+persist(ence)?\b/i,
	/\bstore\s+(user\s+)?data\b/i,
	/\bsave\s+to\s+database\b/i,
	/\bpostgres(ql)?\b/i,
	/\bmongodb\b/i,
	/\bsupabase\b/i,
	/\bdrizzle\b/i,
	/\bprisma\b/i,
	/\bcrud\s+operations?\b/i,
];

/**
 * Patterns that EXPLICITLY indicate API is needed
 */
const API_EXPLICIT_PATTERNS = [
	/\bapi\s+(endpoint|layer|design)s?\b/i,
	/\brest\s+api\b/i,
	/\bgraphql\b/i,
	/\bbackend\s+api\b/i,
	/\bserver\s+endpoint/i,
	/\bapi\s+routes?\b/i,
];

/**
 * Patterns that indicate this is an observation/problem, not a feature
 */
const OBSERVATION_PATTERNS = [
	/\b(is|are)\s+(scattered|missing|broken|incomplete)\b/i,
	/\bno\s+(current|existing)?\s*(way|method|system)\b/i,
	/\black(s|ing)?\s+of\b/i,
	/\bcurrently\b/i,
	/\bproblem\s+(is|with)\b/i,
	/\bissue\s+(is|with)\b/i,
	/\bpain\s+point/i,
	/\bfrustrat(ed|ing)\b/i,
];

/**
 * Patterns to transform observations into actions
 */
const OBSERVATION_TO_ACTION: Array<{
	match: RegExp;
	transform: (match: RegExpMatchArray, original: string) => string;
}> = [
	{
		match: /no\s+(.+?)\s+(loop|system|integration|way)/i,
		transform: (m) => `Implement ${m[1]} ${m[2]}`
	},
	{
		match: /(.+?)\s+(is|are)\s+scattered/i,
		transform: (m) => `Consolidate ${m[1]} into unified view`
	},
	{
		match: /lack(s|ing)?\s+(of\s+)?(.+)/i,
		transform: (m) => `Add ${m[3]}`
	},
	{
		match: /missing\s+(.+)/i,
		transform: (m) => `Implement ${m[1]}`
	},
	{
		match: /no\s+(feedback|tracking|monitoring)/i,
		transform: (m) => `Add ${m[1]} system`
	},
];

// =============================================================================
// FRAMEWORK DETECTION
// =============================================================================

const FRAMEWORK_PATTERNS: Record<string, RegExp[]> = {
	'sveltekit': [/\bsveltekit\b/i, /\bsvelte\s*kit\b/i, /\bsvelte\b/i],
	'nextjs': [/\bnext\.?js\b/i, /\bnext\s+app\b/i, /\bapp\s+router\b/i],
	'react': [/\breact\b/i, /\breact\.?js\b/i],
	'vue': [/\bvue\.?js?\b/i, /\bnuxt\b/i],
	'express': [/\bexpress\.?js?\b/i],
	'fastify': [/\bfastify\b/i],
};

// =============================================================================
// CORE ANALYSIS FUNCTIONS
// =============================================================================

/**
 * Analyze PRD and extract structured information
 * This is the main entry point
 */
export function analyzeSmartPRD(prdContent: string): SmartPRDAnalysis {
	const lines = prdContent.split('\n');
	const lowerContent = prdContent.toLowerCase();

	// Extract project name from first heading
	const nameMatch = prdContent.match(/^#\s+(.+?)(?:\n|$)/m);
	const projectName = nameMatch
		? nameMatch[1].replace(/product\s*requirements?.*/i, '').trim()
		: 'New Project';

	// Detect tech stack
	const techStack = detectTechStack(prdContent);

	// Detect what infrastructure is EXPLICITLY needed
	const infrastructure = detectInfrastructure(prdContent);

	// Determine project type
	const projectType = determineProjectType(prdContent, techStack, infrastructure);

	// Extract features (not bullet point scraping!)
	const explicitFeatures = extractExplicitFeatures(prdContent, techStack);

	// Determine pipeline
	const pipelineType = determinePipeline(projectType, infrastructure, explicitFeatures.length);

	// Calculate confidence
	const confidence = calculateConfidence(explicitFeatures, infrastructure, techStack);

	return {
		projectName,
		projectType,
		explicitFeatures,
		techStack,
		infrastructure,
		pipelineType,
		confidence
	};
}

/**
 * Detect tech stack from PRD content
 */
function detectTechStack(content: string): TechStack {
	const stack: TechStack = {};
	const lower = content.toLowerCase();

	// Framework detection (prioritize explicit mentions)
	for (const [framework, patterns] of Object.entries(FRAMEWORK_PATTERNS)) {
		if (patterns.some(p => p.test(content))) {
			stack.framework = framework;
			break;
		}
	}

	// Default to SvelteKit if no framework specified (user preference)
	if (!stack.framework && (lower.includes('web app') || lower.includes('webapp'))) {
		stack.framework = 'sveltekit';
	}

	// TypeScript detection
	if (/\btypescript\b/i.test(content) || /\b\.ts\b/.test(content)) {
		stack.language = 'typescript';
	} else {
		stack.language = 'typescript'; // Default
	}

	// Styling detection
	if (/\btailwind/i.test(content)) stack.styling = 'tailwind';
	else if (/\bstyled.components/i.test(content)) stack.styling = 'styled-components';

	// Database detection
	if (/\bsupabase\b/i.test(content)) stack.database = 'supabase';
	else if (/\bpostgres/i.test(content)) stack.database = 'postgres';
	else if (/\bmongodb/i.test(content)) stack.database = 'mongodb';

	// Auth detection
	if (/\bclerk\b/i.test(content)) stack.auth = 'clerk';
	else if (/\bsupabase\s+auth/i.test(content)) stack.auth = 'supabase';
	else if (/\bauth0\b/i.test(content)) stack.auth = 'auth0';

	// Deployment detection
	if (/\bvercel\b/i.test(content)) stack.deployment = 'vercel';
	else if (/\bdocker\b/i.test(content)) stack.deployment = 'docker';

	return stack;
}

/**
 * Detect infrastructure needs - ONLY if explicitly stated
 */
function detectInfrastructure(content: string): InfrastructureNeeds {
	const needs: InfrastructureNeeds = {
		needsAuth: false,
		needsDatabase: false,
		needsAPI: false,
		needsRealtime: false
	};

	// Check for explicit auth needs
	for (const pattern of AUTH_EXPLICIT_PATTERNS) {
		const match = content.match(pattern);
		if (match) {
			needs.needsAuth = true;
			needs.authReason = match[0];
			break;
		}
	}

	// Check for explicit database needs
	for (const pattern of DATABASE_EXPLICIT_PATTERNS) {
		const match = content.match(pattern);
		if (match) {
			needs.needsDatabase = true;
			needs.databaseReason = match[0];
			break;
		}
	}

	// Check for explicit API needs
	for (const pattern of API_EXPLICIT_PATTERNS) {
		const match = content.match(pattern);
		if (match) {
			needs.needsAPI = true;
			needs.apiReason = match[0];
			break;
		}
	}

	// Check for realtime needs
	if (/\brealtime\b/i.test(content) || /\bwebsocket/i.test(content) || /\blive\s+updates?\b/i.test(content)) {
		needs.needsRealtime = true;
		needs.realtimeReason = 'realtime features mentioned';
	}

	return needs;
}

/**
 * Determine project type based on analysis
 */
function determineProjectType(
	content: string,
	techStack: TechStack,
	infra: InfrastructureNeeds
): ProjectType {
	const lower = content.toLowerCase();

	// CLI tool
	if (/\bcli\b/i.test(content) || /\bcommand\s*line/i.test(content)) {
		return 'cli-tool';
	}

	// Library/package
	if (/\blibrary\b/i.test(content) || /\bnpm\s+package/i.test(content)) {
		return 'library';
	}

	// Mobile app
	if (/\breact\s+native\b/i.test(content) || /\bflutter\b/i.test(content) || /\bmobile\s+app\b/i.test(content)) {
		return 'mobile-app';
	}

	// AI app
	if (/\bllm\b/i.test(content) || /\bchatbot\b/i.test(content) || /\brag\b/i.test(content) || /\bai\s+(app|agent)/i.test(content)) {
		return 'ai-app';
	}

	// API only (no frontend mentioned)
	if (infra.needsAPI && !techStack.framework && !/\bfrontend\b/i.test(content) && !/\bui\b/i.test(content)) {
		return 'api-only';
	}

	// Static site
	if (/\bstatic\s+(site|page)/i.test(content) || /\blanding\s+page\b/i.test(content)) {
		if (!infra.needsAuth && !infra.needsDatabase && !infra.needsAPI) {
			return 'static-site';
		}
	}

	// Frontend only (no backend infra needed)
	if (techStack.framework && !infra.needsDatabase && !infra.needsAPI && !infra.needsAuth) {
		return 'frontend-only';
	}

	// Default: fullstack
	return 'fullstack';
}

/**
 * Extract EXPLICIT features from PRD
 * Not every bullet point - only clear feature requests
 */
function extractExplicitFeatures(content: string, techStack: TechStack): ActionableFeature[] {
	const features: ActionableFeature[] = [];
	const lines = content.split('\n');
	const seenTitles = new Set<string>();

	let inFeaturesSection = false;
	let featureId = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		const lowerLine = line.toLowerCase();

		// Detect features/requirements section (supports numbered headings)
		if (/^#{1,3}\s*/.test(line) && /(feature|requirement|user\s*stor|functional\s*spec)/i.test(line)) {
			inFeaturesSection = true;
			continue;
		}

		// Exit features section on new heading
		if (inFeaturesSection && /^#{1,2}\s+(?!feature|requirement)/i.test(line)) {
			inFeaturesSection = false;
		}

		// Only extract from bullet points inside a feature/requirements section, or explicit user stories
		const isBullet = /^[-*•]\s+/.test(line) || /^\d+[.)]\s+/.test(line);
		const isUserStory = /as a .+?, i (want|need|should)/i.test(line);

		if (!(inFeaturesSection && isBullet) && !isUserStory) continue;

		// Get the content
		let rawContent = line.replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, '').trim();

		// Skip too short or too long
		if (rawContent.length < 5 || rawContent.length > 200) continue;

		// Skip if it's an observation, not a feature
		if (isObservation(rawContent)) {
			// Try to transform it into an action
			const transformed = transformObservationToAction(rawContent);
			if (transformed) {
				rawContent = transformed;
			} else {
				continue; // Skip if can't transform
			}
		}

		// Skip generic/meta items
		if (isGenericItem(rawContent)) continue;

		// Make it actionable
		const title = makeActionable(rawContent);

		// Deduplicate
		// Use Unicode letter/number classes so non-ASCII PRDs (CJK, Cyrillic,
		// Arabic, accented Latin) keep distinct feature titles instead of all
		// collapsing to "" and getting deduped down to a single feature.
		const normalizedTitle = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
		if (seenTitles.has(normalizedTitle)) continue;
		seenTitles.add(normalizedTitle);

		// Create feature
		const feature: ActionableFeature = {
			id: `feature-${++featureId}`,
			title,
			description: rawContent,
			verification: generateVerification(title, techStack),
			priority: detectPriority(line, inFeaturesSection),
			skills: matchSkillsToFeature(title),
			complexity: estimateComplexity(title)
		};

		features.push(feature);

		// LIMIT: Max 6 features per mission to ensure completion
		if (features.length >= 6) break;
	}

	return features;
}

/**
 * Check if text is an observation rather than a feature request
 */
function isObservation(text: string): boolean {
	return OBSERVATION_PATTERNS.some(p => p.test(text));
}

/**
 * Transform an observation into an actionable task
 */
function transformObservationToAction(text: string): string | null {
	for (const { match, transform } of OBSERVATION_TO_ACTION) {
		const m = text.match(match);
		if (m) {
			return transform(m, text);
		}
	}
	return null;
}

/**
 * Check if text is too generic to be a feature
 */
function isGenericItem(text: string): boolean {
	const patterns = [
		/^(the|a|an|this|that)\s/i,
		/^(note|warning|important|todo|tip)/i,
		/^(click|tap|press|select|choose)/i,
		/^(go to|navigate|visit|see|view)/i,
		/^(make sure|ensure|verify|remember)/i,
		/^(example|sample|tutorial)/i,
		/^[\[\](){}]/,
	];
	return patterns.some(p => p.test(text));
}

/**
 * Make a feature title actionable (start with verb)
 */
function makeActionable(text: string): string {
	// Already starts with action verb
	const actionVerbs = ['implement', 'create', 'build', 'add', 'design', 'develop', 'set up', 'configure'];
	if (actionVerbs.some(v => text.toLowerCase().startsWith(v))) {
		return text.charAt(0).toUpperCase() + text.slice(1);
	}

	// Normalize requirement-style phrasing
	if (/^user\s+can\s+/i.test(text)) {
		return `Implement ${text.replace(/^user\s+can\s+/i, '').trim()}`;
	}
	if (/^system\s+(accepts|returns|uses|must|should)\s+/i.test(text)) {
		return `Implement ${text.replace(/^system\s+/i, '').trim()}`;
	}

	// Add appropriate verb
	if (/\bpage\b/i.test(text) || /\bui\b/i.test(text) || /\bcomponent/i.test(text)) {
		return `Create ${text}`;
	}
	if (/\bapi\b/i.test(text) || /\bendpoint/i.test(text)) {
		return `Build ${text}`;
	}
	if (/\bintegration/i.test(text)) {
		return `Set up ${text}`;
	}

	return `Implement ${text}`;
}

/**
 * Generate verification criteria for a feature
 */
function generateVerification(title: string, techStack: TechStack): VerificationCriteria {
	const criteria: string[] = [];
	const files: string[] = [];
	const commands: string[] = [];

	const lowerTitle = title.toLowerCase();

	// Page/route features
	if (/\bpage\b/i.test(title) || /\broute\b/i.test(title)) {
		const pageName = title.match(/(\w+)\s+page/i)?.[1]?.toLowerCase() || 'page';
		if (techStack.framework === 'sveltekit') {
			files.push(`src/routes/${pageName}/+page.svelte`);
		} else if (techStack.framework === 'nextjs') {
			files.push(`app/${pageName}/page.tsx`);
		}
		criteria.push('Page renders without errors');
		criteria.push('Navigation to page works');
	}

	// Component features
	if (/\bcomponent\b/i.test(title)) {
		criteria.push('Component renders correctly');
		criteria.push('No TypeScript errors');
	}

	// API features
	if (/\bapi\b/i.test(title) || /\bendpoint\b/i.test(title)) {
		criteria.push('Endpoint returns expected response');
		criteria.push('Error handling works');
		commands.push('npm run test:api');
	}

	// Default criteria
	if (criteria.length === 0) {
		criteria.push('Feature works as described');
		criteria.push('No console errors');
	}

	// Always check for TypeScript errors
	commands.push('npm run check');

	return { files, commands, criteria };
}

/**
 * Detect priority from text
 */
function detectPriority(text: string, inFeaturesSection: boolean): 'critical' | 'important' | 'nice-to-have' {
	const lower = text.toLowerCase();

	if (/\bmust\b/i.test(text) || /\bcritical\b/i.test(text) || /\brequired\b/i.test(text)) {
		return 'critical';
	}
	if (/\bshould\b/i.test(text) || /\bimportant\b/i.test(text)) {
		return 'important';
	}
	if (/\bcould\b/i.test(text) || /\bnice\s+to\s+have\b/i.test(text) || /\boptional\b/i.test(text)) {
		return 'nice-to-have';
	}

	// In features section = important by default
	return inFeaturesSection ? 'important' : 'nice-to-have';
}

/**
 * Match skills to a feature
 */
function matchSkillsToFeature(title: string): string[] {
	const skills: string[] = [];
	const lower = title.toLowerCase();

	// UI/Frontend
	if (/\b(page|component|ui|form|dashboard)\b/i.test(title)) {
		skills.push('frontend', 'tailwind-css');
	}

	// API
	if (/\b(api|endpoint)\b/i.test(title)) {
		skills.push('api-designer');
	}

	// Auth
	if (/\b(auth|login|signup)\b/i.test(title)) {
		skills.push('auth-specialist');
	}

	// Database
	if (/\b(database|schema|data)\b/i.test(title)) {
		skills.push('database-architect');
	}

	// Always include TypeScript
	skills.push('typescript-strict');

	// Limit to 3 skills
	return [...new Set(skills)].slice(0, 3);
}

/**
 * Estimate complexity of a feature
 */
function estimateComplexity(title: string): 1 | 2 | 3 {
	const lower = title.toLowerCase();

	// Complex
	if (/\b(system|integration|authentication|payment)\b/i.test(title)) {
		return 3;
	}

	// Moderate
	if (/\b(api|dashboard|form)\b/i.test(title)) {
		return 2;
	}

	// Simple
	return 1;
}

/**
 * Determine pipeline type
 */
function determinePipeline(
	projectType: ProjectType,
	infra: InfrastructureNeeds,
	featureCount: number
): PipelineType {
	switch (projectType) {
		case 'static-site':
		case 'cli-tool':
		case 'library':
			return 'minimal';

		case 'frontend-only':
			return 'frontend';

		case 'api-only':
			return 'api-only';

		case 'ai-app':
			return 'ai-app';

		case 'fullstack':
		default:
			// If not much infra needed, keep it simple
			if (!infra.needsAuth && !infra.needsDatabase) {
				return 'frontend';
			}
			return 'fullstack';
	}
}

/**
 * Calculate confidence in analysis
 */
function calculateConfidence(
	features: ActionableFeature[],
	infra: InfrastructureNeeds,
	techStack: TechStack
): number {
	let confidence = 0.5; // Base

	// More features = more confident we understood
	if (features.length >= 3) confidence += 0.2;
	if (features.length >= 5) confidence += 0.1;

	// Explicit tech stack = more confident
	if (techStack.framework) confidence += 0.1;
	if (techStack.database) confidence += 0.05;

	// Explicit infra reasons = more confident
	if (infra.authReason) confidence += 0.05;
	if (infra.databaseReason) confidence += 0.05;

	return Math.min(1, confidence);
}

// =============================================================================
// MISSION GENERATION
// =============================================================================

/**
 * Generate a smart mission from PRD analysis.
 * Delivery mode intentionally allows deeper task graphs to reduce scaffold-only outputs.
 */
export function generateSmartMission(analysis: SmartPRDAnalysis): SmartMission {
	const tasks: SmartTask[] = [];
	let taskId = 0;
	const maxTasks = Math.min(20, Math.max(10, analysis.explicitFeatures.length + 6));

	// Phase 1: Setup (always, but minimal)
	tasks.push({
		id: `task-${++taskId}`,
		title: 'Project Setup',
		description: `Initialize ${analysis.projectName} with ${analysis.techStack.framework || 'SvelteKit'} and ${analysis.techStack.language || 'TypeScript'}`,
		skills: ['typescript-strict', 'git-workflow'],
		verification: {
			files: ['package.json', 'tsconfig.json'],
			commands: ['npm install', 'npm run check'],
			criteria: ['Project initializes without errors', 'TypeScript compiles']
		},
		dependsOn: [],
		phase: 1
	});

	// Phase 2: Design (only if frontend)
	if (['frontend-only', 'fullstack', 'frontend', 'ai-app'].includes(analysis.pipelineType)) {
		tasks.push({
			id: `task-${++taskId}`,
			title: 'Design System Setup',
			description: 'Set up Tailwind CSS, create color tokens and base components',
			skills: ['design-systems', 'tailwind-css'],
			verification: {
				files: ['tailwind.config.js', 'src/app.css'],
				commands: ['npm run build'],
				criteria: ['Tailwind compiles', 'Base styles work']
			},
			dependsOn: [`task-${taskId - 1}`],
			phase: 2
		});
	}

	// Phase 2b: Infrastructure (ONLY IF EXPLICITLY NEEDED)
	if (analysis.infrastructure.needsDatabase) {
		tasks.push({
			id: `task-${++taskId}`,
			title: 'Database Setup',
			description: `Set up ${analysis.techStack.database || 'database'} schema. Reason: ${analysis.infrastructure.databaseReason}`,
			skills: ['database-architect', analysis.techStack.database === 'postgres' ? 'postgres-wizard' : 'database-schema-design'],
			verification: {
				commands: ['npm run db:push'],
				criteria: ['Schema created', 'Migrations run']
			},
			dependsOn: [`task-1`],
			phase: 2
		});
	}

	if (analysis.infrastructure.needsAuth) {
		tasks.push({
			id: `task-${++taskId}`,
			title: 'Authentication Setup',
			description: `Set up ${analysis.techStack.auth || 'authentication'}. Reason: ${analysis.infrastructure.authReason}`,
			skills: ['auth-specialist', analysis.techStack.auth || 'authentication-oauth'],
			verification: {
				criteria: ['Login flow works', 'Protected routes redirect']
			},
			dependsOn: analysis.infrastructure.needsDatabase ? [`task-${taskId - 1}`] : [`task-1`],
			phase: 2
		});
	}

	// Phase 3: Features (the main work)
	const lastInfraTask = `task-${taskId}`;

	for (const feature of analysis.explicitFeatures) {
		// Dynamic task budget for fuller delivery
		if (tasks.length >= maxTasks - 2) break;

		tasks.push({
			id: `task-${++taskId}`,
			title: feature.title,
			description: feature.description,
			skills: feature.skills,
			verification: feature.verification,
			dependsOn: [lastInfraTask],
			phase: 3
		});
	}

	// Phase 4: Validation and hardening (if room in budget)
	if (tasks.length < maxTasks) {
		tasks.push({
			id: `task-${++taskId}`,
			title: 'Integration Test Coverage',
			description: 'Add API/flow integration tests for core PRD features',
			skills: ['test-architect', 'code-quality'],
			verification: {
				commands: ['npm test'],
				criteria: ['Core flows covered by tests', 'Tests pass consistently']
			},
			dependsOn: [`task-${taskId - 1}`],
			phase: 4
		});
	}

	if (tasks.length < maxTasks) {
		tasks.push({
			id: `task-${++taskId}`,
			title: 'Final Verification',
			description: 'Run all checks, ensure everything works together',
			skills: ['test-architect', 'code-quality'],
			verification: {
				commands: ['npm run check', 'npm run build'],
				criteria: ['No TypeScript errors', 'Build succeeds', 'App runs locally']
			},
			dependsOn: [`task-${taskId - 1}`],
			phase: 4
		});
	}

	// Determine complexity
	let complexity: SmartMission['estimatedComplexity'] = 'simple';
	if (tasks.length > 5) complexity = 'moderate';
	if (tasks.length > 7 || analysis.infrastructure.needsAuth) complexity = 'complex';

	return {
		name: analysis.projectName,
		projectType: analysis.projectType,
		pipelineType: analysis.pipelineType,
		tasks,
		totalTasks: tasks.length,
		estimatedComplexity: complexity
	};
}

/**
 * Convert smart mission to workflow format for canvas
 * Compatible with existing canvas system
 */
export function smartMissionToWorkflow(
	mission: SmartMission,
	availableSkills: Skill[]
): { nodes: { skill: Skill; position: { x: number; y: number } }[]; connections: { sourceIndex: number; targetIndex: number }[] } {
	const nodes: { skill: Skill; position: { x: number; y: number } }[] = [];
	const connections: { sourceIndex: number; targetIndex: number }[] = [];
	const taskIndexMap = new Map<string, number>();

	// Position constants
	const START_X = 100;
	const START_Y = 100;
	const NODE_WIDTH = 220;
	const NODE_HEIGHT = 100;
	const GAP_X = 120;
	const GAP_Y = 60;

	// Group by phase
	const tasksByPhase = new Map<number, SmartTask[]>();
	for (const task of mission.tasks) {
		if (!tasksByPhase.has(task.phase)) {
			tasksByPhase.set(task.phase, []);
		}
		tasksByPhase.get(task.phase)!.push(task);
	}

	let nodeIndex = 0;
	const phases = [...tasksByPhase.keys()].sort();

	for (const phase of phases) {
		const phaseTasks = tasksByPhase.get(phase)!;
		const phaseX = START_X + (phase - 1) * (NODE_WIDTH + GAP_X);

		for (let i = 0; i < phaseTasks.length; i++) {
			const task = phaseTasks[i];
			const phaseY = START_Y + i * (NODE_HEIGHT + GAP_Y);

			// Always create a TASK-shaped node: task.title as primary label,
			// task.skills rendered as badges beneath via skillChain.
			// Inherit category from the first matching skill so coloring still works.
			const firstSkill = availableSkills.find(s => s.id === task.skills[0]);

			const skill: Skill = {
				id: task.id,
				name: task.title,
				description: task.description,
				category: firstSkill?.category || ('development' as SkillCategory),
				tier: 'free' as const,
				tags: task.skills,
				triggers: [],
				skillChain: task.skills
			};

			taskIndexMap.set(task.id, nodeIndex);
			nodes.push({
				skill,
				position: { x: phaseX, y: phaseY }
			});
			nodeIndex++;
		}
	}

	// Create connections based on dependencies
	for (const task of mission.tasks) {
		const targetIndex = taskIndexMap.get(task.id);
		if (targetIndex === undefined) continue;

		for (const depId of task.dependsOn) {
			const sourceIndex = taskIndexMap.get(depId);
			if (sourceIndex !== undefined) {
				connections.push({ sourceIndex, targetIndex });
			}
		}
	}

	return { nodes, connections };
}

/**
 * Full pipeline: PRD → Analysis → Mission → Workflow
 * This is the main entry point for the new smart system
 */
export function processSmartPRD(
	prdContent: string,
	availableSkills: Skill[]
): {
	analysis: SmartPRDAnalysis;
	mission: SmartMission;
	workflow: ReturnType<typeof smartMissionToWorkflow>;
	prompt: string;
} {
	const analysis = analyzeSmartPRD(prdContent);
	const mission = generateSmartMission(analysis);
	const workflow = smartMissionToWorkflow(mission, availableSkills);
	const prompt = generateSmartPrompt(mission, analysis);

	return { analysis, mission, workflow, prompt };
}

/**
 * Generate execution prompt for Claude Code
 * This is what gets copy-pasted
 */
export function generateSmartPrompt(mission: SmartMission, analysis: SmartPRDAnalysis): string {
	const taskList = mission.tasks.map((t, i) => {
		const deps = t.dependsOn.length > 0 ? ` (after: ${t.dependsOn.join(', ')})` : '';
		const skills = t.skills.length > 0 ? `\n   **Skills**: ${t.skills.join(', ')}` : '';
		const verification = t.verification.criteria.map(c => `\n   - [ ] ${c}`).join('');

		return `### ${i + 1}. ${t.title}${deps}
${t.description}
${skills}

**Done when:**${verification}`;
	}).join('\n\n');

	// Collect all skills
	const allSkills = [...new Set(mission.tasks.flatMap(t => t.skills))];

	return `# Mission: ${mission.name}

## Overview
- **Type**: ${mission.projectType}
- **Pipeline**: ${mission.pipelineType}
- **Tasks**: ${mission.totalTasks}
- **Complexity**: ${mission.estimatedComplexity}

## Tech Stack
- Framework: ${analysis.techStack.framework || 'SvelteKit (default)'}
- Language: ${analysis.techStack.language || 'TypeScript'}
${analysis.techStack.styling ? `- Styling: ${analysis.techStack.styling}` : ''}
${analysis.techStack.database ? `- Database: ${analysis.techStack.database}` : ''}
${analysis.techStack.auth ? `- Auth: ${analysis.techStack.auth}` : ''}

## Infrastructure Needed
${analysis.infrastructure.needsAuth ? `- [x] Auth: ${analysis.infrastructure.authReason}` : '- [ ] Auth: Not needed'}
${analysis.infrastructure.needsDatabase ? `- [x] Database: ${analysis.infrastructure.databaseReason}` : '- [ ] Database: Not needed'}
${analysis.infrastructure.needsAPI ? `- [x] API: ${analysis.infrastructure.apiReason}` : '- [ ] API: Not needed'}

## H70 Skills to Load
${allSkills.map(s => `- \`${s}\``).join('\n')}

**Load each skill before starting its task:**
\`\`\`
Read: C:/Users/USER/Desktop/vibeship-h70/skill-lab/<skill-id>/skill.yaml
\`\`\`

---

## Tasks

${taskList}

---

## Completion Protocol

1. **Complete ALL ${mission.totalTasks} tasks** - no skipping
2. **Auto-continue through tasks** until full mission completion (do not pause for confirmation between tasks)
3. **Check all "Done when" criteria** are satisfied per task before moving on
4. **Report blockers** immediately if truly blocked, otherwise keep executing

### Per-task Definition of Done (mandatory):
- Load any listed H70 skills for the task before implementation
- Implement the task deliverable in code
- Verify acceptance criteria for the task
- Run relevant checks/tests for that task
- Commit focused changes with a clear message
- Continue automatically to the next task

### After EACH task:
- Run \`npm run check\` to verify no TypeScript errors
- Run task-relevant tests (at minimum targeted validation)
- Move to next task only when current task DoD is satisfied

### At the END:
- All ${mission.totalTasks} tasks complete
- \`npm run build\` succeeds
- App runs locally without errors
- Final summary includes completed tasks, test evidence, and remaining risks

---

**START with Task 1. Load its skills first and continue until fully done.**`;
}
