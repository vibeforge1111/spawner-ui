import { logger } from '$lib/utils/logger';
/**
 * PRD Analyzer
 *
 * Analyzes a Product Requirements Document and automatically generates
 * implementation tasks that can be converted to canvas workflow nodes.
 *
 * SEMANTIC MATCHING: Uses TF-IDF-like scoring to identify the most relevant
 * features and skills. Different PRDs generate different workflows.
 *
 * LIMITS: Max 25 feature tasks to keep workflows manageable.
 */

import type { Skill, SkillCategory } from '$lib/stores/skills.svelte';
import { KEYWORD_TO_SKILLS } from '$lib/services/h70-skill-matcher';

/**
 * Skill specificity scores (0-1)
 * Higher = more specialized, should be preferred for specific tasks
 * Lower = more general, use when no specialist available
 */
const SKILL_SPECIFICITY: Record<string, { owns: string[]; specificity: number }> = {
	// Very specific skills (0.9+)
	'drizzle-orm': { owns: ['drizzle', 'drizzle schema', 'drizzle queries'], specificity: 0.95 },
	'nextjs-supabase-auth': { owns: ['supabase auth', 'supabase session'], specificity: 0.95 },
	'postgres-wizard': { owns: ['postgresql', 'pg functions', 'pg performance'], specificity: 0.9 },
	'authentication-oauth': { owns: ['oauth', 'oauth2', 'oidc', 'sso', 'jwt'], specificity: 0.9 },
	'stripe-integration': { owns: ['stripe', 'payment intent', 'checkout'], specificity: 0.9 },
	'rag-engineer': { owns: ['rag', 'embeddings', 'vector search', 'chunking'], specificity: 0.9 },
	'vercel-deployment': { owns: ['vercel', 'edge functions'], specificity: 0.9 },
	'expo': { owns: ['expo', 'eas', 'expo router'], specificity: 0.9 },
	'prompt-engineer': { owns: ['prompt', 'few-shot', 'chain of thought'], specificity: 0.9 },

	// Specialized skills (0.8-0.89)
	'design-systems': { owns: ['design tokens', 'component library', 'theming'], specificity: 0.85 },
	'tailwind-css': { owns: ['tailwind', 'utility classes'], specificity: 0.85 },
	'graphql-architect': { owns: ['graphql', 'resolvers', 'apollo', 'urql'], specificity: 0.85 },
	'nextjs-app-router': { owns: ['app router', 'server components', 'next routing'], specificity: 0.85 },
	'ai-agents-architect': { owns: ['agent', 'tool calling', 'multi-agent'], specificity: 0.85 },
	'docker': { owns: ['dockerfile', 'docker compose', 'container'], specificity: 0.85 },
	'testing-automation': { owns: ['e2e', 'playwright', 'cypress'], specificity: 0.8 },
	'ci-cd-pipeline': { owns: ['github actions', 'pipeline', 'ci/cd'], specificity: 0.8 },
	'auth-specialist': { owns: ['authentication', 'login', 'signup', 'mfa', 'rbac'], specificity: 0.8 },
	'realtime-engineer': { owns: ['websocket', 'real-time', 'live updates'], specificity: 0.8 },
	'security-hardening': { owns: ['security headers', 'csp', 'rate limiting'], specificity: 0.8 },
	'react-native-specialist': { owns: ['react native', 'native modules'], specificity: 0.8 },
	'ecommerce-architect': { owns: ['cart', 'checkout', 'inventory', 'orders'], specificity: 0.8 },
	'storage': { owns: ['s3', 'r2', 'blob storage', 'file storage'], specificity: 0.8 },
	'performance-hunter': { owns: ['bundle', 'lazy loading', 'lighthouse'], specificity: 0.8 },

	// Moderate specialists (0.7-0.79)
	'llm-architect': { owns: ['llm', 'prompt design', 'token optimization'], specificity: 0.75 },
	'react-patterns': { owns: ['react hooks', 'react context', 'custom hooks'], specificity: 0.75 },
	'test-architect': { owns: ['test strategy', 'test pyramid', 'coverage'], specificity: 0.7 },
	'api-designer': { owns: ['api design', 'rest', 'endpoint'], specificity: 0.7 },
	'typescript-strict': { owns: ['typescript', 'types', 'generics'], specificity: 0.7 },
	'game-development': { owns: ['game loop', 'sprites', 'physics'], specificity: 0.7 },
	'analytics': { owns: ['tracking', 'funnels', 'metrics'], specificity: 0.7 },
	'git-workflow': { owns: ['branching', 'commits', 'pull requests'], specificity: 0.7 },

	// Generalists (0.5-0.69)
	'database-architect': { owns: ['schema', 'data model', 'migrations'], specificity: 0.6 },
	'frontend': { owns: ['components', 'ui', 'client'], specificity: 0.5 },
	'backend': { owns: ['server', 'api', 'business logic'], specificity: 0.5 },
	'code-quality': { owns: ['code review', 'linting', 'best practices'], specificity: 0.5 },
};

// Valid skill categories for type validation
const VALID_CATEGORIES: SkillCategory[] = [
	'development', 'frameworks', 'integrations', 'ai-ml', 'agents',
	'data', 'design', 'marketing', 'strategy', 'enterprise',
	'finance', 'legal', 'science', 'startup'
];

function isValidCategory(cat: string): cat is SkillCategory {
	return VALID_CATEGORIES.includes(cat as SkillCategory);
}

// Maximum tasks to generate (infrastructure + features + deployment)
const MAX_FEATURE_TASKS = 20;
const MAX_TOTAL_TASKS = 30;

export interface PRDAnalysis {
	projectName: string;
	projectType: 'saas' | 'webapp' | 'mobile' | 'api' | 'cli' | 'library' | 'general';
	features: ExtractedFeature[];
	techHints: string[];
	constraints: string[];
	suggestedStack: SuggestedStack;
	/** Detected domain packs (fintech, gaming, ai-ml, blockchain, etc.) */
	detectedDomains?: string[];
	/** Domain-specific skills to include */
	domainSkills?: string[];
}

export interface ExtractedFeature {
	name: string;
	description: string;
	priority: 'must-have' | 'should-have' | 'nice-to-have';
	category: string;
}

export interface SuggestedStack {
	frontend?: string[];
	backend?: string[];
	database?: string[];
	auth?: string[];
	payments?: string[];
	deployment?: string[];
}

export interface GeneratedTask {
	id: string;
	title: string;
	description: string;
	skillMatch: string | null;
	category: string;
	phase: number;
	dependsOn: string[];
	/** If this is a complex feature, the skill chain to execute in order */
	skillChain?: string[];
	/** Human-readable description of the chain */
	chainDescription?: string;
}

