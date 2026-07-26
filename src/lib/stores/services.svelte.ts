/**
 * Services Store
 * Svelte 5 runes-based store for managing service state
 */

import { browser } from '$app/environment';
import type { Service, HealthCheck, DashboardStats, AlertConfig } from '$lib/types/dashboard';
import { healthChecker, createHealthCheck, calculateUptime, type CheckResult } from '$lib/services/health-checker';
import { DashboardServiceArraySchema, DashboardAlertConfigArraySchema, safeJsonParse } from '$lib/types/schemas';

// Storage key for persistence
const STORAGE_KEY = 'status-dashboard-services';
const ALERTS_STORAGE_KEY = 'status-dashboard-alerts';

// State using Svelte 5 runes
let services = $state<Service[]>([]);
let healthHistory = $state<Map<string, HealthCheck[]>>(new Map());
let alerts = $state<AlertConfig[]>([]);
let isPolling = $state(false);

// Load from localStorage on init
if (browser) {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored) {
			// SECURITY: Validate JSON with Zod schema
			const parsed = safeJsonParse(stored, DashboardServiceArraySchema, 'dashboard-services');
			if (parsed) {
				services = parsed.map((s) => ({
					...s,
					lastCheck: s.lastCheck ? new Date(s.lastCheck) : null,
					createdAt: new Date(s.createdAt),
				})) as Service[];
			} else {
				console.warn('[ServicesStore] Invalid services data, skipping load');
			}
		}

		const storedAlerts = localStorage.getItem(ALERTS_STORAGE_KEY);
		if (storedAlerts) {
			// SECURITY: Validate JSON with Zod schema
			const parsedAlerts = safeJsonParse(storedAlerts, DashboardAlertConfigArraySchema, 'dashboard-alerts');
			if (parsedAlerts) {
				alerts = parsedAlerts as AlertConfig[];
			} else {
				console.warn('[ServicesStore] Invalid alerts data, skipping load');
			}
		}
	} catch (e) {
		console.error('[ServicesStore] Failed to load from localStorage:', e);
	}
}

// Persist to localStorage
function persist(): void {
	if (!browser) return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(services));
		localStorage.setItem(ALERTS_STORAGE_KEY, JSON.stringify(alerts));
	} catch (e) {
		console.error('[ServicesStore] Failed to persist:', e);
	}
}

/**
 * Add a new service to monitor
 */
export function addService(name: string, url: string, description?: string, tags?: string[]): Service {
	const service: Service = {
		id: `service-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`,
		name,
		url,
		description,
		status: 'unknown',
		lastCheck: null,
		lastResponseTime: null,
		uptimePercentage: 100,
		consecutiveFailures: 0,
		createdAt: new Date(),
		tags,
	};

	services = [...services, service];
	healthHistory.set(service.id, []);
	persist();

	// Start polling if enabled
	if (isPolling) {
		healthChecker.startPolling(service);
	}

	return service;
}

/**
 * Remove a service
 */
export function removeService(serviceId: string): void {
	healthChecker.stopPolling(serviceId);
	services = services.filter(s => s.id !== serviceId);
	healthHistory.delete(serviceId);
	alerts = alerts.filter(a => a.serviceId !== serviceId);
	persist();
}

/**
 * Update a service
 */
export function updateService(serviceId: string, updates: Partial<Service>): void {
	services = services.map(s =>
		s.id === serviceId ? { ...s, ...updates } : s
	);
	persist();
}

/**
 * Handle health check result
 */
