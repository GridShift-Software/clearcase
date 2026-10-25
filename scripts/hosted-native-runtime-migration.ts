/// <reference types="node" />
// Offline prepare/verify only; never invokes Wrangler or a provider.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareNativeRuntimeMigration, readNativeRuntimeMigration } from '../deploy/native-alpha/runtime-migration.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const [command, stage] = args;
if (args.length !== 2 || !stage || stage.startsWith('-') || !['prepare', 'verify'].includes(command ?? '')) {
	console.error('Usage: bun scripts/hosted-native-runtime-migration.ts <prepare|verify> <stage-directory> (offline only)');
	process.exitCode = 2;
} else {
	try {
		const result = command === 'prepare'
			? prepareNativeRuntimeMigration({ root, out: path.resolve(stage) })
			: readNativeRuntimeMigration({ root, stage: path.resolve(stage) });
		console.log(result.manifestText.trimEnd());
	} catch (error) {
		console.error(error instanceof Error ? error.message : 'runtime migration refused');
		process.exitCode = 1;
	}
}
