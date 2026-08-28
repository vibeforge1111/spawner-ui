// safety: input validation
/**
 * Test Setup
 *
 * Global test configuration and mocks
 */

import { vi, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Tests must never inherit a developer's live Spark state or workspace roots.
// Individual suites can still replace these paths with narrower temp fixtures.
const testRuntimeRoot = process.env.SPARK_VITEST_RUNTIME_ROOT?.trim() ||
	path.join(tmpdir(), `spark-spawner-vitest-${process.pid}-${process.env.VITEST_POOL_ID || '0'}`);
process.env.SPAWNER_STATE_DIR = path.join(testRuntimeRoot, 'state');
process.env.SPARK_HOME = path.join(testRuntimeRoot, 'home');
process.env.SPARK_WORKSPACE_ROOT = path.join(testRuntimeRoot, 'workspaces');
process.env.SPAWNER_WORKSPACE_ROOT = process.env.SPARK_WORKSPACE_ROOT;
delete process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;

// Mock localStorage
const localStorageMock = {
	getItem: vi.fn(),
	setItem: vi.fn(),
	removeItem: vi.fn(),
	clear: vi.fn(),
	length: 0,
	key: vi.fn()
};
vi.stubGlobal('localStorage', localStorageMock);

// Mock fetch for API calls
vi.stubGlobal('fetch', vi.fn());

// Reset mocks between tests
beforeEach(() => {
	vi.clearAllMocks();
	localStorageMock.getItem.mockReturnValue(null);
});
