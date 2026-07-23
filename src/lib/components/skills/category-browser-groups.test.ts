/**
 * Category browser grouping tests
 *
 * The Browse by Category sidebar used a hardcoded taxonomy of category ids.
 * Skills whose category was not in that list (84 of 656 in the shipped
 * skills.json — integrations, engineering, healthcare, mcp, ...) were
 * unreachable through category browsing: the group counts summed to 572
 * while "All" showed 656.
 *
 * buildExtraCategoryGroup() derives a trailing group from the live category
 * counts so every category present in the data is always browsable, no matter
 * how the curated taxonomy drifts.
 */

import { describe, it, expect } from 'vitest';
import {
	buildExtraCategoryGroup,
	labelForCategoryId
} from './category-browser-groups';

const KNOWN = new Set(['ai', 'development', 'backend', 'design', 'finance']);

describe('labelForCategoryId', () => {
	it('title-cases kebab-case ids', () => {
		expect(labelForCategoryId('revenue-ops')).toBe('Revenue Ops');
		expect(labelForCategoryId('customer-success')).toBe('Customer Success');
		expect(labelForCategoryId('engineering')).toBe('Engineering');
	});

	it('uppercases known acronyms', () => {
		expect(labelForCategoryId('mcp')).toBe('MCP');
	});
});

describe('buildExtraCategoryGroup', () => {
	it('collects categories that exist in the data but not in the taxonomy', () => {
		const counts = {
			ai: 36,
			development: 28,
			integrations: 27,
			engineering: 15,
			mcp: 4
		};
		const group = buildExtraCategoryGroup(counts, KNOWN);
		expect(group).not.toBeNull();
		expect(group!.categories.map((c) => c.id)).toEqual(['engineering', 'integrations', 'mcp']);
		expect(group!.categories.map((c) => c.label)).toEqual(['Engineering', 'Integrations', 'MCP']);
	});

	it('returns null when every category is covered by the taxonomy', () => {
		expect(buildExtraCategoryGroup({ ai: 36, design: 12 }, KNOWN)).toBeNull();
	});

	it('ignores zero-count and empty categories', () => {
		expect(buildExtraCategoryGroup({ integrations: 0, '': 3 }, KNOWN)).toBeNull();
	});

	it('covers the shipped catalog: taxonomy + extra group account for every skill', () => {
		// shape of the real skills.json category histogram at the time of the fix
		const counts: Record<string, number> = {
			ai: 36, 'ai-agents': 28, data: 22, development: 28, backend: 65, frontend: 41,
			frameworks: 13, devops: 30, infrastructure: 20, security: 15, testing: 7,
			performance: 3, 'game-dev': 40, gamedev: 4, 'game-dev-llm': 1, blockchain: 16,
			web3: 8, finance: 6, trading: 4, business: 19, strategy: 17, startup: 12,
			founder: 5, product: 5, marketing: 40, community: 14, communications: 11,
			creative: 19, design: 16, space: 5, biotech: 4, robotics: 6, climate: 3,
			education: 4, legal: 3, hardware: 2,
			// orphaned in the shipped CategoryBrowser taxonomy:
			integrations: 27, engineering: 15, healthcare: 5, 'revenue-ops': 5,
			enterprise: 5, 'trust-safety': 5, 'customer-success': 4, mcp: 4,
			'people-ops': 4, ecommerce: 3, marketplaces: 3, architecture: 2,
			methodology: 1, science: 1
		};
		const taxonomy = new Set([
			'ai', 'ai-agents', 'ai-tools', 'data', 'data-science', 'development', 'backend',
			'frontend', 'frameworks', 'mobile', 'devops', 'infrastructure', 'security',
			'testing', 'performance', 'game-dev', 'gamedev', 'game-dev-llm', 'blockchain',
			'web3', 'finance', 'trading', 'business', 'strategy', 'startup', 'founder',
			'product', 'marketing', 'community', 'communications', 'creative', 'design',
			'space', 'biotech', 'robotics', 'climate', 'education', 'legal', 'hardware'
		]);
		const group = buildExtraCategoryGroup(counts, taxonomy);
		expect(group).not.toBeNull();
		const extraTotal = group!.categories.reduce((sum, c) => sum + (counts[c.id] || 0), 0);
		const taxonomyTotal = Object.entries(counts)
			.filter(([id]) => taxonomy.has(id))
			.reduce((sum, [, n]) => sum + n, 0);
		const allTotal = Object.values(counts).reduce((sum, n) => sum + n, 0);
		expect(group!.categories).toHaveLength(14);
		expect(extraTotal).toBe(84);
		expect(taxonomyTotal + extraTotal).toBe(allTotal); // nothing orphaned
	});
});
