/**
 * Health Checker Service
 * Handles health check polling with timeout handling and adaptive intervals
 */

import type { Service, HealthCheck, ServiceStatus, PollingConfig, DEFAULT_POLLING_CONFIG } from '$lib/types/dashboard';

export interface CheckResult {
	status: ServiceStatus;
	responseTime: number;
	error?: string;
}

/**
 * Perform a health check on a service endpoint
 */
export async function checkServiceHealth(
	url: string,
	timeout: number = 10000
): Promise<CheckResult> {
	const startTime = performance.now();
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeout);

	try {
		const response = await fetch(url, {
			method: 'GET',
			signal: controller.signal,
			headers: {
				'Accept': 'application/json',
			},
		});

		clearTimeout(timeoutId);
		const responseTime = Math.round(performance.now() - startTime);

		if (response.ok) {
			return {
				status: 'healthy',
				responseTime,
			};
		} else if (response.status >= 500) {
			return {
				status: 'down',
				responseTime,
				error: `Server error: ${response.status}`,
			};
		} else {
			return {
				status: 'degraded',
				responseTime,
				error: `HTTP ${response.status}`,
			};
		}
	} catch (error) {
		clearTimeout(timeoutId);
		const responseTime = Math.round(performance.now() - startTime);

		if (error instanceof Error) {
			if (error.name === 'AbortError') {
				return {
					status: 'down',
					responseTime: timeout,
					error: 'Request timeout',
				};
			}
			// CORS errors, network errors, etc.
			return {
				status: 'down',
				responseTime,
				error: error.message,
			};
		}

		return {
			status: 'down',
			responseTime,
			error: 'Unknown error',
		};
	}
}

/**
 * Get adaptive polling interval based on service status
 */
export function getPollingInterval(
	status: ServiceStatus,
	config: PollingConfig = {
		defaultInterval: 30000,
		healthyInterval: 30000,
		degradedInterval: 15000,
		downInterval: 5000
	}
): number {
	switch (status) {
		case 'healthy':
			return config.healthyInterval;
		case 'degraded':
			return config.degradedInterval;
		case 'down':
			return config.downInterval;
		default:
			return config.defaultInterval;
	}
}

/**
 * Create a health check record
 */
export function createHealthCheck(
	serviceId: string,
	result: CheckResult
): HealthCheck {
	return {
		id: `check-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
		serviceId,
		status: result.status,
		responseTime: result.responseTime,
		timestamp: new Date(),
		error: result.error,
	};
}

/**
 * Calculate uptime percentage from health checks
 */
export function calculateUptime(checks: HealthCheck[]): number {
	if (checks.length === 0) return 100;

	const healthyChecks = checks.filter(c => c.status === 'healthy').length;
	return Math.round((healthyChecks / checks.length) * 100 * 100) / 100;
}

/**
 * Calculate average response time from health checks
 */
export function calculateAverageResponseTime(checks: HealthCheck[]): number {
	if (checks.length === 0) return 0;

	const totalTime = checks.reduce((sum, c) => sum + c.responseTime, 0);
	return Math.round(totalTime / checks.length);
}

/**
 * Health Checker Manager - handles polling for multiple services
 */
export class HealthCheckerManager {
	private intervals: Map<string, ReturnType<typeof setInterval>> = new Map();
	private intervalMs: Map<string, number> = new Map();
	private onCheck: ((serviceId: string, result: CheckResult) => void) | null = null;

	/**
	 * Set callback for health check results
	 */
	setOnCheck(callback: (serviceId: string, result: CheckResult) => void): void {
		this.onCheck = callback;
	}

	/**
	 * Start polling a service
	 */
	startPolling(service: Service, config?: PollingConfig): void {
		// Stop existing polling for this service
		this.stopPolling(service.id);

		const poll = async () => {
			const result = await checkServiceHealth(service.url);
			this.onCheck?.(service.id, result);

			// Adjust interval based on new status (adaptive polling). Only swap
			// the underlying interval when the cadence actually changes; the
			// previous implementation rebuilt the timer on every poll cycle even
			// when status was steady, churning clearInterval + setInterval each
			// tick for no behavior change.
			const newInterval = getPollingInterval(result.status, config);
			const currentInterval = this.intervals.get(service.id);
			const currentMs = this.intervalMs.get(service.id);

			if (currentInterval && currentMs !== newInterval) {
				this.stopPolling(service.id);
				const intervalId = setInterval(poll, newInterval);
				this.intervals.set(service.id, intervalId);
				this.intervalMs.set(service.id, newInterval);
			}
		};

		// Initial check
		poll();

		// Set up interval
		const interval = getPollingInterval(service.status, config);
		const intervalId = setInterval(poll, interval);
		this.intervals.set(service.id, intervalId);
		this.intervalMs.set(service.id, interval);
	}

	/**
	 * Stop polling a service
	 */
	stopPolling(serviceId: string): void {
		const intervalId = this.intervals.get(serviceId);
		if (intervalId) {
			clearInterval(intervalId);
			this.intervals.delete(serviceId);
		}
		this.intervalMs.delete(serviceId);
	}

	/**
	 * Stop all polling
	 */
	stopAll(): void {
		for (const [serviceId] of this.intervals) {
			this.stopPolling(serviceId);
		}
	}

	/**
	 * Check if polling is active for a service
	 */
	isPolling(serviceId: string): boolean {
		return this.intervals.has(serviceId);
	}
}

// Singleton instance
export const healthChecker = new HealthCheckerManager();
