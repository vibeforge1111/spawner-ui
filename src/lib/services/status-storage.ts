/**
 * Status Dashboard Storage
 *
 * LocalStorage-based persistence for the status dashboard.
 * Defines data schema and storage operations.
 */

import { browser } from '$app/environment';
import type {
	Service,
	HealthCheck,
	Incident,
	AlertConfig,
	DashboardStats
} from '$lib/types/dashboard';
import {
	StatusServiceArraySchema,
	StatusHealthCheckArraySchema,
	StatusIncidentArraySchema,
	StatusAlertConfigArraySchema,
	DashboardSettingsSchema,
	safeJsonParse
} from '$lib/types/schemas';

// Storage keys
const STORAGE_PREFIX = 'status-dashboard';
const KEYS = {
	SERVICES: `${STORAGE_PREFIX}-services`,
	HEALTH_HISTORY: `${STORAGE_PREFIX}-health-history`,
	INCIDENTS: `${STORAGE_PREFIX}-incidents`,
	ALERTS: `${STORAGE_PREFIX}-alerts`,
	SETTINGS: `${STORAGE_PREFIX}-settings`
} as const;

// Max history entries per service
const MAX_HEALTH_HISTORY = 100;
const MAX_INCIDENTS_PER_SERVICE = 50;

function safeTimeMs(value: Date): number {
	const ms = value.getTime();
	return Number.isFinite(ms) ? ms : 0;
}

// ============================================
// Services
// ============================================

export function getServices(): Service[] {
	if (!browser) return [];
	try {
		const data = localStorage.getItem(KEYS.SERVICES);
		if (!data) return [];
		// SECURITY: Validate JSON with Zod schema
		const services = safeJsonParse(data, StatusServiceArraySchema, 'status-services');
		if (!services) return [];
		// Restore Date objects
		return services.map(s => ({
			...s,
			lastCheck: s.lastCheck ? new Date(s.lastCheck) : null,
			createdAt: new Date(s.createdAt)
		})) as Service[];
	} catch {
		return [];
	}
}

export function saveServices(services: Service[]): boolean {
	if (!browser) return false;
	try {
		localStorage.setItem(KEYS.SERVICES, JSON.stringify(services));
		return true;
	} catch {
		return false;
	}
}

export function addService(service: Service): boolean {
	const services = getServices();
	services.push(service);
	return saveServices(services);
}

export function updateService(serviceId: string, updates: Partial<Service>): boolean {
	const services = getServices();
	const index = services.findIndex(s => s.id === serviceId);
	if (index === -1) return false;
	services[index] = { ...services[index], ...updates };
	return saveServices(services);
}

export function deleteService(serviceId: string): boolean {
	const services = getServices();
	const filtered = services.filter(s => s.id !== serviceId);
	// Also clean up related data
	deleteHealthHistory(serviceId);
	deleteIncidents(serviceId);
	deleteAlerts(serviceId);
	return saveServices(filtered);
}

// ============================================
// Health History
// ============================================

export function getHealthHistory(serviceId?: string): HealthCheck[] {
	if (!browser) return [];
	try {
		const data = localStorage.getItem(KEYS.HEALTH_HISTORY);
		if (!data) return [];
		// SECURITY: Validate JSON with Zod schema
		const history = safeJsonParse(data, StatusHealthCheckArraySchema, 'status-health-history');
		if (!history) return [];
		const restored = history.map(h => ({
			...h,
			timestamp: new Date(h.timestamp)
		})) as HealthCheck[];
		if (serviceId) {
			return restored.filter(h => h.serviceId === serviceId);
		}
		return restored;
	} catch {
		return [];
	}
}

export function addHealthCheck(check: HealthCheck): boolean {
	if (!browser) return false;
	try {
		const history = getHealthHistory();
		history.push(check);

		// Trim history per service
		const byService = new Map<string, HealthCheck[]>();
		for (const h of history) {
			const existing = byService.get(h.serviceId) || [];
			existing.push(h);
			byService.set(h.serviceId, existing);
		}

		// Keep only most recent entries per service
		const trimmed: HealthCheck[] = [];
		for (const [, checks] of byService) {
			checks.sort((a, b) => safeTimeMs(b.timestamp) - safeTimeMs(a.timestamp));
			trimmed.push(...checks.slice(0, MAX_HEALTH_HISTORY));
		}

		localStorage.setItem(KEYS.HEALTH_HISTORY, JSON.stringify(trimmed));
		return true;
	} catch {
		return false;
	}
}

