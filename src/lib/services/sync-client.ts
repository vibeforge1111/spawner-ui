import { logger } from '$lib/utils/logger';
/**
 * Sync Client - Real-time bidirectional sync between Spawner UI and Claude Code
 *
 * Provides WebSocket connection for instant updates when:
 * 1. Spawner UI creates/updates missions → Claude Code sees immediately
 * 2. Claude Code updates missions → Spawner UI sees immediately
 *
 * Falls back to polling when WebSocket not available.
 *
 * Setup: Run `wrangler dev` in spawner-v2 to enable local sync.
 */

import { writable, derived, get } from 'svelte/store';
import { SyncMessageSchema, safeJsonParse } from '$lib/types/schemas';
import { getEventsAuthHeaders } from '$lib/services/events-auth-client';

export type SyncStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface SyncEvent {
	type:
		| 'mission_created'
		| 'mission_updated'
		| 'mission_started'
		| 'mission_completed'
		| 'mission_failed'
		| 'mission_cancelled'
		| 'mission_paused'      // NEW: Mission paused by user
		| 'mission_resumed'     // NEW: Mission resumed by user
		| 'mission_log'
		| 'task_started'        // NEW: Explicit task start
		| 'task_progress'       // NEW: Task progress update (0-100%)
		| 'task_completed'      // NEW: Explicit task completion
		| 'skill_invoked'
		| 'agent_handoff'
		| 'learning_recorded'
		| 'pattern_detected'
		| 'decision_tracked'
		| 'outcome_recorded';
	missionId?: string;
	data: Record<string, unknown>;
	timestamp: string;
	source: 'spawner-ui' | 'claude-code' | 'server';
}

export interface SyncConfig {
	wsUrl: string;
	httpUrl: string;
	reconnectInterval: number;
	maxReconnectAttempts: number;
	heartbeatInterval: number;
}

// Default config is intentionally disconnected for launch. Set public env vars
// when a local or hosted sync bridge is available.
const DEFAULT_CONFIG: SyncConfig = {
	wsUrl: '',
	httpUrl: '',
	reconnectInterval: 3000,
	maxReconnectAttempts: 10,
	heartbeatInterval: 30000
};

// Stores
const syncStatus = writable<SyncStatus>('disconnected');
const lastEvent = writable<SyncEvent | null>(null);
const eventLog = writable<SyncEvent[]>([]);
const connectionError = writable<string | null>(null);

// Derived stores
export const isConnected = derived(syncStatus, $status => $status === 'connected');
export const isReconnecting = derived(syncStatus, $status => $status === 'reconnecting');

// Event subscribers
type EventCallback = (event: SyncEvent) => void;
const eventSubscribers: Map<string, Set<EventCallback>> = new Map();

class SyncClient {
	private ws: WebSocket | null = null;
	private config: SyncConfig;
	private reconnectAttempts = 0;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private pongDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private clientId: string;

