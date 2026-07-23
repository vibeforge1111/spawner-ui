import { describe, expect, it } from 'vitest';
import { eventBridge } from './event-bridge';

describe('server event bridge capacity', () => {
	it('rejects excess subscribers and releases capacity after unsubscribe', () => {
		const unsubscribers: Array<() => void> = [];

		try {
			for (let index = 0; index < 1000; index += 1) {
				const unsubscribe = eventBridge.subscribe(() => {});
				expect(unsubscribe).not.toBeNull();
				unsubscribers.push(unsubscribe as () => void);
			}

			expect(eventBridge.subscriberCount).toBe(1000);
			expect(eventBridge.subscribe(() => {})).toBeNull();

			unsubscribers.pop()?.();
			const replacement = eventBridge.subscribe(() => {});
			expect(replacement).not.toBeNull();
			replacement?.();
		} finally {
			for (const unsubscribe of unsubscribers) unsubscribe();
		}

		expect(eventBridge.subscriberCount).toBe(0);
	});
});
