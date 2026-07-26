import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function source(path: string): Promise<string> {
	return readFile(new URL(path, import.meta.url), 'utf8');
}

describe('operator-facing component defaults', () => {
	it('does not ship a private Telegram chat id or machine-specific project path', async () => {
		const [board, executionPanel] = await Promise.all([
			source('./MissionBoard.svelte'),
			source('./ExecutionPanel.svelte')
		]);

		expect(board).toContain("let newChatId = $state('');");
		expect(board).not.toContain("let newChatId = $state('8319079055');");
		expect(executionPanel).toContain("let projectPath = $state('');");
		expect(executionPanel).not.toContain('C:/Users/USER/Desktop/vibeship-spark-intelligence');
	});

	it('guides an empty-board user through the visible mission controls', async () => {
		const board = await source('./MissionBoard.svelte');

		expect(board).toContain(
			'No missions yet. Start a mission from the Canvas, or type your goal in the New Mission box above.'
		);
		expect(board).not.toContain('fire <code');
	});
});
