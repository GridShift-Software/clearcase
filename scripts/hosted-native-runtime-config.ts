/// <reference types="node" />
// Offline prepare/verify only; never reads the environment or a credential file, and never invokes a subprocess or provider.
import { loadNativeRuntimeConfigInput, nativeRuntimeConfigDiagnostic, prepareNativeRuntimeConfig, readNativeRuntimeConfig } from '../deploy/native-alpha/runtime-config.ts';

const args = process.argv.slice(2);
const [command, inputFile, stage] = args;
if (args.length !== 3 || !inputFile || !stage || inputFile.startsWith('-') || stage.startsWith('-') || !['prepare', 'verify'].includes(command ?? '')) {
	console.error('Usage: bun scripts/hosted-native-runtime-config.ts <prepare|verify> </absolute/input.json> </absolute/new-stage-directory> (offline only)');
	process.exitCode = 2;
} else {
	try {
		const input = loadNativeRuntimeConfigInput(inputFile);
		const result = command === 'prepare' ? prepareNativeRuntimeConfig({ input, out: stage }) : readNativeRuntimeConfig({ input, stage });
		console.log(result.manifestText.trimEnd());
	} catch (error) {
		// Only a message this module issued is shown; a foreign thrown value is never read.
		console.error(nativeRuntimeConfigDiagnostic(error) ?? 'runtime config refused');
		process.exitCode = 1;
	}
}
