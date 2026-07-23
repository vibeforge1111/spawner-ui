/**
 * Skills search tests
 *
 * /skills/find invites "Describe your project or search for skills...", but the
 * search filter matched the ENTIRE query as one literal substring of a skill's
 * name/description/tags. Any natural-language project description therefore
 * returned zero results from the full catalog.
 *
 * These tests pin the fixed contract:
 *  1. exact-substring queries behave exactly as before (no widening when the
 *     phrase already matches something)
 *  2. when the phrase matches nothing, every meaningful token must match (AND)
 *  3. when no skill matches all tokens, any-token matches still surface (OR)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
	skills,
	filters,
	filteredSkills,
	searchSkills,
	tokenizeSkillSearchQuery,
	type Skill
} from './skills.svelte';

const makeSkill = (id: string, description: string, tags: string[]): Skill => ({
	id,
	name: id,
	description,
	category: 'development',
	tier: 'premium',
	tags,
	triggers: []
});

const CATALOG: Skill[] = [
	makeSkill('stripe-integration', 'Stripe payments, subscriptions, webhooks, and billing portal', [
		'stripe',
		'payments'
	]),
	makeSkill('stripe-blog-billing', 'Stripe billing for your blog or newsletter', ['stripe', 'blog']),
	makeSkill('landing-page-design', 'High-converting landing page layout and copy', [
		'landing-page',
		'frontend'
	]),
	makeSkill('blog-engine', 'Static blog generation with markdown and RSS', ['blog', 'content']),
	makeSkill('pixel-art', 'Sprite sheets and palette-constrained pixel workflows', ['game-art'])
];

beforeEach(() => {
	skills.set(CATALOG);
	filters.set({ search: '', category: 'all', tier: 'all', tags: [] });
});

describe('tokenizeSkillSearchQuery', () => {
	it('drops grammatical stopwords and short fragments', () => {
		expect(tokenizeSkillSearchQuery('a landing page with stripe payments and a blog')).toEqual([
			'landing',
			'page',
			'stripe',
			'payments',
			'blog'
		]);
	});

	it('returns no tokens for stopword-only queries', () => {
		expect(tokenizeSkillSearchQuery('with the and a')).toEqual([]);
	});
});

describe('searchSkills', () => {
	it('returns results for a natural-language project description', () => {
		const ids = searchSkills(CATALOG, 'a landing page with stripe payments and a blog').map(
			(s) => s.id
		);
		expect(ids.length).toBeGreaterThan(0);
		expect(ids).toContain('stripe-integration');
		expect(ids).toContain('landing-page-design');
		expect(ids).toContain('blog-engine');
		expect(ids).not.toContain('pixel-art');
	});

	it('keeps exact-substring behavior when the phrase matches (no widening)', () => {
		// "stripe payments" is a literal substring of stripe-integration's description
		const ids = searchSkills(CATALOG, 'stripe payments').map((s) => s.id);
		expect(ids).toEqual(['stripe-integration']);
	});

	it('prefers all-token matches over any-token matches', () => {
		// no skill contains the phrase "stripe blog"; only stripe-blog-billing matches both tokens
		const ids = searchSkills(CATALOG, 'stripe blog').map((s) => s.id);
		expect(ids).toEqual(['stripe-blog-billing']);
	});

	it('single-keyword queries are unchanged', () => {
		const ids = searchSkills(CATALOG, 'stripe').map((s) => s.id);
		expect(ids).toEqual(['stripe-integration', 'stripe-blog-billing']);
	});

	it('stopword-only queries return nothing, as before', () => {
		expect(searchSkills(CATALOG, 'with the and a')).toEqual([]);
	});
});

describe('filteredSkills integration', () => {
	it('project descriptions surface skills through the derived store', () => {
		filters.update((f) => ({ ...f, search: 'a landing page with stripe payments and a blog' }));
		const ids = get(filteredSkills).map((s) => s.id);
		expect(ids.length).toBeGreaterThan(0);
		expect(ids).toContain('stripe-integration');
	});

	it('still composes with category and tier filters', () => {
		filters.update((f) => ({ ...f, search: 'stripe', tier: 'free' }));
		expect(get(filteredSkills)).toEqual([]);
	});
});