export function deleteHealthHistory(serviceId: string): boolean {
	if (!browser) return false;
	try {
		const history = getHealthHistory().filter(h => h.serviceId !== serviceId);
		localStorage.setItem(KEYS.HEALTH_HISTORY, JSON.stringify(history));
		return true;
	} catch {
		return false;
	}
}

// ============================================
// Incidents
// ============================================

export function getIncidents(serviceId?: string): Incident[] {
	if (!browser) return [];
	try {
		const data = localStorage.getItem(KEYS.INCIDENTS);
		if (!data) return [];
		// SECURITY: Validate JSON with Zod schema
		const incidents = safeJsonParse(data, StatusIncidentArraySchema, 'status-incidents');
		if (!incidents) return [];
		const restored = incidents.map(i => ({
			...i,
			startTime: new Date(i.startTime),
			endTime: i.endTime ? new Date(i.endTime) : null
		})) as Incident[];
		if (serviceId) {
			return restored.filter(i => i.serviceId === serviceId);
		}
		return restored;
	} catch {
		return [];
	}
}

export function addIncident(incident: Incident): boolean {
	if (!browser) return false;
	try {
		const incidents = getIncidents();
		incidents.push(incident);

		// Trim incidents per service
		const byService = new Map<string, Incident[]>();
		for (const i of incidents) {
			const existing = byService.get(i.serviceId) || [];
			existing.push(i);
			byService.set(i.serviceId, existing);
		}

		const trimmed: Incident[] = [];
		for (const [, incs] of byService) {
			incs.sort((a, b) => safeTimeMs(b.startTime) - safeTimeMs(a.startTime));
			trimmed.push(...incs.slice(0, MAX_INCIDENTS_PER_SERVICE));
		}

		localStorage.setItem(KEYS.INCIDENTS, JSON.stringify(trimmed));
		return true;
	} catch {
		return false;
	}
}

export function updateIncident(incidentId: string, updates: Partial<Incident>): boolean {
	if (!browser) return false;
	try {
		const incidents = getIncidents();
		const index = incidents.findIndex(i => i.id === incidentId);
		if (index === -1) return false;
		incidents[index] = { ...incidents[index], ...updates };
		localStorage.setItem(KEYS.INCIDENTS, JSON.stringify(incidents));
		return true;
	} catch {
		return false;
	}
}

export function deleteIncidents(serviceId: string): boolean {
	if (!browser) return false;
	try {
		const incidents = getIncidents().filter(i => i.serviceId !== serviceId);
		localStorage.setItem(KEYS.INCIDENTS, JSON.stringify(incidents));
		return true;
	} catch {
		return false;
	}
}

// ============================================
// Alerts
// ============================================

export function getAlerts(serviceId?: string): AlertConfig[] {
	if (!browser) return [];
	try {
		const data = localStorage.getItem(KEYS.ALERTS);
		if (!data) return [];
		// SECURITY: Validate JSON with Zod schema
		const alerts = safeJsonParse(data, StatusAlertConfigArraySchema, 'status-alerts');
		if (!alerts) return [];
		if (serviceId) {
			return (alerts as AlertConfig[]).filter(a => a.serviceId === serviceId);
		}
		return alerts as AlertConfig[];
	} catch {
		return [];
	}
}

export function saveAlert(alert: AlertConfig): boolean {
	if (!browser) return false;
	try {
		const alerts = getAlerts();
		const existingIndex = alerts.findIndex(a => a.id === alert.id);
		if (existingIndex >= 0) {
			alerts[existingIndex] = alert;
		} else {
			alerts.push(alert);
		}
		localStorage.setItem(KEYS.ALERTS, JSON.stringify(alerts));
		return true;
	} catch {
		return false;
	}
}