// Keywords that indicate different project types
const PROJECT_TYPE_KEYWORDS: Record<string, string[]> = {
	saas: ['saas', 'subscription', 'tenant', 'billing', 'dashboard', 'admin panel', 'user management'],
	webapp: ['web app', 'website', 'landing page', 'spa', 'single page'],
	mobile: ['mobile', 'ios', 'android', 'react native', 'flutter', 'app store'],
	api: ['api', 'rest', 'graphql', 'endpoint', 'microservice', 'backend only'],
	cli: ['cli', 'command line', 'terminal', 'script'],
	library: ['library', 'package', 'npm', 'sdk', 'framework']
};

// Feature keywords to categories (expanded for better detection)
const FEATURE_CATEGORIES: Record<string, string[]> = {
	auth: ['auth', 'login', 'signup', 'register', 'password', 'oauth', 'sso', 'jwt', 'session', 'user', 'account', 'permission', 'role'],
	payments: ['payment', 'stripe', 'billing', 'subscription', 'checkout', 'cart', 'pricing', 'invoice', 'refund', 'transaction'],
	database: ['database', 'storage', 'crud', 'data', 'schema', 'model', 'entity', 'postgres', 'mysql', 'mongodb', 'supabase', 'orm'],
	frontend: ['ui', 'interface', 'component', 'page', 'view', 'form', 'layout', 'design', 'responsive', 'mobile-first', 'tailwind'],
	backend: ['api', 'endpoint', 'server', 'route', 'controller', 'service', 'rest', 'graphql', 'microservice'],
	realtime: ['realtime', 'websocket', 'live', 'notification', 'push', 'chat', 'messaging', 'sync', 'streaming'],
	search: ['search', 'filter', 'query', 'elasticsearch', 'algolia', 'full-text', 'fuzzy'],
	analytics: ['analytics', 'tracking', 'metrics', 'dashboard', 'report', 'insight', 'visualization', 'chart'],
	email: ['email', 'notification', 'smtp', 'sendgrid', 'mailgun', 'newsletter', 'template'],
	file: ['file', 'upload', 'storage', 's3', 'image', 'media', 'video', 'document', 'pdf'],
	ai: ['ai', 'ml', 'machine learning', 'llm', 'gpt', 'claude', 'openai', 'anthropic', 'embedding', 'vector', 'rag', 'agent', 'chatbot'],
	testing: ['test', 'testing', 'unit test', 'e2e', 'integration', 'qa', 'cypress', 'playwright', 'vitest', 'jest'],
	deployment: ['deploy', 'ci/cd', 'docker', 'kubernetes', 'vercel', 'aws', 'gcp', 'azure', 'pipeline', 'infrastructure'],
	security: ['security', 'secure', 'encrypt', 'https', 'cors', 'csrf', 'xss', 'audit', 'vulnerability', 'owasp'],
	performance: ['performance', 'speed', 'optimize', 'cache', 'cdn', 'lazy', 'prefetch', 'bundle'],
	mobile: ['mobile', 'ios', 'android', 'react native', 'flutter', 'expo', 'app store', 'responsive'],
	blockchain: ['blockchain', 'web3', 'crypto', 'nft', 'smart contract', 'wallet', 'ethereum', 'solana', 'defi'],
	ecommerce: ['ecommerce', 'e-commerce', 'shop', 'store', 'product', 'inventory', 'order', 'shipping'],
	community: ['community', 'forum', 'social', 'follow', 'like', 'comment', 'feed', 'discord', 'slack'],
	marketing: ['marketing', 'seo', 'landing', 'conversion', 'growth', 'campaign', 'funnel']
};

// Skill mappings for different feature categories (expanded with H70 skills)
const CATEGORY_TO_SKILLS: Record<string, string[]> = {
	auth: ['auth-specialist', 'authentication-oauth', 'nextjs-supabase-auth', 'clerk-auth', 'supabase-security'],
	payments: ['stripe-integration', 'subscription-billing', 'fintech-integration', 'derivatives-pricing'],
	database: ['database-architect', 'database-schema-design', 'postgres-wizard', 'drizzle-orm', 'prisma'],
	frontend: ['frontend', 'react-patterns', 'nextjs-app-router', 'sveltekit', 'tailwind-css', 'design-systems'],
	backend: ['backend', 'api-designer', 'api-design', 'go-services', 'graphql-architect'],
	realtime: ['realtime-engineer', 'websocket-realtime', 'websockets-realtime'],
	search: ['elasticsearch', 'search-engineer', 'semantic-search'],
	analytics: ['analytics', 'analytics-architecture', 'product-analytics-engineering', 'data-pipeline'],
	email: ['email-specialist', 'notification-systems'],
	file: ['file-upload', 'storage', 'media-processing', 'cloudflare-r2'],
	ai: ['llm-architect', 'ai-agents-architect', 'prompt-engineer', 'rag-engineer', 'multi-agent-orchestration'],
	testing: ['test-architect', 'testing-automation', 'qa-engineering', 'browser-automation'],
	deployment: ['ci-cd-pipeline', 'cicd-pipelines', 'vercel-deployment', 'docker', 'kubernetes'],
	security: ['security', 'security-hardening', 'security-owasp', 'llm-security-audit'],
	performance: ['performance-hunter', 'performance-optimization', 'caching-specialist'],
	mobile: ['react-native-specialist', 'expo', 'ios-swift-specialist', 'flutter-mobile'],
	blockchain: ['blockchain-defi', 'smart-contract-engineer', 'nft-engineer'],
	ecommerce: ['ecommerce-architect', 'inventory-management'],
	community: ['community-building', 'discord-bot-architect'],
	marketing: ['marketing', 'growth-strategy', 'seo'],
	general: ['typescript-strict', 'code-quality', 'git-workflow']
};

/**
 * Domain packs - specialized skill sets for specific industries/domains
 * Activated when PRD contains 2+ trigger keywords for a domain
 */
const DOMAIN_PACKS: Record<string, { triggers: string[]; skills: string[] }> = {
	fintech: {
		triggers: ['payment', 'billing', 'subscription', 'invoice', 'trading', 'portfolio', 'banking', 'fintech', 'financial'],
		skills: ['stripe-integration', 'subscription-billing', 'fintech-integration', 'derivatives-pricing', 'portfolio-optimization', 'algorithmic-trading']
	},
	gaming: {
		triggers: ['game', 'multiplayer', 'unity', 'godot', 'phaser', 'player', 'score', 'level', 'leaderboard', 'match'],
		skills: ['game-development', 'game-networking', 'game-dev-unity', 'game-dev-godot', 'phaser-game']
	},
	'ai-ml': {
		triggers: ['llm', 'ai', 'ml', 'gpt', 'claude', 'embedding', 'vector', 'rag', 'agent', 'chatbot', 'prompt', 'neural', 'model'],
		skills: ['llm-architect', 'rag-engineer', 'ai-agents-architect', 'prompt-engineer', 'llm-fine-tuning', 'model-optimization', 'computer-vision-deep']
	},
	blockchain: {
		triggers: ['blockchain', 'web3', 'crypto', 'nft', 'smart contract', 'wallet', 'ethereum', 'solana', 'defi', 'token', 'mint'],
		skills: ['smart-contract-engineer', 'nft-engineer', 'blockchain-defi', 'web3-frontend']
	},
	enterprise: {
		triggers: ['compliance', 'audit', 'gdpr', 'hipaa', 'soc2', 'enterprise', 'governance', 'regulatory', 'saas'],
		skills: ['compliance-automation', 'gdpr-privacy', 'enterprise-architecture', 'data-governance']
	},
	mobile: {
		triggers: ['mobile', 'ios', 'android', 'react native', 'flutter', 'expo', 'app store', 'native app'],
		skills: ['react-native-specialist', 'expo', 'ios-swift-specialist', 'flutter-mobile']
	},
	ecommerce: {
		triggers: ['ecommerce', 'shop', 'store', 'product', 'cart', 'checkout', 'inventory', 'order', 'shipping', 'catalog'],
		skills: ['ecommerce-architect', 'stripe-integration', 'inventory-management']
	}
};