function handleCheckResult(serviceId: string, result: CheckResult): void {
	const service = services.find(s => s.id === serviceId);
	if (!service) return;

	// Create health check record
	const check = createHealthCheck(serviceId, result);

	// Update health history (keep last 24 hours worth)
	const history = healthHistory.get(serviceId) || [];
	const cutoff = Date.now() - 24 * 60 * 60 * 1000;
	const filteredHistory = history.filter(h => h.timestamp.getTime() > cutoff);
	filteredHistory.push(check);
	healthHistory.set(serviceId, filteredHistory);

	// Update service state
	const wasDown = service.status === 'down';
	const isNowHealthy = result.status === 'healthy';
	const consecutiveFailures = result.status === 'healthy' ? 0 : service.consecutiveFailures + 1;

	services = services.map(s =>
		s.id === serviceId
			? {
					...s,
					status: result.status,
					lastCheck: new Date(),
					lastResponseTime: result.responseTime,
					uptimePercentage: calculateUptime(filteredHistory),
					consecutiveFailures,
			  }
			: s
	);

	// Check alerts
	checkAlerts(serviceId, result, consecutiveFailures);

	// Trigger recovery notification if applicable
	if (wasDown && isNowHealthy) {
		const alertConfig = alerts.find(a => a.serviceId === serviceId && a.notifyOnRecovery);
		if (alertConfig) {
			triggerNotification(`${service.name} has recovered`, 'Service is healthy again');
		}
	}

	persist();
}

/**
 * Check if alerts should be triggered
 */
function checkAlerts(serviceId: string, result: CheckResult, consecutiveFailures: number): void {
	const alertConfig = alerts.find(a => a.serviceId === serviceId && a.enabled);
	if (!alertConfig) return;

	const service = services.find(s => s.id === serviceId);
	if (!service) return;

	// Check response time threshold
	if (result.responseTime > alertConfig.responseTimeThreshold) {
		triggerNotification(
			`${service.name} is slow`,
			`Response time: ${result.responseTime}ms (threshold: ${alertConfig.responseTimeThreshold}ms)`
		);
	}

	// Check consecutive failures
	if (consecutiveFailures >= alertConfig.consecutiveFailuresThreshold) {
		triggerNotification(
			`${service.name} is failing`,
			`${consecutiveFailures} consecutive failures`
		);
	}
}

/**
 * Trigger a browser notification
 */
async function triggerNotification(title: string, body: string): Promise<void> {
	if (!browser) return;

	if (Notification.permission === 'granted') {
		new Notification(title, { body, icon: '/favicon.png' });
	} else if (Notification.permission !== 'denied') {
		const permission = await Notification.requestPermission();
		if (permission === 'granted') {
			new Notification(title, { body, icon: '/favicon.png' });
		}
	}
}

/**
 * Start polling all services
 */
export function startPolling(): void {
	if (isPolling) return;

	isPolling = true;
	healthChecker.setOnCheck(handleCheckResult);

	for (const service of services) {
		healthChecker.startPolling(service);
	}
}

/**
 * Stop polling all services
 */
export function stopPolling(): void {
	isPolling = false;
	healthChecker.stopAll();
}

/**
 * Configure alerts for a service
 */
export function setAlertConfig(config: AlertConfig): void {
	const existing = alerts.findIndex(a => a.id === config.id);
	if (existing >= 0) {
		alerts = alerts.map((a, i) => i === existing ? config : a);
	} else {
		alerts = [...alerts, config];
	}
	persist();
}

/**
 * Get alert config for a service
 */
export function getAlertConfig(serviceId: string): AlertConfig | undefined {
	return alerts.find(a => a.serviceId === serviceId);
}

/**
 * Get dashboard statistics
 */
export function getStats(): DashboardStats {
	const totalServices = services.length;
	const healthyServices = services.filter(s => s.status === 'healthy').length;
	const degradedServices = services.filter(s => s.status === 'degraded').length;
	const downServices = services.filter(s => s.status === 'down').length;

	const responseTimes = services
		.filter(s => s.lastResponseTime !== null)
		.map(s => s.lastResponseTime!);
	const averageResponseTime = responseTimes.length > 0
		? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
		: 0;

	const uptimes = services.map(s => s.uptimePercentage);
	const overallUptime = uptimes.length > 0
		? Math.round((uptimes.reduce((a, b) => a + b, 0) / uptimes.length) * 100) / 100
		: 100;

	return {
		totalServices,
		healthyServices,
		degradedServices,
		downServices,
		averageResponseTime,
		overallUptime,
	};
}

/**
 * Get health history for a service
 */
export function getHealthHistory(serviceId: string): HealthCheck[] {
	return healthHistory.get(serviceId) || [];
}

// Export reactive getters
export function getServices() {
	return services;
}

export function getIsPolling() {
	return isPolling;
}

export function getAlerts() {
	return alerts;
}