export function deleteAlerts(serviceId: string): boolean {
	if (!browser) return false;
	try {
		const alerts = getAlerts().filter(a => a.serviceId !== serviceId);
		localStorage.setItem(KEYS.ALERTS, JSON.stringify(alerts));
		return true;
	} catch {
		return false;
	}
}

// ============================================
// Dashboard Stats
// ============================================

export function calculateStats(): DashboardStats {
	const services = getServices();
	const healthy = services.filter(s => s.status === 'healthy').length;
	const degraded = services.filter(s => s.status === 'degraded').length;
	const down = services.filter(s => s.status === 'down').length;

	const responseTimes = services
		.filter(s => s.lastResponseTime !== null)
		.map(s => s.lastResponseTime as number);
	const avgResponseTime =
		responseTimes.length > 0
			? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
			: 0;

	const uptimes = services.map(s => s.uptimePercentage);
	const overallUptime =
		uptimes.length > 0
			? uptimes.reduce((a, b) => a + b, 0) / uptimes.length
			: 100;

	return {
		totalServices: services.length,
		healthyServices: healthy,
		degradedServices: degraded,
		downServices: down,
		averageResponseTime: Math.round(avgResponseTime),
		overallUptime: Math.round(overallUptime * 100) / 100
	};
}

// ============================================
// Settings
// ============================================

export interface DashboardSettings {
	refreshInterval: number;
	showResponseTimes: boolean;
	showUptimeHistory: boolean;
	darkMode: boolean;
}

const DEFAULT_SETTINGS: DashboardSettings = {
	refreshInterval: 30000,
	showResponseTimes: true,
	showUptimeHistory: true,
	darkMode: true
};

export function getSettings(): DashboardSettings {
	if (!browser) return DEFAULT_SETTINGS;
	try {
		const data = localStorage.getItem(KEYS.SETTINGS);
		if (!data) return DEFAULT_SETTINGS;
		// SECURITY: Validate JSON with Zod schema
		const parsed = safeJsonParse(data, DashboardSettingsSchema, 'dashboard-settings');
		if (!parsed) return DEFAULT_SETTINGS;
		return { ...DEFAULT_SETTINGS, ...parsed };
	} catch {
		return DEFAULT_SETTINGS;
	}
}

export function saveSettings(settings: Partial<DashboardSettings>): boolean {
	if (!browser) return false;
	try {
		const current = getSettings();
		const updated = { ...current, ...settings };
		localStorage.setItem(KEYS.SETTINGS, JSON.stringify(updated));
		return true;
	} catch {
		return false;
	}
}

// ============================================
// Data Export/Import
// ============================================

export interface DashboardExport {
	version: number;
	exportedAt: string;
	services: Service[];
	healthHistory: HealthCheck[];
	incidents: Incident[];
	alerts: AlertConfig[];
	settings: DashboardSettings;
}

export function exportData(): DashboardExport {
	return {
		version: 1,
		exportedAt: new Date().toISOString(),
		services: getServices(),
		healthHistory: getHealthHistory(),
		incidents: getIncidents(),
		alerts: getAlerts(),
		settings: getSettings()
	};
}

export function importData(data: DashboardExport): boolean {
	if (!browser) return false;
	try {
		if (data.version !== 1) return false;

		localStorage.setItem(KEYS.SERVICES, JSON.stringify(data.services));
		localStorage.setItem(KEYS.HEALTH_HISTORY, JSON.stringify(data.healthHistory));
		localStorage.setItem(KEYS.INCIDENTS, JSON.stringify(data.incidents));
		localStorage.setItem(KEYS.ALERTS, JSON.stringify(data.alerts));
		localStorage.setItem(KEYS.SETTINGS, JSON.stringify(data.settings));

		return true;
	} catch {
		return false;
	}
}

// ============================================
// Clear All Data
// ============================================

export function clearAllData(): boolean {
	if (!browser) return false;
	try {
		localStorage.removeItem(KEYS.SERVICES);
		localStorage.removeItem(KEYS.HEALTH_HISTORY);
		localStorage.removeItem(KEYS.INCIDENTS);
		localStorage.removeItem(KEYS.ALERTS);
		localStorage.removeItem(KEYS.SETTINGS);
		return true;
	} catch {
		return false;
	}
}
