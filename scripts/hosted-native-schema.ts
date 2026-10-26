/// <reference types="node" />
// Offline CLI only. Execution/provisioning stays with the integration owner.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareNativeSchema, readNativeSchema } from '../deploy/native-alpha/schema.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const [command, stage] = args;
if (args.length !== 2 || !stage || stage.startsWith('-') || !['prepare', 'verify'].includes(command ?? '')) {
	console.error('Usage: bun scripts/hosted-native-schema.ts <prepare|verify> <stage-directory> (offline only)');
	process.exitCode = 2;
} else {
	try {
		const result = command === 'prepare'
			? prepareNativeSchema({ root, out: path.resolve(stage) })
			: readNativeSchema({ root, stage: path.resolve(stage) });
		console.log(result.manifestText.trimEnd());
	} catch (error) {
		console.error(error instanceof Error ? error.message : 'schema preparation refused');
		process.exitCode = 1;
	}
}
