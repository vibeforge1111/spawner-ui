/**
 * Persistence Service
 *
 * Centralized localStorage management with:
 * - Data versioning for schema migrations
 * - Error recovery for corrupted data
 * - Automatic backups before destructive operations
 * - Storage quota monitoring
 */

import { browser } from '$app/environment';
import type { Mission, MissionLog } from '$lib/services/mcp-client';
import { BackupDataSchema, MissionStateSchema, safeJsonParse } from '$lib/types/schemas';
import { parseJsonOrFallback } from '$lib/utils/safe-json';
import type {
	MultiLLMExecutionPack,
	MultiLLMOrchestratorOptions
} from './multi-llm-orchestrator';
import { logger } from '$lib/utils/logger';

const log = logger.scope('Persistence');

// Current schema version - increment when data structure changes
const SCHEMA_VERSION = 1;
const VERSION_KEY = 'spawner-schema-version';

// All spawner localStorage keys
export const STORAGE_KEYS = {
	VERSION: VERSION_KEY,
	PIPELINES: 'spawner-pipelines',
	CURRENT_PIPELINE: 'spawner-current-pipeline',
	GENERATED_SKILLS: 'spawner-generated-skills',
	MCP_URL: 'mcp-url',
	// Mission execution state
	ACTIVE_MISSION: 'spawner-active-mission',
	MISSION_HISTORY: 'spawner-mission-history',
} as const;

export interface StorageStats {
	totalSize: number;
	totalSizeFormatted: string;
	itemCount: number;
	items: { key: string; size: number; sizeFormatted: string }[];
	quotaUsed: number; // percentage
}

// ============================================
// Core Functions
// ============================================

/**
 * Safely get item from localStorage with JSON parsing
 */
export function getItem<T>(key: string, defaultValue: T): T {
	if (!browser) return defaultValue;

	try {
		const item = localStorage.getItem(key);
		if (item === null) return defaultValue;

		return parseJsonOrFallback<T>(item, defaultValue, `local-storage:${key}`);
	} catch (e) {
		log.error(`Failed to parse ${key}:`, e);
		// Return default but don't delete - let user decide
		return defaultValue;
	}
}

/**
 * Safely set item in localStorage with JSON stringification
 */
export function setItem<T>(key: string, value: T): boolean {
	if (!browser) return false;

	try {
		localStorage.setItem(key, JSON.stringify(value));
		return true;
	} catch (e) {
		if (e instanceof DOMException && e.name === 'QuotaExceededError') {
			log.error('Storage quota exceeded');
			// Could trigger cleanup of old data here
		} else {
			log.error(`Failed to save ${key}:`, e);
		}
		return false;
	}
}

/**
 * Remove item from localStorage
 */
export function removeItem(key: string): boolean {
	if (!browser) return false;

	try {
		localStorage.removeItem(key);
		return true;
	} catch (e) {
		log.error(`Failed to remove ${key}:`, e);
		return false;
	}
}

// ============================================
// Schema Versioning & Migration
// ============================================

/**
 * Get current schema version from storage
 */
export function getStoredVersion(): number {
	if (!browser) return SCHEMA_VERSION;

	const stored = localStorage.getItem(VERSION_KEY);
	if (!stored) return 0; // No version = first run or legacy data

	const version = parseInt(stored, 10);
	return isNaN(version) ? 0 : version;
}

/**
 * Set schema version
 */
export function setStoredVersion(version: number): void {
	if (!browser) return;
	localStorage.setItem(VERSION_KEY, version.toString());
}

/**
 * Run migrations if schema version changed
 */
export function runMigrations(): { migrated: boolean; fromVersion: number; toVersion: number } {
	if (!browser) return { migrated: false, fromVersion: SCHEMA_VERSION, toVersion: SCHEMA_VERSION };

	const storedVersion = getStoredVersion();

	if (storedVersion >= SCHEMA_VERSION) {
		return { migrated: false, fromVersion: storedVersion, toVersion: SCHEMA_VERSION };
	}

	log.info(`Migrating from v${storedVersion} to v${SCHEMA_VERSION}`);

	// Run migrations in sequence
	let currentVersion = storedVersion;

	// Migration 0 -> 1: Initial schema (no changes needed for fresh installs)
	if (currentVersion < 1) {
		// No migration needed for v1 - it's the initial version
		// Future migrations would go here:
		// migrateTo1();
		currentVersion = 1;
	}

	// Future migrations:
	// if (currentVersion < 2) {
	//   migrateTo2();
	//   currentVersion = 2;
	// }

	setStoredVersion(SCHEMA_VERSION);

	return { migrated: currentVersion !== storedVersion, fromVersion: storedVersion, toVersion: SCHEMA_VERSION };
}

