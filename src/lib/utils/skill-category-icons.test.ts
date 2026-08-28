import { describe, expect, it } from 'vitest';
import {
	CATEGORY_ICONS,
	DEFAULT_CATEGORY_ICON,
	getCategoryIcon,
} from './skill-category-icons';

describe('CATEGORY_ICONS lookup table', () => {
	it('declares an icon for every documented category family', () => {
		const documented = [
			'development',
			'backend',
			'frontend',
			'ai-ml',
			'data',
			'design',
			'enterprise',
			'finance',
			'legal',
		];
		for (const key of documented) {
			expect(CATEGORY_ICONS[key]).toBeTypeOf('string');
			expect(CATEGORY_ICONS[key]).not.toBe('');
		}
	});

	it('aliases ai and ai-ml to the same icon family', () => {
		expect(CATEGORY_ICONS['ai']).toBe(CATEGORY_ICONS['ai-ml']);
	});

	it('aliases gamedev variants to gamepad', () => {
		expect(CATEGORY_ICONS['gamedev']).toBe('gamepad');
		expect(CATEGORY_ICONS['game-dev']).toBe('gamepad');
		expect(CATEGORY_ICONS['game-dev-llm']).toBe('gamepad');
	});

	it('aliases integration variants and mcp to plug', () => {
		expect(CATEGORY_ICONS['integration']).toBe('plug');
		expect(CATEGORY_ICONS['integrations']).toBe('plug');
		expect(CATEGORY_ICONS['mcp']).toBe('plug');
		expect(CATEGORY_ICONS['mcp-server']).toBe('plug');
	});
});

describe('getCategoryIcon', () => {
	it('returns the matching icon for a known category', () => {
		expect(getCategoryIcon('development')).toBe('cpu');
		expect(getCategoryIcon('design')).toBe('palette');
		expect(getCategoryIcon('strategy')).toBe('target');
	});

	it('normalises category to lowercase before lookup', () => {
		expect(getCategoryIcon('Development')).toBe('cpu');
		expect(getCategoryIcon('AI-ML')).toBe('brain');
	});

	it('returns the default icon for null, undefined, empty, or unknown categories', () => {
		expect(getCategoryIcon(null)).toBe(DEFAULT_CATEGORY_ICON);
		expect(getCategoryIcon(undefined)).toBe(DEFAULT_CATEGORY_ICON);
		expect(getCategoryIcon('')).toBe(DEFAULT_CATEGORY_ICON);
		expect(getCategoryIcon('made-up-category')).toBe(DEFAULT_CATEGORY_ICON);
	});

	it('exports a non-empty default icon name', () => {
		expect(DEFAULT_CATEGORY_ICON).toBe('layers');
	});
});