	constructor(config?: Partial<SyncConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.clientId = `spawner-ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	}

	/**
	 * Configure the sync client
	 */
	configure(config: Partial<SyncConfig>): void {
		this.config = { ...this.config, ...config };
	}

	/**
	 * Get current config
	 */
	getConfig(): SyncConfig {
		return { ...this.config };
	}

	/**
	 * Connect to the sync server
	 */
	async connect(): Promise<boolean> {
		// Don't reconnect if already connected
		if (this.ws?.readyState === WebSocket.OPEN) {
			return true;
		}

		if (!this.config.wsUrl && !this.config.httpUrl) {
			syncStatus.set('disconnected');
			connectionError.set(null);
			return false;
		}

		syncStatus.set('connecting');
		connectionError.set(null);

		try {
			// Try WebSocket connection
			return await this.connectWebSocket();
		} catch (error) {
			console.warn('[SyncClient] WebSocket connection failed:', error);

			// Fall back to checking HTTP availability
			const httpAvailable = await this.checkHttpAvailability();
			if (httpAvailable) {
				syncStatus.set('connected');
				logger.info('[SyncClient] Using HTTP polling fallback (WebSocket not available)');
				return true;
			}

			syncStatus.set('error');
			connectionError.set(error instanceof Error ? error.message : 'Connection failed');
			return false;
		}
	}

	/**
	 * Connect via WebSocket
	 */
	private connectWebSocket(): Promise<boolean> {
		return new Promise((resolve, reject) => {
			try {
				this.ws = new WebSocket(this.config.wsUrl);

				const timeout = setTimeout(() => {
					if (this.ws?.readyState !== WebSocket.OPEN) {
						this.ws?.close();
						reject(new Error('WebSocket connection timeout'));
					}
				}, 5000);

				this.ws.onopen = () => {
					clearTimeout(timeout);
					logger.info('[SyncClient] WebSocket connected');
					syncStatus.set('connected');
					this.reconnectAttempts = 0;
					this.startHeartbeat();

					// Send identify message
					this.send({
						type: 'identify',
						clientId: this.clientId,
						clientType: 'spawner-ui'
					});

					resolve(true);
				};

				this.ws.onmessage = (event) => {
					try {
						// SECURITY: Validate JSON with Zod schema
						const data = safeJsonParse(event.data, SyncMessageSchema, 'sync-message');
						if (data) {
							this.handleMessage(data);
						} else {
							console.warn('[SyncClient] Invalid message data, skipping');
						}
					} catch (error) {
						console.error('[SyncClient] Failed to parse message:', error);
					}
				};

				this.ws.onerror = (error) => {
					clearTimeout(timeout);
					console.error('[SyncClient] WebSocket error:', error);
					reject(new Error('WebSocket connection error'));
				};

				this.ws.onclose = (event) => {
					clearTimeout(timeout);
					logger.info('[SyncClient] WebSocket closed:', event.code, event.reason);
					this.stopHeartbeat();

					if (get(syncStatus) === 'connected') {
						// Unexpected disconnect - try to reconnect
						this.scheduleReconnect();
					}
				};

			} catch (error) {
				reject(error);
			}
		});
	}

	/**
	 * Check if HTTP endpoint is available
	 */
	private async checkHttpAvailability(): Promise<boolean> {
		try {
			const response = await fetch(this.config.httpUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
			});
			return response.ok;
		} catch {
			return false;
		}
	}

	/**
	 * Disconnect from the sync server
	 */
	disconnect(): void {
		this.stopHeartbeat();
		this.cancelReconnect();

		if (this.ws) {
			this.ws.close(1000, 'Client disconnect');
			this.ws = null;
		}

		syncStatus.set('disconnected');
	}

	/**
	 * Send a message to the server
	 */
	send(message: Record<string, unknown>): boolean {
		if (this.ws?.readyState !== WebSocket.OPEN) {
			console.warn('[SyncClient] Cannot send - not connected');
			return false;
		}

		try {
			this.ws.send(JSON.stringify({
				...message,
				clientId: this.clientId,
				timestamp: new Date().toISOString()
			}));
			return true;
		} catch (error) {
			console.error('[SyncClient] Send failed:', error);
			return false;
		}
	}

	/**
	 * Broadcast an event to all connected clients
	 */
	broadcast(event: Omit<SyncEvent, 'timestamp' | 'source'>): void {
		const fullEvent: SyncEvent = {
			...event,
			timestamp: new Date().toISOString(),
			source: 'spawner-ui'
		};

		// Record locally
		eventLog.update(log => [...log.slice(-99), fullEvent]);
		lastEvent.set(fullEvent);

		// Send to server for broadcast
		this.send({
			type: 'broadcast',
			event: fullEvent
		});

		// Notify local subscribers
		this.notifySubscribers(fullEvent);

		// Also POST to /api/events for SSE bridge (Theatre and other SSE clients)
		if (typeof fetch !== 'undefined') {
			fetch('/api/events', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...getEventsAuthHeaders()
				},
				body: JSON.stringify(fullEvent)
			}).catch(() => {
				// Silently ignore - SSE bridge is optional
			});
		}
	}

	/**
	 * Subscribe to specific event types
	 */
	subscribe(eventType: string, callback: EventCallback): () => void {
		if (!eventSubscribers.has(eventType)) {
			eventSubscribers.set(eventType, new Set());
		}
		eventSubscribers.get(eventType)!.add(callback);

		// Return unsubscribe function
		return () => {
			eventSubscribers.get(eventType)?.delete(callback);
		};
	}

	/**
	 * Subscribe to all events
	 */
	subscribeAll(callback: EventCallback): () => void {
		return this.subscribe('*', callback);
	}

	/**
	 * Handle incoming message
	 */
	private handleMessage(data: Record<string, unknown>): void {
		const type = data.type as string;

		switch (type) {
			case 'pong':
				// Heartbeat response — server is still alive, clear the watchdog.
				this.clearPongDeadline();
				break;

			case 'event':
				// Sync event from another client or server
				const event = data.event as SyncEvent;
				eventLog.update(log => [...log.slice(-99), event]);
				lastEvent.set(event);
				this.notifySubscribers(event);
				break;

			case 'sync_state':
				// Full state sync (on reconnect)
				logger.info('[SyncClient] Received state sync');
				break;

			case 'error':
				console.error('[SyncClient] Server error:', data.message);
				connectionError.set(data.message as string);
				break;

			default:
				// Handle canvas events and other direct messages
				if (type && type.startsWith('canvas_')) {
					// Canvas event - treat as sync event
					const event: SyncEvent = {
						type: type as SyncEvent['type'],
						data: data as Record<string, unknown>,
						timestamp: (data.timestamp as string) || new Date().toISOString(),
						source: (data.source as SyncEvent['source']) || 'server'
					};
					eventLog.update(log => [...log.slice(-99), event]);
					lastEvent.set(event);
					this.notifySubscribers(event);
				} else if (type && (type === 'test_echo' || type === 'broadcast')) {
					// Test or broadcast message - forward as event
					const event: SyncEvent = {
						type: type as SyncEvent['type'],
						data: (data.data as Record<string, unknown>) || data,
						timestamp: (data.timestamp as string) || new Date().toISOString(),
						source: (data.source as SyncEvent['source']) || 'server'
					};
					this.notifySubscribers(event);
				} else {
					logger.info('[SyncClient] Unknown message type:', type);
				}
		}
	}

	/**
	 * Notify subscribers of an event
	 */
	private notifySubscribers(event: SyncEvent): void {
		// Notify specific type subscribers
		eventSubscribers.get(event.type)?.forEach(callback => {
			try {
				callback(event);
			} catch (error) {
				console.error('[SyncClient] Subscriber error:', error);
			}
		});

		// Notify wildcard subscribers
		eventSubscribers.get('*')?.forEach(callback => {
			try {
				callback(event);
			} catch (error) {
				console.error('[SyncClient] Subscriber error:', error);
			}
		});
	}

	/**
	 * Start heartbeat to keep connection alive
	 */
	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.heartbeatTimer = setInterval(() => {
			const sent = this.send({ type: 'ping' });
			if (!sent) return;
			// Arm a one-shot deadline; if the server does not pong within
			// the heartbeat interval, treat the socket as a zombie and reconnect.
			this.armPongDeadline();
		}, this.config.heartbeatInterval);
	}

	private armPongDeadline(): void {
		this.clearPongDeadline();
		this.pongDeadlineTimer = setTimeout(() => {
			this.pongDeadlineTimer = null;
			logger.info('[SyncClient] Pong deadline exceeded — closing zombie socket');
			try {
				this.ws?.close(4000, 'pong-timeout');
			} catch {
				// onclose will schedule reconnect
			}
		}, this.config.heartbeatInterval);
	}

	private clearPongDeadline(): void {
		if (this.pongDeadlineTimer) {
			clearTimeout(this.pongDeadlineTimer);
			this.pongDeadlineTimer = null;
		}
	}

	/**
	 * Stop heartbeat
	 */
	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		this.clearPongDeadline();
	}

	/**
	 * Schedule a reconnection attempt
	 */
	private scheduleReconnect(): void {
		if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
			logger.info('[SyncClient] Max reconnect attempts reached');
			syncStatus.set('error');
			connectionError.set('Max reconnection attempts reached');
			return;
		}

		syncStatus.set('reconnecting');
		this.reconnectAttempts++;

		// Cap base delay so attempt 10 doesn't sit idle for ~2 minutes, then
		// apply +/-25% jitter so a fleet of browser tabs reconnecting after a
		// server restart doesn't all hit the same offset at once.
		const baseDelay = Math.min(
			this.config.reconnectInterval * Math.pow(1.5, this.reconnectAttempts - 1),
			30_000
		);
		const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1);
		const delay = Math.max(0, Math.round(baseDelay + jitter));
		logger.info(`[SyncClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

		this.reconnectTimer = setTimeout(() => {
			this.connect();
		}, delay);
	}

	/**
	 * Cancel pending reconnection
	 */
	private cancelReconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}
}

