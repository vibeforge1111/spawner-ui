import os from 'node:os';
import path from 'node:path';
import { repairPrdTraceProofContinuity } from '../src/lib/server/prd-trace-proof-continuity';

function argValue(args: string[], name: string): string | null {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? null : args[index + 1] || null;
}

function hasFlag(args: string[], name: string): boolean {
	return args.includes(`--${name}`);
}

function defaultStateDir(): string {
	const explicit = process.env.SPAWNER_STATE_DIR?.trim();
	if (explicit) return explicit;
	const sparkHome = process.env.SPARK_HOME?.trim() || path.join(os.homedir(), '.spark');
	return path.join(sparkHome, 'state', 'spawner-ui');
}

function usage(): string {
	return [
		'Repair Spawner PRD trace proof continuity',
		'',
		'Usage:',
		'  npm run trace:repair:prd-proof -- --json',
		'  npm run trace:repair:prd-proof -- --apply',
		'  npm run trace:repair:prd-proof -- --apply --backup',
		'  npm run trace:repair:prd-proof -- --trace /path/prd-auto-trace.jsonl',
		'',
		'Runs as a dry-run unless --apply is supplied. Adds explicit legacy gap capsules, never synthetic positive proof.'
	].join('\n');
}

function main(): void {
	const args = process.argv.slice(2);
	if (hasFlag(args, 'help')) {
		console.log(usage());
		return;
	}
	const tracePath = path.resolve(
		argValue(args, 'trace') || path.join(argValue(args, 'state-dir') || defaultStateDir(), 'prd-auto-trace.jsonl')
	);
	const apply = hasFlag(args, 'apply');
	const result = repairPrdTraceProofContinuity({
		tracePath,
		dryRun: !apply,
		backup: apply && hasFlag(args, 'backup')
	});
	if (hasFlag(args, 'json')) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}
	console.log([
		'Spawner PRD trace proof repair',
		`Mode: ${result.dryRun ? 'dry-run' : 'apply'}`,
		`Rows read: ${result.rowsRead}`,
		`Rows written: ${result.rowsWritten}`,
		`Parse errors: ${result.parseErrors}`,
		`Gap capsules added: ${result.gapCapsulesAdded}`,
		`Already had proof: ${result.alreadyHadProof}`,
		`Changed rows: ${result.changedRows}`,
		`Backup: ${result.backupPath || 'none'}`
	].join('\n'));
	process.exitCode = result.ok || result.error === 'trace_log_missing' ? 0 : 1;
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
