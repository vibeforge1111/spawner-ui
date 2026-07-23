import { describe, expect, it } from 'vitest';
import {
	getEventsApiKey,
	getEventsAuthHeaders,
	withEventsAuth
} from './events-auth-client';

describe('events-auth-client browser secret boundary', () => {
	it('never returns an API key or secret-bearing header to browser callers', () => {
		expect(getEventsApiKey()).toBeNull();
		expect(getEventsAuthHeaders()).toEqual({});
	});

	it('keeps same-origin event paths unchanged for HttpOnly-cookie authentication', () => {
		expect(withEventsAuth('/api/events?stream=1')).toBe('/api/events?stream=1');
	});
});
