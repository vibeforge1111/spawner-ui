import { describe, expect, it } from 'vitest';
import { eventBridge, eventBridgeReconnectDelay } from './event-bridge';

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

describe('client event bridge reconnect policy', () => {
	it('uses bounded full-jitter exponential backoff', () => {
		expect(eventBridgeReconnectDelay(1, () => 0.5)).toBe(500);
		expect(eventBridgeReconnectDelay(7, () => 0.5)).toBe(30_000);
		expect(eventBridgeReconnectDelay(10, () => 0.5)).toBe(30_000);
	});

	it('stops automatic reconnect after ten failed attempts', () => {
		expect(eventBridgeReconnectDelay(11, () => 0)).toBeNull();
		expect(eventBridgeReconnectDelay(0, () => 0)).toBeNull();
	});
});
