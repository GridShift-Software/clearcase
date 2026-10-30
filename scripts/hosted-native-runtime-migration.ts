/// <reference types="node" />
// Offline prepare/verify only; never invokes Wrangler or a provider.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as packets from '../deploy/native-alpha/runtime-migration.ts';

// The runtime packet takes no mode; each later increment is named by its own mode and nothing else.
const INCREMENTS = new Map<string, (typeof packets.NATIVE_MIGRATION_SEQUENCE)[number]>(
	packets.NATIVE_MIGRATION_SEQUENCE.flatMap(packet => packet.mode === null ? [] : [[packet.mode, packet] as const]));

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const [command, stage, mode] = args;
const selected = mode === undefined ? packets.NATIVE_MIGRATION_SEQUENCE[0] : INCREMENTS.get(mode);
if ((args.length !== 2 && args.length !== 3) || !stage || stage.startsWith('-') || !['prepare', 'verify'].includes(command ?? '')
	|| !selected) {
	console.error(`Usage: bun scripts/hosted-native-runtime-migration.ts <prepare|verify> <stage-directory> [${[...INCREMENTS.keys()].join('|')}] (offline only)`);
	process.exitCode = 2;
} else {
	try {
		const { prepare, read } = selected;
		const result = command === 'prepare' ? prepare({ root, out: path.resolve(stage) }) : read({ root, stage: path.resolve(stage) });
		console.log(result.manifestText.trimEnd());
	} catch (error) {
		console.error(error instanceof Error ? error.message : 'runtime migration refused');
		process.exitCode = 1;
	}
}
