/**
 * Goal Analyzer Service
 *
 * Validates, classifies, and extracts information from user project descriptions.
 */

import type { ValidationResult, AnalyzedGoal, InputType } from '$lib/types/goal';
import { GOAL_VALIDATION } from '$lib/types/goal';

// Stop words to filter out during keyword extraction
const STOP_WORDS = new Set([
	'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
	'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been', 'be', 'have', 'has', 'had',
	'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must',
	'i', 'you', 'he', 'she', 'it', 'we', 'they', 'what', 'which', 'who', 'whom',
	'this', 'that', 'these', 'those', 'am', 'can', 'want', 'need', 'like', 'build',
	'create', 'make', 'get', 'use', 'using', 'something', 'thing', 'stuff', 'just',
	'really', 'very', 'also', 'too', 'so', 'if', 'then', 'else', 'when', 'where',
	'how', 'why', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
	'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'than', 'into'
]);

// Technology detection patterns (keyword → normalized tech name)
const TECH_PATTERNS: Record<string, string[]> = {
	'nextjs': ['next', 'nextjs', 'next.js', 'next js'],
	'react': ['react', 'reactjs', 'react.js'],
	'vue': ['vue', 'vuejs', 'vue.js', 'nuxt', 'nuxtjs'],
	'svelte': ['svelte', 'sveltekit', 'svelte kit'],
	'angular': ['angular', 'angularjs'],
	'node': ['node', 'nodejs', 'node.js', 'express', 'expressjs'],
	'python': ['python', 'django', 'flask', 'fastapi'],
	'supabase': ['supabase'],
	'firebase': ['firebase', 'firestore'],
	'postgres': ['postgres', 'postgresql', 'pg'],
	'mongodb': ['mongo', 'mongodb', 'mongoose'],
	'redis': ['redis', 'caching'],
	'stripe': ['stripe', 'payment', 'payments', 'billing', 'subscription', 'subscriptions'],
	'auth': ['auth', 'authentication', 'login', 'signup', 'sign up', 'sign in', 'oauth', 'sso', 'jwt'],
	'graphql': ['graphql', 'apollo', 'hasura'],
	'rest': ['rest', 'restful', 'api', 'apis', 'endpoint', 'endpoints'],
	'tailwind': ['tailwind', 'tailwindcss'],
	'docker': ['docker', 'container', 'containers', 'kubernetes', 'k8s'],
	'aws': ['aws', 'amazon', 'lambda', 's3', 'ec2', 'dynamodb'],
	'gcp': ['gcp', 'google cloud', 'cloud run', 'bigquery'],
	'vercel': ['vercel', 'deploy', 'deployment'],
	'typescript': ['typescript', 'ts', 'typed'],
	'ai': ['ai', 'ml', 'machine learning', 'llm', 'gpt', 'claude', 'openai', 'anthropic', 'chatbot'],
	'realtime': ['realtime', 'real-time', 'websocket', 'websockets', 'socket', 'live'],
	'mobile': ['mobile', 'ios', 'android', 'react native', 'flutter', 'app'],
	'testing': ['test', 'testing', 'jest', 'vitest', 'cypress', 'playwright'],
	// Game engines
	'unity': ['unity', 'unity3d', 'c#'],
	'godot': ['godot', 'gdscript'],
	'unreal': ['unreal', 'ue4', 'ue5', 'unreal engine'],
	'phaser': ['phaser', 'phaser3', 'phaser.js'],
	'pixijs': ['pixi', 'pixijs', 'pixi.js'],
	'gamemaker': ['gamemaker', 'game maker', 'gms2']
};

// Feature detection patterns
const FEATURE_PATTERNS: Record<string, string[]> = {
	'authentication': ['auth', 'login', 'signup', 'user', 'users', 'account', 'accounts', 'session'],
	'payments': ['payment', 'payments', 'billing', 'subscription', 'checkout', 'cart', 'stripe'],
	'dashboard': ['dashboard', 'admin', 'analytics', 'metrics', 'charts', 'reports'],
	'api': ['api', 'apis', 'endpoint', 'endpoints', 'rest', 'graphql', 'backend'],
	'database': ['database', 'db', 'data', 'storage', 'crud', 'records'],
	'search': ['search', 'filter', 'filters', 'query', 'find'],
	'notifications': ['notification', 'notifications', 'email', 'sms', 'push', 'alert', 'alerts'],
	'file-upload': ['upload', 'file', 'files', 'image', 'images', 'media', 'storage'],
	'chat': ['chat', 'messaging', 'messages', 'conversation', 'inbox'],
	'collaboration': ['collaboration', 'team', 'teams', 'share', 'sharing', 'invite'],
	'integration': ['integration', 'integrations', 'connect', 'webhook', 'webhooks', 'sync'],
	// Game features
	'combat': ['combat', 'fight', 'fighting', 'battle', 'attack', 'damage', 'health', 'hp'],
	'inventory': ['inventory', 'items', 'equipment', 'loot', 'drops', 'crafting'],
	'progression': ['progression', 'leveling', 'xp', 'experience', 'skills', 'upgrade', 'unlocks'],
	'procedural': ['procedural', 'generation', 'random', 'dungeon', 'procedurally'],
	'multiplayer': ['multiplayer', 'coop', 'co-op', 'pvp', 'online', 'matchmaking']
};

