import { describe, expect, it } from 'vitest';
import { parseCodexCliCommand, persistCodexPrompt } from './codex-cli-client';

describe('parseCodexCliCommand', () => {
	it('adds skip-git-repo-check for model-based Codex exec commands', () => {
		expect(parseCodexCliCommand('codex exec --model gpt-5.5')).toEqual({
			binary: 'codex',
			args: ['exec', '--skip-git-repo-check', '--model', 'gpt-5.5']
		});
	});

	it('adds skip-git-repo-check for yolo Codex exec commands', () => {
		expect(parseCodexCliCommand('codex exec --yolo', { allowHighAgency: true })).toEqual({
			binary: 'codex',
			args: ['exec', '--skip-git-repo-check', '--yolo']
		});
	});
});

describe('persistCodexPrompt', () => {
	it('creates the prompt directory and writes the prompt', () => {
		const calls: string[] = [];
		expect(
			persistCodexPrompt('/state/prompts', '/state/prompts/m1-codex.md', 'private prompt', {
				exists: () => false,
				mkdir: (path) => calls.push(`mkdir:${path}`),
				write: (path, value) => calls.push(`write:${path}:${value}`)
			})
		).toBe(true);
		expect(calls).toEqual([
			'mkdir:/state/prompts',
			'write:/state/prompts/m1-codex.md:private prompt'
		]);
	});

	it('turns persistence failures into a bounded false result', () => {
		expect(
			persistCodexPrompt('/private/state', '/private/state/prompt.md', 'private prompt', {
				exists: () => true,
				mkdir: () => {},
				write: () => {
					throw new Error('/private/state is full');
				}
			})
		).toBe(false);
	});
});
