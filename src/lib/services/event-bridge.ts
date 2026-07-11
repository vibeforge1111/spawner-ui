import { logger } from '$lib/utils/logger';
/**
 * Event Bridge Service
 *
 * Provides bidirectional communication between Claude Code and spawner-ui.
 * Claude Code POSTs events to /api/events, which broadcasts them to all UI clients.
 *
 * Server-side: Receives events and broadcasts via SSE
 * Client-side: Connects to SSE stream and notifies subscribers
 */

import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';
import { ClientBridgeEventSchema, safeJsonParse } from '$lib/types/schemas';
import { getEventsAuthHeaders, withEventsAuth } from '$lib/services/events-auth-client';

export interface BridgeEvent {
	id?: string;
	type: string;
	missionId?: string;
	taskId?: string;
	taskName?: string;
	progress?: number;
	message?: string;
	data?: Record<string, unknown>;
	timestamp: string;
	source: string;
}

type EventCallback = (event: BridgeEvent) => void;

/**
 * Server-side event bridge (used in +server.ts)
 */
class ServerEventBridge {
	private subscribers: Set<EventCallback> = new Set();

	emit(event: BridgeEvent): void {
		this.subscribers.forEach((callback) => {
			try {
				callback(event);
			} catch (e) {
				console.error('[EventBridge] Subscriber error:', e);
			}
		});
	}

	subscribe(callback: EventCallback): () => void {
		this.subscribers.add(callback);
		return () => {
			this.subscribers.delete(callback);
		};
	}

	get subscriberCount(): number {
		return this.subscribers.size;
	}
}

/**
 * Client-side event bridge (used in browser)
 */
class ClientEventBridge {
	private eventSource: EventSource | null = null;
	private subscribers: Set<EventCallback> = new Set();
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempts = 0;
	private static readonly MAX_RECONNECT_ATTEMPTS = 10;
	private static readonly BASE_RECONNECT_DELAY_MS = 3000;
	private connectionStatus = writable<'disconnected' | 'connecting' | 'connected'>('disconnected');

	constructor() {
		if (browser) {
			this.connect();
		}
	}

	get status() {
		return this.connectionStatus;
	}

	connect(): void {
		if (!browser) return;

		// Don't reconnect if already connected
		if (this.eventSource?.readyState === EventSource.OPEN) {
			return;
		}

		this.connectionStatus.set('connecting');

		try {
			this.eventSource = new EventSource(withEventsAuth('/api/events'));

			this.eventSource.onopen = () => {
				logger.info('[EventBridge] Connected to event stream');
				this.connectionStatus.set('connected');
				this.reconnectAttempts = 0;
			};

			this.eventSource.onmessage = (event) => {
				try {
					// SECURITY: Validate JSON with Zod schema
					const data = safeJsonParse(event.data, ClientBridgeEventSchema, 'bridge-event');
					if (data) {
						this.notifySubscribers(data as BridgeEvent);
					} else {
						console.warn('[EventBridge] Invalid event data, skipping');
					}
				} catch (e) {
					console.error('[EventBridge] Failed to parse event:', e);
				}
			};

			this.eventSource.onerror = (error) => {
				console.error('[EventBridge] Connection error:', error);
				this.connectionStatus.set('disconnected');
				this.eventSource?.close();
				this.eventSource = null;
				this.scheduleReconnect();
			};
		} catch (e) {
			console.error('[EventBridge] Failed to connect:', e);
			this.connectionStatus.set('disconnected');
			this.scheduleReconnect();
		}
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer) return;
		if (this.reconnectAttempts >= ClientEventBridge.MAX_RECONNECT_ATTEMPTS) {
			logger.warn('[EventBridge] Max reconnect attempts reached, stopping reconnect.');
			return;
		}
		const delay = Math.min(
			ClientEventBridge.BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
			60000
		);
		this.reconnectAttempts++;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delay);
	}

	disconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.eventSource) {
			this.eventSource.close();
			this.eventSource = null;
		}
		this.connectionStatus.set('disconnected');
	}

	subscribe(callback: EventCallback): () => void {
		this.subscribers.add(callback);
		return () => {
			this.subscribers.delete(callback);
		};
	}

	private notifySubscribers(event: BridgeEvent): void {
		this.subscribers.forEach((callback) => {
			try {
				callback(event);
			} catch (e) {
				console.error('[EventBridge] Subscriber error:', e);
			}
		});
	}

	/**
	 * Send an event to the server (from UI to Claude Code)
	 */
	async send(event: Omit<BridgeEvent, 'timestamp' | 'source'>): Promise<boolean> {
		try {
			const response = await fetch('/api/events', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...getEventsAuthHeaders()
				},
				body: JSON.stringify({
					...event,
					source: 'spawner-ui',
					timestamp: new Date().toISOString()
				})
			});
			return response.ok;
		} catch (e) {
			console.error('[EventBridge] Failed to send event:', e);
			return false;
		}
	}
}

// Export server-side bridge singleton
export const eventBridge = new ServerEventBridge();

// Export client-side bridge singleton (only created in browser)
export const clientEventBridge = browser ? new ClientEventBridge() : null;

// Export stores for UI
export const eventBridgeStatus = browser
	? clientEventBridge!.status
	: writable<'disconnected' | 'connecting' | 'connected'>('disconnected');