// Domain detection patterns
const DOMAIN_PATTERNS: Record<string, string[]> = {
	'saas': ['saas', 'software', 'service', 'platform', 'subscription', 'b2b', 'b2c'],
	'e-commerce': ['ecommerce', 'e-commerce', 'shop', 'store', 'product', 'products', 'cart', 'checkout', 'inventory'],
	'marketplace': ['marketplace', 'buyers', 'sellers', 'listings', 'vendor', 'vendors'],
	'social': ['social', 'community', 'forum', 'network', 'feed', 'posts', 'followers'],
	'fintech': ['fintech', 'finance', 'banking', 'trading', 'crypto', 'wallet', 'money'],
	'healthcare': ['healthcare', 'health', 'medical', 'patient', 'doctor', 'clinic', 'hospital'],
	'education': ['education', 'learning', 'course', 'courses', 'student', 'teacher', 'lms'],
	'productivity': ['productivity', 'task', 'tasks', 'project', 'management', 'todo', 'workflow'],
	'content': ['blog', 'cms', 'content', 'article', 'articles', 'publishing', 'writer'],
	'analytics': ['analytics', 'tracking', 'metrics', 'data', 'insights', 'reporting'],
	'game': ['game', 'gaming', 'gamedev', 'roguelike', 'rpg', 'platformer', 'puzzle', 'strategy', 'shooter', 'simulation', 'arcade', 'adventure', 'survival'],
	'ai': ['ai', 'ml', 'machine learning', 'llm', 'gpt', 'claude', 'chatbot', 'agent', 'agents', 'neural', 'model'],
	'file-task': ['file', 'hello.txt', 'script', 'log']  // Simple file operations
};

// Simple task patterns - tasks that don't require full project scaffolding
const SIMPLE_TASK_PATTERNS = [
	/^create\s+(a\s+)?file/i,
	/^make\s+(a\s+)?file/i,
	/^write\s+(a\s+)?file/i,
	/^add\s+(a\s+)?file/i,
	/^delete\s+(a\s+)?file/i,
	/^remove\s+(a\s+)?file/i,
	/^edit\s+(a\s+)?file/i,
	/^modify\s+(a\s+)?file/i,
	/^rename\s+(a\s+)?file/i,
	/\.txt$/,
	/\.json$/,
	/\.md$/,
	/\.yaml$/,
	/\.yml$/,
	/\.csv$/,
	/\.log$/
];

// Vague input patterns that need clarification
const VAGUE_PATTERNS = [
	/^(something|anything|stuff|thing|cool|nice|good|great|awesome|amazing)$/i,
	/^(help|idea|project|app|website|site|system)$/i,
	/^(make money|get rich|passive income)$/i,
	/^(the next|a better|like \w+)$/i
];

/**
 * Sanitize user input
 */
export function sanitizeInput(input: string): string {
	return input
		// Remove HTML tags
		.replace(/<[^>]*>/g, '')
		// Remove null bytes
		.replace(/\0/g, '')
		// Normalize whitespace
		.replace(/\s+/g, ' ')
		// Trim
		.trim();
}

/**
 * Validate user input
 */
export function validateInput(input: string): ValidationResult {
	const warnings: string[] = [];
	const sanitized = sanitizeInput(input);

	// Check minimum length
	if (sanitized.length < GOAL_VALIDATION.MIN_LENGTH) {
		return {
			valid: false,
			sanitized,
			error: 'Please provide more detail about what you want to build.',
			warnings
		};
	}

	// Check maximum length
	if (sanitized.length > GOAL_VALIDATION.MAX_LENGTH) {
		warnings.push(`Input truncated to ${GOAL_VALIDATION.MAX_LENGTH} characters.`);
		return {
			valid: true,
			sanitized: sanitized.slice(0, GOAL_VALIDATION.MAX_LENGTH),
			warnings
		};
	}

	// Check for only special characters
	if (!/[a-zA-Z]/.test(sanitized)) {
		return {
			valid: false,
			sanitized,
			error: 'Please describe your project using words.',
			warnings
		};
	}

	return { valid: true, sanitized, warnings };
}

/**
 * Classify input type based on length and content
 */
