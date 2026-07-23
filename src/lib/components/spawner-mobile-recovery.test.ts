import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function source(relativePath: string): Promise<string> {
	return readFile(path.join(process.cwd(), relativePath), 'utf8');
}

describe('Spawner mobile and recovery surfaces', () => {
	it('keeps mission creation usable and keyboard-visible on mobile', async () => {
		const builder = await source('src/lib/components/MissionBuilder.svelte');
		const canvas = await source('src/routes/canvas/+page.svelte');

		expect(builder).toContain('aria-label="New task title"');
		expect(builder).toContain('aria-label="Assign task to agent"');
		expect(builder).toContain('text-base focus:border-violet-500');
		expect(builder).toContain('input:focus-visible');
		expect(builder).toContain('Delete "${name}"? This cannot be undone.');
		expect(canvas).toContain('max-h-[90dvh] overflow-y-auto overscroll-contain');
	});

	it('keeps mission state and actions visible on touch surfaces', async () => {
		const live = await source('src/lib/components/MissionLive.svelte');
		const list = await source('src/routes/missions/+page.svelte');
		const board = await source('src/lib/components/MissionBoard.svelte');

		expect(live).toContain('text-[10px] sm:text-xs');
		expect(list).toContain('[@media(hover:hover)]:opacity-0');
		expect(board).toContain('sticky top-[52px]');
	});

	it('announces resumable work and renders every memory warning', async () => {
		const resume = await source('src/lib/components/ExecutionResumeBanner.svelte');
		const memory = await source('src/routes/memory-dashboard/+page.svelte');

		expect(resume).toContain('role="status"');
		expect(resume).toContain('aria-live="polite"');
		expect(resume).toContain('truncate max-w-[24ch]');
		expect(resume).toContain('Continue mission ${mission.name}');
		expect(memory).toContain('{#each data.dataset.warnings as warning}');
	});

	it('disposes delayed canvas-sync callbacks during cleanup', async () => {
		const sync = await source('src/lib/services/canvas-sync.ts');

		expect(sync).toContain('initialBroadcastTimer');
		expect(sync).toContain('processingResetTimers');
		expect(sync).toContain('processingResetTimers.clear()');
		expect(sync).toContain('isProcessing = false');
	});
});