/**
 * Skill chains for complex features
 * When a complex feature is detected, it gets decomposed into specialist sequence
 */
const SKILL_CHAINS: Record<string, { patterns: RegExp[]; chain: string[]; description: string }> = {
	ui_feature: {
		patterns: [/ui\s*(feature|component|interface)/i, /design\s+system/i, /component\s+library/i],
		chain: ['design-systems', 'accessibility-specialist', 'frontend', 'testing-automation'],
		description: 'UI feature with design + accessibility + implementation + testing'
	},
	api_endpoint: {
		patterns: [/api\s*(endpoint|route|layer)/i, /rest\s*api/i, /graphql/i],
		chain: ['api-designer', 'database-architect', 'backend', 'testing-automation'],
		description: 'API with design + schema + implementation + testing'
	},
	auth_system: {
		patterns: [/auth(entication)?\s*system/i, /login\s*(flow|system)/i, /user\s*auth/i, /oauth/i, /sso/i],
		chain: ['auth-specialist', 'database-architect', 'security-hardening', 'testing-automation'],
		description: 'Auth with specialist + schema + security + testing'
	},
	payment_flow: {
		patterns: [/payment\s*(flow|system)/i, /checkout/i, /billing\s*system/i, /subscription/i],
		chain: ['stripe-integration', 'backend', 'frontend', 'testing-automation'],
		description: 'Payments with Stripe + backend + frontend + testing'
	},
	ai_feature: {
		patterns: [/ai\s*(feature|chat|assistant)/i, /llm/i, /chatbot/i, /rag/i, /agent/i],
		chain: ['llm-architect', 'prompt-engineer', 'backend', 'frontend'],
		description: 'AI with architect + prompts + backend + frontend'
	},
	realtime_feature: {
		patterns: [/realtime/i, /live\s+updates?/i, /websocket/i, /notifications?/i],
		chain: ['realtime-engineer', 'backend', 'frontend'],
		description: 'Realtime with specialist + backend + frontend'
	}
};

/**
 * Detect if a feature should be decomposed into a skill chain
 * Returns the chain if applicable, null otherwise
 */
function detectSkillChain(featureName: string, category: string): { chain: string[]; description: string } | null {
	const combined = `${featureName} ${category}`.toLowerCase();

	for (const [_chainType, config] of Object.entries(SKILL_CHAINS)) {
		if (config.patterns.some(p => p.test(combined))) {
			return { chain: config.chain, description: config.description };
		}
	}

	return null;
}

/**
 * Detect domains from PRD content (synchronous for KISS)
 */
function detectDomainsFromContent(content: string): { domains: string[]; skills: string[] } {
	const lowerContent = content.toLowerCase();
	const detectedDomains: string[] = [];
	const domainSkills: Set<string> = new Set();

	for (const [domain, pack] of Object.entries(DOMAIN_PACKS)) {
		const matchCount = pack.triggers.filter(t => lowerContent.includes(t)).length;
		// Need at least 2 trigger matches to activate a domain
		if (matchCount >= 2) {
			detectedDomains.push(domain);
			pack.skills.forEach(s => domainSkills.add(s));
		}
	}

	return { domains: detectedDomains, skills: [...domainSkills] };
}

/**
 * Analyze a PRD document and extract key information
 */