// Singleton instance
export const syncClient = new SyncClient();

// Export stores
export { syncStatus, lastEvent, eventLog, connectionError };

// Export class for testing
export { SyncClient };

// Helper to broadcast mission events
export function broadcastMissionEvent(
	type: SyncEvent['type'],
	missionId: string,
	data: Record<string, unknown> = {}
): void {
	syncClient.broadcast({
		type,
		missionId,
		data
	});
}

// Helper to broadcast learning events
export function broadcastLearningEvent(
	type: 'learning_recorded' | 'pattern_detected' | 'decision_tracked' | 'outcome_recorded',
	data: {
		memoryId?: string;
		agentId?: string;
		skillId?: string;
		missionId?: string;
		content?: string;
		[key: string]: unknown;
	}
): void {
	syncClient.broadcast({
		type,
		missionId: data.missionId,
		data
	});
}

// Helper to broadcast task events (for real-time task tracking)
export function broadcastTaskEvent(
	type: 'task_started' | 'task_progress' | 'task_completed',
	missionId: string,
	data: {
		taskId: string;
		taskName: string;
		progress?: number;        // 0-100 for task_progress
		success?: boolean;        // for task_completed
		message?: string;         // current activity description
		agentId?: string;
		skillId?: string;
		[key: string]: unknown;
	}
): void {
	syncClient.broadcast({
		type,
		missionId,
		data: {
			...data,
			timestamp: Date.now()
		}
	});
}

// Helper to broadcast pause/resume events
export function broadcastExecutionControl(
	type: 'mission_paused' | 'mission_resumed',
	missionId: string,
	data: {
		reason?: string;
		pausedAt?: number;
		resumedAt?: number;
		[key: string]: unknown;
	} = {}
): void {
	syncClient.broadcast({
		type,
		missionId,
		data: {
			...data,
			timestamp: Date.now()
		}
	});
}