// ============================================
// Storage Stats & Monitoring
// ============================================

/**
 * Get detailed storage statistics
 */
export function getStorageStats(): StorageStats {
	if (!browser) {
		return {
			totalSize: 0,
			totalSizeFormatted: '0 B',
			itemCount: 0,
			items: [],
			quotaUsed: 0
		};
	}

	const items: { key: string; size: number; sizeFormatted: string }[] = [];
	let totalSize = 0;

	for (const key of Object.keys(localStorage)) {
		if (key.startsWith('spawner-') || key === 'mcp-url') {
			const value = localStorage.getItem(key) || '';
			const size = (key.length + value.length) * 2; // UTF-16
			totalSize += size;
			items.push({
				key,
				size,
				sizeFormatted: formatBytes(size)
			});
		}
	}

	// Sort by size descending
	// NOTE: .sort() mutates the input array. Use .toSorted() (ES2023) or `[...arr].sort()` to avoid surprising callers. The function signature doesn't suggest in-place sort.
	items.sort((a, b) => b.size - a.size);

	// Estimate quota (5MB is typical)
	const estimatedQuota = 5 * 1024 * 1024;
	const quotaUsed = (totalSize / estimatedQuota) * 100;

	return {
		totalSize,
		totalSizeFormatted: formatBytes(totalSize),
		itemCount: items.length,
		items,
		quotaUsed: Math.min(100, quotaUsed)
	};
}

/**
 * Format bytes to human readable
 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ============================================
// Backup & Recovery
// ============================================

/**
 * Create a backup of all spawner data
 */
export function createBackup(): string | null {
	if (!browser) return null;

	const backup: Record<string, unknown> = {
		_version: SCHEMA_VERSION,
		_timestamp: new Date().toISOString(),
	};

	for (const key of Object.keys(localStorage)) {
		if (key.startsWith('spawner-') || key === 'mcp-url') {
			try {
				const value = localStorage.getItem(key);
				if (value) {
					backup[key] = JSON.parse(value);
				}
			} catch {
				// Store as string if not JSON
				backup[key] = localStorage.getItem(key);
			}
		}
	}

	return JSON.stringify(backup, null, 2);
}

/**
 * Restore from a backup
 */
export function restoreBackup(backupJson: string): { success: boolean; error?: string; itemsRestored: number } {
	if (!browser) {
		return { success: false, error: 'Not in browser', itemsRestored: 0 };
	}

	try {
		// SECURITY: Validate JSON with Zod schema
		const backup = safeJsonParse(backupJson, BackupDataSchema, 'backup-restore');
		if (!backup) {
			return { success: false, error: 'Invalid backup format', itemsRestored: 0 };
		}
		let itemsRestored = 0;

		for (const [key, value] of Object.entries(backup)) {
			if (key.startsWith('_')) continue; // Skip metadata

			if (key.startsWith('spawner-') || key === 'mcp-url') {
				localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
				itemsRestored++;
			}
		}

		return { success: true, itemsRestored };
	} catch (e) {
		return {
			success: false,
			error: e instanceof Error ? e.message : 'Invalid backup format',
			itemsRestored: 0
		};
	}
}

/**
 * Export backup as downloadable file
 */