export function analyzePRD(prdContent: string): PRDAnalysis {
	const lines = prdContent.toLowerCase();

	// Detect project type
	let projectType: PRDAnalysis['projectType'] = 'general';
	for (const [type, keywords] of Object.entries(PROJECT_TYPE_KEYWORDS)) {
		if (keywords.some(kw => lines.includes(kw))) {
			projectType = type as PRDAnalysis['projectType'];
			break;
		}
	}

	// Extract project name from first heading
	const nameMatch = prdContent.match(/^#\s+(.+?)(?:\n|$)/m);
	const projectName = nameMatch ? nameMatch[1].replace(/product requirements?.*/i, '').trim() : 'New Project';

	// Extract features
	const features = extractFeatures(prdContent);

	// Extract tech hints
	const techHints = extractTechHints(prdContent);

	// Extract constraints
	const constraints = extractConstraints(prdContent);

	// Suggest stack based on features and type
	const suggestedStack = suggestStack(projectType, features, techHints);

	// Detect specialized domains (fintech, gaming, ai-ml, etc.)
	const { domains: detectedDomains, skills: domainSkills } = detectDomainsFromContent(prdContent);

	return {
		projectName: projectName || 'New Project',
		projectType,
		features,
		techHints,
		constraints,
		suggestedStack,
		detectedDomains,
		domainSkills
	};
}

/**
 * Extract features from PRD content with SEMANTIC SCORING
 *
 * SELECTIVE EXTRACTION: Focuses on explicit feature definitions, not every sentence.
 * Uses relevance scoring to identify the most important features.
 *
 * Sources (in priority order):
 * 1. Explicit feature lists (bulleted/numbered in features section)
 * 2. User stories ("As a user, I want...")
 * 3. Category detection from keywords (consolidated, not per-keyword)
 */
function extractFeatures(content: string): ExtractedFeature[] {
	const rawFeatures: Array<ExtractedFeature & { relevanceScore: number }> = [];
	const seenNormalized = new Set<string>(); // Normalized names for dedup
	const lines = content.split('\n');
	const lowerContent = content.toLowerCase();

	let inFeaturesSection = false;
	let sectionBonus = 0; // Features in explicit sections get higher scores

	for (const line of lines) {
		const lowerLine = line.toLowerCase();
		const trimmedLine = line.trim();

		// Detect features/requirements section - items here are more important
		if (/^#{1,3}\s*(features?|requirements?|user\s*stor|functional\s*spec|capabilities)/i.test(trimmedLine)) {
			inFeaturesSection = true;
			sectionBonus = 0.3; // 30% bonus for features in explicit sections
			continue;
		}

		// Detect end of features section
		if (inFeaturesSection && /^#{1,2}\s+(?!feature|requirement)/i.test(trimmedLine)) {
			inFeaturesSection = false;
			sectionBonus = 0;
		}

		// Method 1: Extract bulleted/numbered features (most explicit)
		const bulletMatch = trimmedLine.match(/^[-*•]\s*\*?\*?(.+?)\*?\*?$/);
		const numberedMatch = trimmedLine.match(/^\d+[.)]\s*\*?\*?(.+?)\*?\*?$/);
		const featureMatch = bulletMatch || numberedMatch;

		if (featureMatch) {
			const rawName = featureMatch[1].trim();
			const colonSplit = rawName.split(/[:\-–]/);
			const name = colonSplit[0].trim().replace(/\*\*/g, '');
			const description = colonSplit.slice(1).join(':').trim() || name;
			const normalized = normalizeFeatureName(name);

			// Skip very short or generic items
			if (name.length > 3 && name.length < 100 && !seenNormalized.has(normalized) && !isGenericItem(name)) {
				seenNormalized.add(normalized);
				const feature = createFeatureWithScore(name, description, lowerLine, sectionBonus);
				rawFeatures.push(feature);
			}
		}

		// Method 2: User stories (explicit intent)
		const userStoryMatch = trimmedLine.match(/as a .*?(?:i want|i need|i should be able to)\s+(.+?)(?:so that|$)/i);
		if (userStoryMatch) {
			const name = userStoryMatch[1].trim().replace(/[.,]$/, '');
			const normalized = normalizeFeatureName(name);

			if (name.length > 5 && name.length < 100 && !seenNormalized.has(normalized)) {
				seenNormalized.add(normalized);
				const feature = createFeatureWithScore(name, trimmedLine, lowerLine, 0.2); // User stories get bonus
				rawFeatures.push(feature);
			}
		}
	}

	// Method 3: Category-based feature detection (consolidate by category)
	// Only if we found few explicit features
	if (rawFeatures.length < 5) {
		const detectedCategories = detectCategoriesFromContent(lowerContent);

		for (const { category, score, keywords } of detectedCategories) {
			const featureName = `${capitalize(category)} System`;
			const normalized = normalizeFeatureName(featureName);

			if (!seenNormalized.has(normalized) && score >= 0.3) {
				seenNormalized.add(normalized);
				rawFeatures.push({
					name: featureName,
					description: `Implement ${category} functionality (detected: ${keywords.slice(0, 3).join(', ')})`,
					priority: score >= 0.6 ? 'must-have' : 'should-have',
					category,
					relevanceScore: score
				});
			}
		}
	}

	// Sort by relevance score and limit
	// NOTE: .sort() mutates the input array. Use .toSorted() (ES2023) or `[...arr].sort()` to avoid surprising callers. The function signature doesn't suggest in-place sort.
	rawFeatures.sort((a, b) => b.relevanceScore - a.relevanceScore);

	// Consolidate similar features by category
	const consolidated = consolidateFeatures(rawFeatures);

	// Return top features within limit
	return consolidated.slice(0, MAX_FEATURE_TASKS).map(f => ({
		name: f.name,
		description: f.description,
		priority: f.priority,
		category: f.category
	}));
}

/**
 * Normalize feature name for deduplication
 */
