import { describe, expect, it } from 'vitest';
import { parseEnrichmentPayload } from './brief-enricher';

describe('parseEnrichmentPayload', () => {
	it('accepts the bounded enrichment shape', () => {
		expect(parseEnrichmentPayload(JSON.stringify({
			enrichedContent: 'Build a focused launch board.',
			addedAssumptions: ['Single workspace'],
			openQuestions: ['Who owns approval?'],
			wasEnriched: true
		}))).toMatchObject({
			enrichedContent: 'Build a focused launch board.',
			addedAssumptions: ['Single workspace'],
			openQuestions: ['Who owns approval?']
		});
	});

	it('rejects malformed JSON and invalid field types', () => {
		expect(parseEnrichmentPayload('{not-json')).toBeNull();
		expect(parseEnrichmentPayload(JSON.stringify({ addedAssumptions: [42] }))).toBeNull();
	});
});
