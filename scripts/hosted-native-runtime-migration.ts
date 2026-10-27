/// <reference types="node" />
// Offline prepare/verify only; never invokes Wrangler or a provider.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as packets from '../deploy/native-alpha/runtime-migration.ts';

// The runtime packet takes no mode; each later increment is named by its own mode and nothing else.
const INCREMENTS = {
	[packets.NATIVE_RENDER_CASE_LIMIT_MIGRATION_MODE]: [packets.prepareNativeRenderCaseLimitMigration, packets.readNativeRenderCaseLimitMigration],
	[packets.NATIVE_EVIDENCE_MIGRATION_MODE]: [packets.prepareNativeEvidenceMigration, packets.readNativeEvidenceMigration],
	[packets.NATIVE_IMPORT_STAGING_MIGRATION_MODE]: [packets.prepareNativeImportStagingMigration, packets.readNativeImportStagingMigration],
	[packets.NATIVE_INTAKE_FILE_SETS_MIGRATION_MODE]: [packets.prepareNativeIntakeFileSetsMigration, packets.readNativeIntakeFileSetsMigration],
	[packets.NATIVE_PDF_SESSIONS_MIGRATION_MODE]: [packets.prepareNativePdfSessionsMigration, packets.readNativePdfSessionsMigration],
} as const;
type Mode = keyof typeof INCREMENTS;

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const [command, stage, mode] = args;
if ((args.length !== 2 && args.length !== 3) || !stage || stage.startsWith('-') || !['prepare', 'verify'].includes(command ?? '')
	|| (mode !== undefined && !Object.hasOwn(INCREMENTS, mode))) {
	console.error(`Usage: bun scripts/hosted-native-runtime-migration.ts <prepare|verify> <stage-directory> [${Object.keys(INCREMENTS).join('|')}] (offline only)`);
	process.exitCode = 2;
} else {
	try {
		const [prepare, read] = mode === undefined ? [packets.prepareNativeRuntimeMigration, packets.readNativeRuntimeMigration] : INCREMENTS[mode as Mode];
		const result = command === 'prepare' ? prepare({ root, out: path.resolve(stage) }) : read({ root, stage: path.resolve(stage) });
		console.log(result.manifestText.trimEnd());
	} catch (error) {
		console.error(error instanceof Error ? error.message : 'runtime migration refused');
		process.exitCode = 1;
	}
}