function normalizeFeatureName(name: string): string {
	return name.toLowerCase()
		.replace(/[^a-z0-9\s]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Check if a bullet item is too generic to be a feature
 * Filters: UI instructions, meta-language, non-actionable items
 */
function isGenericItem(name: string): boolean {
	const genericPatterns = [
		// Articles/pronouns
		/^(the|a|an|this|that|it|its)\s/i,
		/^(yes|no|true|false|ok|okay)$/i,
		// Step markers
		/^(step|phase|stage|part)\s*\d/i,
		/^\d+\.\s/i,
		// Notes
		/^(note|warning|important|todo|fixme|tip|hint)/i,
		// UI instructions (not features)
		/^(click|tap|press|button|input|select|choose|enter|type)/i,
		/^(download|upload|drag|drop|scroll|swipe|hover)/i,
		/^(open|close|toggle|expand|collapse|show|hide)/i,
		// Navigation
		/^(go to|navigate|visit|access|find|locate|see|view|look)/i,
		/^(refer to|check out|read more|learn more)/i,
		// Meta instructions
		/^(make sure|ensure|verify|confirm|remember to)/i,
		/^(don't forget|be sure to|you (can|should|must|need))/i,
		// File/save
		/saves?\s+to\s/i,
		// Guide language
		/^(example|sample|tutorial|guide|instruction|how to)/i,
		/^(here('s| is)|below|above|following|previous)/i,
		// Single char/numbers/brackets
		/^[a-z]$/i,
		/^\d+$/,
		/^[\[\](){}]/,
	];
	return genericPatterns.some(p => p.test(name));
}

/**
 * Create feature with semantic relevance score
 */
function createFeatureWithScore(
	name: string,
	description: string,
	contextLine: string,
	bonus: number = 0
): ExtractedFeature & { relevanceScore: number } {
	const feature = createFeature(name, description, contextLine);

	// Calculate relevance score based on:
	// 1. Category specificity (non-general categories score higher)
	// 2. Keyword density in name/description
	// 3. Section bonus (explicit feature sections)
	// 4. Priority (must-have > should-have > nice-to-have)

	let score = 0.5; // Base score

	// Category bonus
	if (feature.category !== 'general') {
		score += 0.2;
	}

	// Priority bonus
	if (feature.priority === 'must-have') {
		score += 0.2;
	} else if (feature.priority === 'nice-to-have') {
		score -= 0.1;
	}

	// Keyword density bonus
	const categoryKeywords = FEATURE_CATEGORIES[feature.category] || [];
	const nameWords = name.toLowerCase().split(/\s+/);
	const keywordMatches = nameWords.filter(w => categoryKeywords.some(kw => kw.includes(w) || w.includes(kw)));
	score += Math.min(0.2, keywordMatches.length * 0.05);

	// Apply section bonus
	score += bonus;

	return { ...feature, relevanceScore: Math.min(1, score) };
}

/**
 * Detect categories from content using TF-IDF-like scoring
 */
function detectCategoriesFromContent(content: string): Array<{ category: string; score: number; keywords: string[] }> {
	const results: Array<{ category: string; score: number; keywords: string[] }> = [];
	const totalWords = content.split(/\s+/).length;

	for (const [category, keywords] of Object.entries(FEATURE_CATEGORIES)) {
		const matchedKeywords: string[] = [];
		let termFrequency = 0;

		for (const keyword of keywords) {
			// Count occurrences (simple TF)
			const regex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
			const matches = content.match(regex);
			if (matches) {
				matchedKeywords.push(keyword);
				termFrequency += matches.length;
			}
		}

		if (matchedKeywords.length > 0) {
			// Score based on:
			// - Number of unique keywords matched (diversity)
			// - Term frequency relative to document size
			// - Inverse document frequency approximation (rarer categories score higher)
			const diversity = matchedKeywords.length / keywords.length;
			const frequency = Math.min(1, termFrequency / (totalWords * 0.01)); // Normalize
			const idf = 1 / Math.log(keywords.length + 1); // Smaller keyword sets are more specific

			const score = (diversity * 0.5) + (frequency * 0.3) + (idf * 0.2);

			results.push({ category, score: Math.min(1, score), keywords: matchedKeywords });
		}
	}

	// Sort by score descending
	return results.sort((a, b) => b.score - a.score);
}

/**
 * Consolidate similar features by category
 */
function consolidateFeatures(
	features: Array<ExtractedFeature & { relevanceScore: number }>
): Array<ExtractedFeature & { relevanceScore: number }> {
	// Group by category
	const byCategory = new Map<string, Array<ExtractedFeature & { relevanceScore: number }>>();

	for (const feature of features) {
		const existing = byCategory.get(feature.category) || [];
		existing.push(feature);
		byCategory.set(feature.category, existing);
	}

	const consolidated: Array<ExtractedFeature & { relevanceScore: number }> = [];

	for (const [category, categoryFeatures] of byCategory) {
		// If category has many features, keep top 3 and merge rest into one
		if (categoryFeatures.length > 3) {
			// Keep top 3 by score
			categoryFeatures.sort((a, b) => b.relevanceScore - a.relevanceScore);
			consolidated.push(...categoryFeatures.slice(0, 3));

			// Merge rest into consolidated feature
			const remaining = categoryFeatures.slice(3);
			if (remaining.length > 0) {
				const mergedNames = remaining.map(f => f.name).slice(0, 3).join(', ');
				consolidated.push({
					name: `Additional ${capitalize(category)} Features`,
					description: `Includes: ${mergedNames}${remaining.length > 3 ? ` and ${remaining.length - 3} more` : ''}`,
					priority: 'should-have',
					category,
					relevanceScore: Math.max(...remaining.map(f => f.relevanceScore)) * 0.8
				});
			}
		} else {
			consolidated.push(...categoryFeatures);
		}
	}

	// Re-sort by score
	return consolidated.sort((a, b) => b.relevanceScore - a.relevanceScore);
}

/**
 * Helper to create a feature with proper category and priority detection
 */
function createFeature(name: string, description: string, contextLine: string): ExtractedFeature {
	// Determine category from keywords
	let category = 'general';
	for (const [cat, keywords] of Object.entries(FEATURE_CATEGORIES)) {
		if (keywords.some(kw => contextLine.includes(kw) || name.toLowerCase().includes(kw))) {
			category = cat;
			break;
		}
	}

	// Determine priority
	let priority: ExtractedFeature['priority'] = 'should-have';
	if (contextLine.includes('must') || contextLine.includes('critical') ||
		contextLine.includes('essential') || contextLine.includes('required') ||
		contextLine.includes('core') || contextLine.includes('mvp')) {
		priority = 'must-have';
	} else if (contextLine.includes('nice') || contextLine.includes('optional') ||
		contextLine.includes('future') || contextLine.includes('phase 2') ||
		contextLine.includes('later') || contextLine.includes('v2')) {
		priority = 'nice-to-have';
	}

	return {
		name: name.replace(/\*\*/g, ''),
		description: description.substring(0, 300),
		priority,
		category
	};
}

/**
 * Capitalize first letter
 */
function capitalize(str: string): string {
	return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Extract technology hints from PRD
 */
function extractTechHints(content: string): string[] {
	const hints: string[] = [];
	const techKeywords = [
		'react', 'vue', 'svelte', 'angular', 'next.js', 'nextjs', 'nuxt',
		'node', 'express', 'fastify', 'nest',
		'python', 'django', 'flask', 'fastapi',
		'postgres', 'mysql', 'mongodb', 'redis', 'supabase', 'firebase',
		'aws', 'gcp', 'azure', 'vercel', 'netlify',
		'docker', 'kubernetes', 'terraform',
		'stripe', 'twilio', 'sendgrid',
		'typescript', 'javascript', 'go', 'rust'
	];

	const lowerContent = content.toLowerCase();
	for (const tech of techKeywords) {
		if (lowerContent.includes(tech)) {
			hints.push(tech);
		}
	}

	return [...new Set(hints)];
}

/**
 * Extract constraints from PRD
 */
function extractConstraints(content: string): string[] {
	const constraints: string[] = [];
	const lines = content.split('\n');

	let inConstraintsSection = false;

	for (const line of lines) {
		const lowerLine = line.toLowerCase();

		if (lowerLine.includes('constraint') || lowerLine.includes('limitation') || lowerLine.includes('requirement')) {
			inConstraintsSection = true;
			continue;
		}

		if (inConstraintsSection && line.startsWith('##')) {
			inConstraintsSection = false;
		}

		if (inConstraintsSection && line.match(/^[\s]*[-*]/)) {
			const constraint = line.replace(/^[\s]*[-*]\s*/, '').trim();
			if (constraint.length > 5) {
				constraints.push(constraint);
			}
		}
	}

	return constraints;
}

/**
 * Suggest a tech stack based on project type and features
 */
function suggestStack(
	projectType: PRDAnalysis['projectType'],
	features: ExtractedFeature[],
	techHints: string[]
): SuggestedStack {
	const stack: SuggestedStack = {};

	// Default suggestions based on project type
	switch (projectType) {
		case 'saas':
		case 'webapp':
			stack.frontend = techHints.includes('svelte') ? ['SvelteKit'] : ['Next.js', 'React'];
			stack.backend = ['Node.js', 'TypeScript'];
			stack.database = techHints.includes('supabase') ? ['Supabase'] : ['PostgreSQL'];
			break;
		case 'mobile':
			stack.frontend = ['React Native'];
			stack.backend = ['Node.js'];
			stack.database = ['Supabase'];
			break;
		case 'api':
			stack.backend = ['Node.js', 'Express'];
			stack.database = ['PostgreSQL'];
			break;
		default:
			stack.frontend = ['Next.js'];
			stack.backend = ['Node.js'];
	}

	// Add auth if needed
	const hasAuth = features.some(f => f.category === 'auth');
	if (hasAuth) {
		stack.auth = techHints.includes('supabase') ? ['Supabase Auth'] : ['NextAuth.js'];
	}

	// Add payments if needed
	const hasPayments = features.some(f => f.category === 'payments');
	if (hasPayments) {
		stack.payments = ['Stripe'];
	}

	// Add deployment
	stack.deployment = ['Vercel', 'Docker'];

	return stack;
}

/**
 * Generate implementation tasks from PRD analysis
 *
 * SEMANTIC GENERATION: Tasks are created based on actual PRD content with
 * relevance scoring. Different PRDs generate different workflows.
 *
 * LIMITS: Max 30 total tasks to keep workflows manageable.
 */
export function generateTasksFromPRD(
	analysis: PRDAnalysis,
	availableSkills: Skill[]
): GeneratedTask[] {
	const tasks: GeneratedTask[] = [];
	let taskId = 0;

	// Log detected domains for debugging
	if (analysis.detectedDomains?.length) {
		logger.info(`[PRDAnalyzer] Detected domains: ${analysis.detectedDomains.join(', ')}`);
		logger.info(`[PRDAnalyzer] Domain skills: ${analysis.domainSkills?.join(', ')}`);
	}

	// Prioritize domain-specific skills by ensuring they're in the available pool
	const domainSkillIds = new Set(analysis.domainSkills || []);
	const enhancedSkills = [...availableSkills];

	// Add placeholder skills for domain skills not in available pool
	// (They'll be matched by ID even if not fully loaded)
	for (const skillId of domainSkillIds) {
		if (!availableSkills.find(s => s.id === skillId)) {
			enhancedSkills.push({
				id: skillId,
				name: skillId.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
				description: `Domain-specific skill: ${skillId}`,
				category: 'development' as const,
				tier: 'free' as const,
				tags: [skillId],
				triggers: []
			});
		}
	}

	// Extract unique categories from features
	const featureCategories = [...new Set(analysis.features.map(f => f.category))];

	// Detect what the PRD actually needs (not hardcoded assumptions)
	const needsFrontend = featureCategories.some(c => ['frontend', 'design', 'mobile', 'ecommerce'].includes(c)) ||
		analysis.projectType === 'webapp' || analysis.projectType === 'saas' || analysis.projectType === 'mobile';
	const needsBackend = featureCategories.some(c => ['backend', 'api', 'database', 'auth', 'realtime'].includes(c)) ||
		analysis.projectType === 'api' || analysis.projectType === 'saas';
	const needsAuth = featureCategories.includes('auth') || analysis.projectType === 'saas';
	const needsDatabase = featureCategories.some(c => ['database', 'ecommerce', 'analytics', 'community'].includes(c)) ||
		analysis.techHints.some(t => ['postgres', 'mysql', 'mongodb', 'supabase', 'firebase'].includes(t));
	const needsDeployment = featureCategories.includes('deployment') ||
		analysis.techHints.some(t => ['docker', 'kubernetes', 'vercel', 'aws', 'gcp', 'azure'].includes(t));
	const needsTesting = featureCategories.includes('testing') ||
		analysis.techHints.some(t => ['jest', 'vitest', 'cypress', 'playwright'].includes(t));

	// Track the last task ID for dependencies
	let lastInfraTaskId = 'task-0';

	// Phase 1: Foundation (only if needed)
	if (analysis.suggestedStack.frontend?.length || analysis.suggestedStack.backend?.length) {
		const stackDesc = [
			analysis.suggestedStack.frontend?.join(', '),
			analysis.suggestedStack.backend?.join(', ')
		].filter(Boolean).join(' + ');

		tasks.push({
			id: `task-${taskId++}`,
			title: 'Project Setup',
			description: `Initialize ${analysis.projectName} with ${stackDesc || 'chosen stack'}`,
			skillMatch: findBestSkillMatchWithScore('project-scaffolding', enhancedSkills),
			category: 'setup',
			phase: 1,
			dependsOn: []
		});
		lastInfraTaskId = `task-${taskId - 1}`;
	}

	// Design System - only if frontend is needed
	if (needsFrontend) {
		tasks.push({
			id: `task-${taskId++}`,
			title: 'Design System',
			description: 'Create design tokens, color palette, and base UI components',
			skillMatch: findBestSkillMatchWithScore('design-system', enhancedSkills),
			category: 'design',
			phase: 1,
			dependsOn: tasks.length > 0 ? [lastInfraTaskId] : []
		});
		lastInfraTaskId = `task-${taskId - 1}`;
	}

	// Phase 2: Core Infrastructure (conditional)
	if (needsAuth) {
		const authStack = analysis.suggestedStack.auth?.join(', ') || 'authentication solution';
		tasks.push({
			id: `task-${taskId++}`,
			title: 'Authentication System',
			description: `Implement user authentication with ${authStack}`,
			skillMatch: findBestSkillMatchWithScore('authentication', enhancedSkills),
			category: 'auth',
			phase: 2,
			dependsOn: tasks.length > 0 ? [lastInfraTaskId] : []
		});
	}

	if (needsDatabase) {
		const dbStack = analysis.suggestedStack.database?.join(', ') || 'database';
		tasks.push({
			id: `task-${taskId++}`,
			title: 'Database Schema',
			description: `Design and implement ${dbStack} schema for all entities`,
			skillMatch: findBestSkillMatchWithScore('database', enhancedSkills),
			category: 'database',
			phase: 2,
			dependsOn: tasks.length > 0 ? [lastInfraTaskId] : []
		});
	}

	if (needsBackend) {
		const apiDeps = tasks.filter(t => t.category === 'database').map(t => t.id);
		tasks.push({
			id: `task-${taskId++}`,
			title: 'API Layer',
			description: 'Create REST/GraphQL API endpoints for all features',
			skillMatch: findBestSkillMatchWithScore('api-design', enhancedSkills),
			category: 'backend',
			phase: 2,
			dependsOn: apiDeps.length > 0 ? apiDeps : (tasks.length > 0 ? [lastInfraTaskId] : [])
		});
	}

	// Update lastInfraTaskId
	if (tasks.length > 0) {
		lastInfraTaskId = tasks[tasks.length - 1].id;
	}

	// Calculate remaining slots for feature tasks
	const infraTasks = tasks.length;
	const reservedSlots = 2; // Testing + Deployment
	const availableFeatureSlots = Math.max(5, MAX_TOTAL_TASKS - infraTasks - reservedSlots);

	// Phase 3: Feature Implementation (with limit)
	// Features are already sorted and consolidated by extractFeatures
	const featuresToAdd = analysis.features.slice(0, availableFeatureSlots);
	const featureTaskIds: string[] = [];

	for (const feature of featuresToAdd) {
		// Check if this feature should be decomposed into a skill chain
		const chain = detectSkillChain(feature.name, feature.category);

		// Find best skill match using semantic scoring with enhanced skill pool
		const skillMatch = findBestSkillForFeature(feature, enhancedSkills);

		const task: GeneratedTask = {
			id: `task-${taskId++}`,
			title: feature.name,
			description: feature.description,
			skillMatch: chain ? chain.chain[0] : skillMatch, // First skill in chain is primary
			category: feature.category,
			phase: 3,
			dependsOn: tasks.length > 0 ? [lastInfraTaskId] : []
		};

		// If skill chain detected, add chain info
		if (chain) {
			task.skillChain = chain.chain;
			task.chainDescription = chain.description;
			logger.info(`[PRDAnalyzer] Chain detected for "${feature.name}": ${chain.chain.join(' → ')}`);
		}

		tasks.push(task);
		featureTaskIds.push(`task-${taskId - 1}`);
	}

	// Phase 4: Quality & Deployment (only if complex enough)
	const isComplexProject = analysis.features.length > 3 || analysis.projectType === 'saas';

	if ((needsTesting || isComplexProject) && tasks.length < MAX_TOTAL_TASKS) {
		const lastFeatureId = featureTaskIds.length > 0 ? featureTaskIds[featureTaskIds.length - 1] : lastInfraTaskId;
		tasks.push({
			id: `task-${taskId++}`,
			title: 'Testing Suite',
			description: 'Write unit, integration, and e2e tests for implemented features',
			skillMatch: findBestSkillMatchWithScore('testing', enhancedSkills),
			category: 'testing',
			phase: 4,
			dependsOn: [lastFeatureId]
		});
	}

	if ((needsDeployment || isComplexProject) && tasks.length < MAX_TOTAL_TASKS) {
		const deployDep = tasks.length > 0 ? tasks[tasks.length - 1].id : 'task-0';
		const deploymentStack = analysis.suggestedStack.deployment?.join(', ') || 'production environment';

		tasks.push({
			id: `task-${taskId++}`,
			title: 'Deployment Setup',
			description: `Configure CI/CD and deploy to ${deploymentStack}`,
			skillMatch: findBestSkillMatchWithScore('deployment', enhancedSkills),
			category: 'deployment',
			phase: 4,
			dependsOn: [deployDep]
		});
	}

	// Fallback for empty PRDs
	if (tasks.length === 0) {
		tasks.push({
			id: 'task-0',
			title: analysis.projectName || 'Implementation',
			description: 'Implement the project requirements',
			skillMatch: findBestSkillMatchWithScore('development', enhancedSkills),
			category: 'general',
			phase: 1,
			dependsOn: []
		});
	}

	return tasks;
}

/**
 * Find best skill for a feature using specificity-aware scoring
 * Prefers specialists over generalists when the feature matches their domain
 */
function findBestSkillForFeature(feature: ExtractedFeature, availableSkills: Skill[]): string | null {
	const featureText = `${feature.name} ${feature.description || ''}`.toLowerCase();
	const availableIds = new Set(availableSkills.map(s => s.id));

	// STEP 1: Check specialists first (highest specificity wins)
	// This ensures "supabase auth" goes to nextjs-supabase-auth (0.95) not auth-specialist (0.8)
	const specialistMatches: Array<{ skillId: string; score: number; specificity: number }> = [];

	for (const [skillId, spec] of Object.entries(SKILL_SPECIFICITY)) {
		if (!availableIds.has(skillId)) continue;

		// Check if any "owns" keyword matches the feature
		let ownershipScore = 0;
		for (const owned of spec.owns) {
			if (featureText.includes(owned)) {
				// Longer matches are more specific
				ownershipScore += owned.length / 10;
			}
		}

		if (ownershipScore > 0) {
			// Combine ownership match with specificity
			const finalScore = ownershipScore * spec.specificity;
			specialistMatches.push({ skillId, score: finalScore, specificity: spec.specificity });
		}
	}

	// Sort by score (ownership * specificity), then by specificity for ties
	specialistMatches.sort((a, b) => {
		if (Math.abs(b.score - a.score) > 0.01) return b.score - a.score;
		return b.specificity - a.specificity;
	});

	if (specialistMatches.length > 0) {
		return specialistMatches[0].skillId;
	}

	// STEP 2: Fall back to category-based matching with specificity weighting
	const categorySkills = CATEGORY_TO_SKILLS[feature.category] || [];
	let bestMatch: { skillId: string; score: number } | null = null;

	for (const skillId of categorySkills) {
		const skill = availableSkills.find(s => s.id === skillId);
		if (skill) {
			const score = calculateSkillRelevance(feature, skill);
			if (!bestMatch || score > bestMatch.score) {
				bestMatch = { skillId, score };
			}
		}
	}

	if (bestMatch && bestMatch.score > 0.3) {
		return bestMatch.skillId;
	}

	// STEP 3: Fallback to name-based matching
	return findBestSkillMatchWithScore(feature.name, availableSkills);
}

/**
 * Calculate semantic relevance between feature and skill
 * Incorporates specificity: specialists score higher than generalists
 */
function calculateSkillRelevance(feature: ExtractedFeature, skill: Skill): number {
	let score = 0.3; // Lower base score (specificity will boost)

	const featureText = `${feature.name} ${feature.description || ''}`.toLowerCase();
	const featureWords = new Set(feature.name.toLowerCase().split(/\s+/));
	const descWords = new Set((feature.description || '').toLowerCase().split(/\s+/));
	const skillWords = new Set([
		...(skill.name || '').toLowerCase().split(/\s+/),
		...(skill.description || '').toLowerCase().split(/\s+/),
		...(skill.tags || []).map(t => t?.toLowerCase()).filter(Boolean)
	]);

	// Word overlap bonus
	let overlapCount = 0;
	for (const word of featureWords) {
		if (word.length > 2 && skillWords.has(word)) overlapCount++;
	}
	for (const word of descWords) {
		if (word.length > 3 && skillWords.has(word)) overlapCount++;
	}
	score += Math.min(0.3, overlapCount * 0.05);

	// Category match bonus
	if (skill.category === feature.category) {
		score += 0.15;
	}

	// Specificity bonus: check if this skill owns any matching keywords
	const spec = SKILL_SPECIFICITY[skill.id];
	if (spec) {
		let ownershipBonus = 0;
		for (const owned of spec.owns) {
			if (featureText.includes(owned)) {
				ownershipBonus += 0.1;
			}
		}
		// Apply specificity multiplier (0.5-0.95)
		score = (score + Math.min(0.3, ownershipBonus)) * (0.5 + spec.specificity * 0.5);
	}

	return Math.min(1, score);
}

/**
 * Find best skill match using semantic scoring (improved version)
 */
function findBestSkillMatchWithScore(searchTerm: string | undefined, availableSkills: Skill[]): string | null {
	if (!searchTerm || !availableSkills || availableSkills.length === 0) return null;

	const lowerSearch = searchTerm.toLowerCase();
	const searchWords = new Set(lowerSearch.split(/\s+/).filter(w => w.length > 2));
	const availableIds = new Set(availableSkills.map(s => s.id));

	// Score all H70 keyword matches
	const scoredMatches: Array<{ skillId: string; score: number }> = [];

	// Check H70 keyword mappings with scoring
	for (const [keyword, skills] of Object.entries(KEYWORD_TO_SKILLS)) {
		// Calculate keyword relevance to search term
		const keywordLower = keyword.toLowerCase();
		let relevance = 0;

		if (lowerSearch === keywordLower) {
			relevance = 1.0; // Exact match
		} else if (lowerSearch.includes(keywordLower)) {
			relevance = 0.7; // Search contains keyword
		} else if (keywordLower.includes(lowerSearch)) {
			relevance = 0.5; // Keyword contains search
		} else {
			// Word overlap
			const keywordWords = new Set(keywordLower.split(/\s+/));
			let overlap = 0;
			for (const word of searchWords) {
				if (keywordWords.has(word)) overlap++;
			}
			relevance = overlap > 0 ? 0.3 * (overlap / Math.max(searchWords.size, keywordWords.size)) : 0;
		}

		if (relevance > 0.1) {
			for (let i = 0; i < skills.length; i++) {
				const skillId = skills[i];
				if (availableIds.has(skillId)) {
					// Earlier in list = higher priority
					const positionBonus = (skills.length - i) / skills.length * 0.2;
					// Add specificity bonus for specialists
					const spec = SKILL_SPECIFICITY[skillId];
					const specificityBonus = spec ? spec.specificity * 0.3 : 0;
					scoredMatches.push({ skillId, score: relevance + positionBonus + specificityBonus });
				}
			}
		}
	}

	// Sort by score and return best match
	if (scoredMatches.length > 0) {
		scoredMatches.sort((a, b) => b.score - a.score);
		return scoredMatches[0].skillId;
	}

	// Fallback to simple matching
	return findBestSkillMatch(searchTerm, availableSkills);
}

/**
 * Find the best matching skill from available skills
 * Uses H70 keyword mappings (391 keywords) for comprehensive matching
 */
function findBestSkillMatch(searchTerm: string | undefined, availableSkills: Skill[]): string | null {
	if (!searchTerm || !availableSkills || availableSkills.length === 0) return null;

	const lowerSearch = searchTerm.toLowerCase();
	const availableIds = new Set(availableSkills.map(s => s.id));

	// PRIMARY: Check H70 keyword mappings first (391 keywords)
	// Try exact keyword match
	const h70Skills = KEYWORD_TO_SKILLS[lowerSearch];
	if (h70Skills) {
		for (const skillId of h70Skills) {
			if (availableIds.has(skillId)) {
				return skillId;
			}
		}
	}

	// Try partial H70 keyword match (search term contains keyword)
	for (const [keyword, skills] of Object.entries(KEYWORD_TO_SKILLS)) {
		if (lowerSearch.includes(keyword) || keyword.includes(lowerSearch)) {
			for (const skillId of skills) {
				if (availableIds.has(skillId)) {
					return skillId;
				}
			}
		}
	}

	// FALLBACK: Try exact ID match
	const exactMatch = availableSkills.find(s => s.id?.toLowerCase() === lowerSearch);
	if (exactMatch) return exactMatch.id;

	// Try partial ID match
	const partialMatch = availableSkills.find(s =>
		s.id?.toLowerCase().includes(lowerSearch) ||
		lowerSearch.includes(s.id?.toLowerCase() || '')
	);
	if (partialMatch) return partialMatch.id;

	// Try name match
	const nameMatch = availableSkills.find(s =>
		s.name?.toLowerCase().includes(lowerSearch) ||
		lowerSearch.includes(s.name?.toLowerCase() || '')
	);
	if (nameMatch) return nameMatch.id;

	// Try tag match - filter out undefined tags
	const tagMatch = availableSkills.find(s =>
		s.tags?.filter(Boolean).some(tag => tag.toLowerCase().includes(lowerSearch))
	);
	if (tagMatch) return tagMatch.id;

	return null;
}

/**
 * Convert generated tasks to workflow format for canvas
 */
export function tasksToWorkflow(
	tasks: GeneratedTask[],
	availableSkills: Skill[]
): { nodes: { skill: Skill; position: { x: number; y: number } }[]; connections: { sourceIndex: number; targetIndex: number }[] } {
	const nodes: { skill: Skill; position: { x: number; y: number } }[] = [];
	const connections: { sourceIndex: number; targetIndex: number }[] = [];
	const taskIndexMap = new Map<string, number>();

	const NODE_WIDTH = 220;
	const NODE_HEIGHT = 80;
	const GAP_X = 100;
	const GAP_Y = 60;
	const START_X = 100;
	const START_Y = 100;
	const MAX_PER_ROW = 4;

	// Layered layout (longest-path depth) — same algorithm as prd-bridge
	const taskById = new Map<string, GeneratedTask>();
	for (const t of tasks) taskById.set(t.id, t);

	const depthCache = new Map<string, number>();
	function depthOf(id: string, stack: Set<string> = new Set()): number {
		if (depthCache.has(id)) return depthCache.get(id)!;
		if (stack.has(id)) return 0;
		const t = taskById.get(id);
		if (!t) return 0;
		stack.add(id);
		let d = 0;
		for (const dep of t.dependsOn || []) {
			if (taskById.has(dep)) d = Math.max(d, depthOf(dep, stack) + 1);
		}
		if ((t.dependsOn?.length ?? 0) === 0 && t.phase && t.phase > 1) {
			d = Math.max(d, t.phase - 1);
		}
		stack.delete(id);
		depthCache.set(id, d);
		return d;
	}

	const byDepth = new Map<number, GeneratedTask[]>();
	for (const task of tasks) {
		const d = depthOf(task.id);
		if (!byDepth.has(d)) byDepth.set(d, []);
		byDepth.get(d)!.push(task);
	}

	let nodeIndex = 0;
	const sortedDepths = [...byDepth.keys()].sort((a, b) => a - b);

	for (const d of sortedDepths) {
		const column = byDepth.get(d)!;
		const subColumns = Math.ceil(column.length / MAX_PER_ROW);
		const colHeight = Math.ceil(column.length / subColumns);

		for (let i = 0; i < column.length; i++) {
			const task = column[i];
			const subCol = Math.floor(i / colHeight);
			const rowInSub = i % colHeight;

			let skill: Skill;
			if (task.skillMatch) {
				const foundSkill = availableSkills.find((s) => s.id === task.skillMatch);
				skill = foundSkill || createPlaceholderSkill(task);
			} else {
				skill = createPlaceholderSkill(task);
			}

			taskIndexMap.set(task.id, nodeIndex);
			nodes.push({
				skill,
				position: {
					x: START_X + (d + subCol) * (NODE_WIDTH + GAP_X),
					y: START_Y + rowInSub * (NODE_HEIGHT + GAP_Y)
				}
			});
			nodeIndex++;
		}
	}

	for (const task of tasks) {
		const targetIndex = taskIndexMap.get(task.id);
		if (targetIndex === undefined) continue;
		for (const depId of task.dependsOn) {
			const sourceIndex = taskIndexMap.get(depId);
			if (sourceIndex !== undefined) {
				connections.push({ sourceIndex, targetIndex });
			}
		}
	}

	if (connections.length === 0 && nodes.length > 1) {
		for (let i = 0; i < nodes.length - 1; i++) {
			connections.push({ sourceIndex: i, targetIndex: i + 1 });
		}
	}

	return { nodes, connections };
}

/**
 * Create a placeholder skill for tasks without matches
 * Includes skill chain data if present
 */
function createPlaceholderSkill(task: GeneratedTask): Skill {
	const rawCategory = task.category || 'development';
	const category: SkillCategory = isValidCategory(rawCategory) ? rawCategory : 'development';
	return {
		id: `generated-${task.id}`,
		name: task.title || 'Untitled Task',
		description: task.description || '',
		category,
		tier: 'free',
		tags: [category].filter(Boolean),
		triggers: [],
		// Include skill chain if this is a complex feature
		skillChain: task.skillChain,
		chainDescription: task.chainDescription
	};
}