export function classifyInputType(input: string): InputType {
	const wordCount = input.split(/\s+/).filter(w => w.length > 0).length;
	const hasTechTerms = Object.values(TECH_PATTERNS).flat().some(term =>
		input.toLowerCase().includes(term)
	);

	// Check for vague input
	const isVague = VAGUE_PATTERNS.some(pattern => pattern.test(input.trim()));
	if (isVague || wordCount <= 2) {
		// Exception: if it's a clear tech term like "auth" or "api", it's quick not vague
		if (hasTechTerms && wordCount <= 3) {
			return 'quick';
		}
		if (isVague) return 'vague';
	}

	// Technical spec (lots of tech terms, list-like)
	const techTermCount = Object.values(TECH_PATTERNS).flat()
		.filter(term => input.toLowerCase().includes(term)).length;
	if (techTermCount >= 3 && wordCount < 50) {
		return 'technical';
	}

	// Length-based classification
	if (wordCount <= 10) return 'quick';
	if (wordCount <= 50) return 'short';
	if (wordCount <= 200) return 'paragraph';
	return 'long';
}

/**
 * Extract keywords from input
 */
export function extractKeywords(input: string): string[] {
	const words = input.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, ' ')
		.split(/\s+/)
		.filter(word => word.length > 2)
		.filter(word => !STOP_WORDS.has(word));

	// Count frequency
	const frequency: Record<string, number> = {};
	words.forEach(word => {
		frequency[word] = (frequency[word] || 0) + 1;
	});

	// Sort by frequency and return unique
	return [...new Set(words)]
		.sort((a, b) => (frequency[b] || 0) - (frequency[a] || 0))
		.slice(0, 20);
}

/**
 * Detect technologies mentioned in input
 */
export function detectTechnologies(input: string): string[] {
	const lowerInput = input.toLowerCase();
	const detected: string[] = [];

	for (const [tech, patterns] of Object.entries(TECH_PATTERNS)) {
		if (patterns.some(pattern => lowerInput.includes(pattern))) {
			detected.push(tech);
		}
	}

	return detected;
}

/**
 * Detect features mentioned in input
 */
export function detectFeatures(input: string): string[] {
	const lowerInput = input.toLowerCase();
	const detected: string[] = [];

	for (const [feature, patterns] of Object.entries(FEATURE_PATTERNS)) {
		if (patterns.some(pattern => lowerInput.includes(pattern))) {
			detected.push(feature);
		}
	}

	return detected;
}

/**
 * Detect domains mentioned in input
 */
export function detectDomains(input: string): string[] {
	const lowerInput = input.toLowerCase();
	const detected: string[] = [];

	for (const [domain, patterns] of Object.entries(DOMAIN_PATTERNS)) {
		if (patterns.some(pattern => lowerInput.includes(pattern))) {
			detected.push(domain);
		}
	}

	return detected;
}

/**
 * Calculate confidence score based on extraction results
 */
export function calculateConfidence(
	keywords: string[],
	technologies: string[],
	features: string[],
	domains: string[],
	inputType: InputType
): number {
	// Base confidence from input type
	let confidence = inputType === 'vague' ? 0.2 :
		inputType === 'quick' ? 0.5 :
		inputType === 'short' ? 0.7 :
		inputType === 'technical' ? 0.9 :
		0.8;

	// Boost from detections
	if (technologies.length > 0) confidence += 0.1;
	if (features.length > 0) confidence += 0.1;
	if (domains.length > 0) confidence += 0.05;
	if (keywords.length >= 5) confidence += 0.05;

	return Math.min(1, confidence);
}

/**
 * Generate clarification prompt for vague inputs
 */
export function generateClarificationPrompt(input: string, inputType: InputType): string | undefined {
	if (inputType !== 'vague') return undefined;

	const prompts = [
		"What problem are you trying to solve?",
		"Who is the target user for this project?",
		"What's the main feature you want to build?",
		"Can you describe the core functionality?"
	];

	return prompts[Math.floor(Math.random() * prompts.length)];
}

/**
 * Main function: Analyze a goal/project description
 */
export function analyzeGoal(input: string): AnalyzedGoal {
	// Validate and sanitize
	const validation = validateInput(input);
	if (!validation.valid) {
		return {
			original: input,
			sanitized: validation.sanitized,
			inputType: 'vague',
			keywords: [],
			technologies: [],
			features: [],
			domains: [],
			confidence: 0,
			needsClarification: true,
			clarificationPrompt: validation.error
		};
	}

	const sanitized = validation.sanitized;

	// Classify input type
	const inputType = classifyInputType(sanitized);

	// Extract information
	const keywords = extractKeywords(sanitized);
	const technologies = detectTechnologies(sanitized);
	const features = detectFeatures(sanitized);
	const domains = detectDomains(sanitized);

	// Calculate confidence
	const confidence = calculateConfidence(keywords, technologies, features, domains, inputType);

	// Determine if clarification needed
	const needsClarification = confidence < GOAL_VALIDATION.VAGUE_INPUT_THRESHOLD;
	const clarificationPrompt = generateClarificationPrompt(sanitized, inputType);

	return {
		original: input,
		sanitized,
		inputType,
		keywords,
		technologies,
		features,
		domains,
		confidence,
		needsClarification,
		clarificationPrompt
	};
}