export function downloadBackup(): void {
	if (!browser) return;

	const backup = createBackup();
	if (!backup) return;

	const blob = new Blob([backup], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `spawner-backup-${new Date().toISOString().slice(0, 10)}.json`;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

// ============================================
// Mission State Persistence
// ============================================

// Define types locally to avoid circular dependency with mission-executor
type ExecutionStatus = 'idle' | 'creating' | 'running' | 'paused' | 'completed' | 'partial' | 'failed' | 'cancelled';

interface TaskProgress {
	taskId: string;
	taskName: string;
	progress: number;
	message?: string;
	startedAt: number;
}

// H70 Skill info for persistence
interface LoadedSkillInfo {
	id: string;
	name: string;
	description?: string;
	taskIds: string[];
}

/**
 * Serializable version of ExecutionProgress
 * (Map is not JSON-serializable, so we convert it)
 */
export interface PersistedMissionState {
	status: ExecutionStatus;
	missionId: string | null;
	mission: Mission | null;
	executionPrompt: string | null;
	multiLLMOptions?: MultiLLMOrchestratorOptions;
	multiLLMExecution?: MultiLLMExecutionPack | null;
	progress: number;
	currentTaskId: string | null;
	currentTaskName: string | null;
	currentTaskProgress: number;
	currentTaskMessage: string | null;
	taskProgressMap: Record<string, TaskProgress>;  // Object instead of Map
	logs: MissionLog[];
	startTime: string | null;  // ISO string instead of Date
	endTime: string | null;
	error: string | null;
	// H70 Skills
	loadedSkills?: LoadedSkillInfo[];  // Skills loaded for this mission
	taskSkillMap?: Record<string, string[]>;  // Object instead of Map
	// Post-completion verification
	reconciliation?: {
		totalTasks: number;
		completedTasks: number;
		failedTasks: number;
		pendingTasks: Array<{ id: string; title: string; status: string }>;
		verdict: 'complete' | 'mostly_done' | 'incomplete';
	} | null;
	checkpoint?: unknown | null;  // ProjectCheckpoint — avoid circular import
	// Metadata for recovery
	savedAt: string;
	version: number;
}

/**
 * Mission history entry for showing recent missions
 */
export interface MissionHistoryEntry {
	id: string;
	name: string;
	status: ExecutionStatus;
	progress: number;
	startTime: string;
	endTime: string | null;
	taskCount: number;
	completedTasks: number;
}

// IMPORTANT: Increment this when mission state format changes
// Version 2: Just-in-time skill loading - executionPrompt should be ~200 lines, not 20,000+
// Version 3: Added Multi-LLM orchestrator state
const MISSION_STATE_VERSION = 3;
const MAX_HISTORY_ENTRIES = 10;
const MAX_VALID_PROMPT_LENGTH = 10000; // ~200-300 lines max for just-in-time prompt

/**
 * Save active mission state to localStorage
 */
export function saveMissionState(state: PersistedMissionState): boolean {
	return setItem(STORAGE_KEYS.ACTIVE_MISSION, {
		...state,
		savedAt: new Date().toISOString(),
		version: MISSION_STATE_VERSION
	});
}

/**
 * Get active mission state from localStorage
 */
export function getActiveMissionState(): PersistedMissionState | null {
	const state = getItem<PersistedMissionState | null>(STORAGE_KEYS.ACTIVE_MISSION, null);
	log.debug('getActiveMissionState - raw state:', state?.status, 'missionId:', state?.missionId);

	if (!state) return null;

	// Validate version - clear old format data
	if (state.version !== MISSION_STATE_VERSION) {
		log.debug('Mission state version mismatch (got v' + state.version + ', expected v' + MISSION_STATE_VERSION + '), clearing');
		clearMissionState();
		return null;
	}

	// CRITICAL: Check if executionPrompt is too large (indicates old format with full skill content)
	// The new just-in-time format should be ~200 lines max, not 20,000+
	if (state.executionPrompt && state.executionPrompt.length > MAX_VALID_PROMPT_LENGTH) {
		log.debug('Detected old-format executionPrompt (' + state.executionPrompt.length + ' chars), clearing');
		log.debug('Old prompts with full skill content crash terminals - clearing to force regeneration');
		clearMissionState();
		return null;
	}

	// Check if mission is still active (not completed/failed/cancelled)
	if (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled') {
		log.debug('Mission is completed/failed/cancelled, moving to history');
		// Move to history and clear active
		addToMissionHistory(state);
		clearMissionState();
		return null;
	}

	log.debug('Returning active mission state');
	return state;
}

/**
 * Clear active mission state
 */
export function clearMissionState(): boolean {
	return removeItem(STORAGE_KEYS.ACTIVE_MISSION);
}

/**
 * Add completed mission to history
 */
export function addToMissionHistory(state: PersistedMissionState): boolean {
	if (!state.mission) return false;

	const history = getMissionHistory();

	const entry: MissionHistoryEntry = {
		id: state.missionId || state.mission.id,
		name: state.mission.name,
		status: state.status,
		progress: state.progress,
		startTime: state.startTime || new Date().toISOString(),
		endTime: state.endTime,
		taskCount: state.mission.tasks?.length || 0,
		completedTasks: state.mission.tasks?.filter(t => t.status === 'completed').length || 0
	};

	// Add to front, limit history size
	const newHistory = [entry, ...history.filter(h => h.id !== entry.id)].slice(0, MAX_HISTORY_ENTRIES);

	return setItem(STORAGE_KEYS.MISSION_HISTORY, newHistory);
}

/**
 * Get mission history
 */
export function getMissionHistory(): MissionHistoryEntry[] {
	return getItem<MissionHistoryEntry[]>(STORAGE_KEYS.MISSION_HISTORY, []);
}

/**
 * Clear mission history
 */
export function clearMissionHistory(): boolean {
	return removeItem(STORAGE_KEYS.MISSION_HISTORY);
}

/**
 * Check if there's a resumable mission
 */
export function hasResumableMission(): boolean {
	const state = getItem<PersistedMissionState | null>(STORAGE_KEYS.ACTIVE_MISSION, null);
	log.debug('hasResumableMission - state:', state?.status, 'missionId:', state?.missionId);
	if (!state) return false;

	// Check for version mismatch - don't resume old format data
	if (state.version !== MISSION_STATE_VERSION) {
		log.debug('Version mismatch, not resumable');
		return false;
	}

	// Check for huge prompt (old format) - don't resume, it would crash terminal
	if (state.executionPrompt && state.executionPrompt.length > MAX_VALID_PROMPT_LENGTH) {
		log.debug('Huge prompt detected, not resumable');
		return false;
	}

	// Resumable if paused, running (interrupted), creating, or partial (incomplete tasks)
	const isResumable = state.status === 'paused' || state.status === 'running' || state.status === 'creating' || state.status === 'partial';
	log.debug('isResumable:', isResumable);
	return isResumable;
}

// ============================================
// Data Validation
// ============================================

/**
 * Validate pipeline data structure
 */
export function validatePipelineData(data: unknown): boolean {
	if (!Array.isArray(data)) return false;

	for (const pipeline of data) {
		if (typeof pipeline !== 'object' || pipeline === null) return false;
		if (typeof pipeline.id !== 'string') return false;
		if (typeof pipeline.name !== 'string') return false;
	}

	return true;
}

/**
 * Validate generated skills data structure
 */
export function validateGeneratedSkillsData(data: unknown): boolean {
	if (!Array.isArray(data)) return false;

	for (const skill of data) {
		if (typeof skill !== 'object' || skill === null) return false;
		if (typeof skill.id !== 'string') return false;
		if (!skill.id.startsWith('generated-')) return false;
		if (typeof skill.name !== 'string') return false;
	}

	return true;
}

// ============================================
// Initialization
// ============================================

/**
 * Force clear old mission state with huge prompts
 * This fixes the terminal crash issue from old prompts with full skill content
 */
export function clearOldMissionState(): { cleared: boolean; reason?: string } {
	if (!browser) return { cleared: false };

	const raw = localStorage.getItem(STORAGE_KEYS.ACTIVE_MISSION);
	if (!raw) return { cleared: false };

	try {
		// SECURITY: Validate JSON with Zod schema
		const state = safeJsonParse(raw, MissionStateSchema, 'mission-state-check');
		if (!state) {
			// Corrupted or invalid data, clear it
			log.debug('Clearing invalid mission state');
			clearMissionState();
			return { cleared: true, reason: 'Invalid data format' };
		}

		// Check for version mismatch
		if (state.version !== MISSION_STATE_VERSION) {
			log.debug(`Clearing old mission state (v${state.version} -> v${MISSION_STATE_VERSION})`);
			clearMissionState();
			return { cleared: true, reason: `Version mismatch: v${state.version}` };
		}

		// Check for huge prompt (old format with full skill content)
		if (state.executionPrompt && state.executionPrompt.length > MAX_VALID_PROMPT_LENGTH) {
			log.debug(`Clearing old mission state with huge prompt (${state.executionPrompt.length} chars)`);
			clearMissionState();
			return { cleared: true, reason: `Huge prompt: ${state.executionPrompt.length} chars` };
		}

		return { cleared: false };
	} catch {
		// Corrupted data, clear it
		log.debug('Clearing corrupted mission state');
		clearMissionState();
		return { cleared: true, reason: 'Corrupted data' };
	}
}

/**
 * Initialize persistence system
 * Call this on app startup
 */
export function initPersistence(): {
	migrated: boolean;
	fromVersion: number;
	toVersion: number;
	stats: StorageStats;
	missionStateCleared?: { cleared: boolean; reason?: string };
} {
	if (!browser) {
		return {
			migrated: false,
			fromVersion: SCHEMA_VERSION,
			toVersion: SCHEMA_VERSION,
			stats: {
				totalSize: 0,
				totalSizeFormatted: '0 B',
				itemCount: 0,
				items: [],
				quotaUsed: 0
			}
		};
	}

	// Run any pending migrations
	const migration = runMigrations();

	// CRITICAL: Clear old mission state with huge prompts (fixes terminal crash)
	const missionStateCleared = clearOldMissionState();

	// Get current stats
	const stats = getStorageStats();

	// Log initialization
	log.info(`Initialized (v${SCHEMA_VERSION}), using ${stats.totalSizeFormatted}`);

	if (migration.migrated) {
		log.info(`Migrated from v${migration.fromVersion} to v${migration.toVersion}`);
	}

	if (missionStateCleared.cleared) {
		log.info(`Cleared old mission state: ${missionStateCleared.reason}`);
	}

	return {
		...migration,
		stats,
		missionStateCleared
	};
}
