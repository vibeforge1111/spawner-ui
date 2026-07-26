import { describe, expect, it } from 'vitest';
import { analyzeSmartPRD } from './smart-prd-analyzer';

describe('smart PRD Unicode feature deduplication', () => {
	it('keeps distinct non-Latin feature titles instead of normalizing both to empty', () => {
		const analysis = analyzeSmartPRD(`# Multilingual product

## Features
- إضافة تسجيل دخول للمستخدمين
- إضافة لوحة تحكم للمشرفين
`);

		expect(analysis.explicitFeatures).toHaveLength(2);
		expect(analysis.explicitFeatures.map((feature) => feature.description)).toEqual([
			'إضافة تسجيل دخول للمستخدمين',
			'إضافة لوحة تحكم للمشرفين'
		]);
	});
});
