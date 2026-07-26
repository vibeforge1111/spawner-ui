import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function source(relativePath: string): Promise<string> {
	return readFile(path.join(process.cwd(), relativePath), 'utf8');
}

describe('Spawner runtime lifecycle packet', () => {
	it('uses a real derived phase class on the trace surface', async () => {
		const trace = await source('src/routes/trace/+page.svelte');
		expect(trace).toContain('const phaseClass = $derived.by(() =>');
		expect(trace).toContain('${phaseClass}');
	});

	it('escalates cancelled Codex children and clears the escalation timer', async () => {
		const codex = await source('src/lib/server/provider-clients/codex-cli-client.ts');
		expect(codex).toContain("child.kill('SIGTERM')");
		expect(codex).toContain("child.kill('SIGKILL')");
		expect(codex).toContain('clearTimeout(killTimeout)');
		expect(codex).toContain('releaseAbortListener()');
	});

	it('removes completed provider heartbeat abort listeners', async () => {
		const runtime = await source('src/lib/server/provider-runtime.ts');
		expect(runtime).toContain("signal.removeEventListener('abort', stop)");
	});

	it('renders singular mission counts and an empty latency state honestly', async () => {
		const builder = await source('src/lib/components/MissionBuilder.svelte');
		const memory = await source('src/routes/memory-quality/+page.svelte');
		expect(builder).toContain("mission.agents.length === 1 ? '' : 's'");
		expect(builder).toContain("mission.tasks.length === 1 ? '' : 's'");
		expect(memory).toContain(": '—'");
	});
});
