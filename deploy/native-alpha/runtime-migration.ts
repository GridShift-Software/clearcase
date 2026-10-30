/// <reference types="node" />
// Offline only: no credentials, environment, Git, subprocess or provider access.
import { createHash } from 'node:crypto';
import { type Stats, constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const NATIVE_RUNTIME_MIGRATION_SOURCE = '79c0ee92a858e55a12c727760e258ce8e293a86b';
const sha = (bytes: string | Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
function freeze<T>(value: T): T {
	if (value !== null && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
	return value;
}
export const NATIVE_RUNTIME_INITIAL_SCHEMA = freeze({ path: 'migrations/0001_native_alpha.sql', bytes: 85251,
	sha256: 'sha256:42c5047823256b5bfbc25ba7f8d04b6a05decb2ad19683599d89801011040d89', source: 'c6f0d9536e381dc8eebbf2035f49834409434761' });
export const NATIVE_RUNTIME_MIGRATION_INPUTS = freeze([
	{ path: 'src/lib/server/runtime/hosted/migrations/0001_audit_recovery_cursor.sql', bytes: 735, sha256: 'sha256:5021e7d048c6716ac238d6ecefc3cb0215446e44293ae495e244f5e89d64d1e6' },
	{ path: 'src/lib/viewer/hosted/migrations/0001_preview_render_work.sql', bytes: 11317, sha256: 'sha256:06fedb50c3da237d8565038195d77bf6f90c965be0ae3c84614b25c92c0e2112' },
	{ path: 'src/lib/publication/hosted/migrations/0003_provenance_generation.sql', bytes: 8175, sha256: 'sha256:7d6fad7a0b9551693f59bfb2dd5090d5a90d55af141fc5657fb58ee9d6fb7be0' },
]);
const SQL_FILE = 'migrations/0002_native_runtime.sql';
export const NATIVE_RENDER_CASE_LIMIT_MIGRATION_MODE = 'render-case-limit-0004';
export const NATIVE_RENDER_CASE_LIMIT_MIGRATION_SOURCE = '721384470b91264f01aaa765ab29bf8373216292';
export const NATIVE_RENDER_CASE_LIMIT_MIGRATION_INPUTS = freeze([
	{ path: 'src/lib/viewer/hosted/migrations/0002_preview_render_case_limit.sql', bytes: 7565, sha256: 'sha256:83152ce69cdd56201b98b04d504d6ba220d137090500c64bb831de16f981539c' },
]);
// The already applied increment this one runs after. It is a dependency record only: never emitted, rewritten or replayed.
export const NATIVE_RENDER_CASE_LIMIT_APPLIED_RUNTIME = freeze({ path: SQL_FILE, bytes: 20618,
	sha256: 'sha256:e854e9d1c6bca7a439dd5903ace1a3e7d01382dae3a7e79e624146f870cda97f', source: NATIVE_RUNTIME_MIGRATION_SOURCE });
// 0003 is reserved for the separately reviewed audit-read increment; this one does not depend on it.
const RENDER_CASE_LIMIT_SQL_FILE = 'migrations/0004_native_render_case_limit.sql';
export const NATIVE_EVIDENCE_MIGRATION_MODE = 'evidence-0005';
export const NATIVE_EVIDENCE_MIGRATION_INPUTS = freeze([
	{ path: 'src/lib/publication/hosted/migrations/0004_publication_evidence.sql', bytes: 3141, sha256: 'sha256:789c0bc2698130126285b6827e155385d588284a32b6931a5ace21369fb4d450' },
	{ path: 'src/lib/viewer/hosted/migrations/0003_content_receipts.sql', bytes: 1146, sha256: 'sha256:16d8c24237fac757496a4ed1ac586d2173ea61a0c38b83c4eb2fa8f92982f45f' },
]);
export const NATIVE_EVIDENCE_APPLIED_RENDER_CASE_LIMIT = freeze({ path: RENDER_CASE_LIMIT_SQL_FILE, bytes: 7849,
	sha256: 'sha256:d57584cbb1c197c6d2392471f02751dc36ce1a2084adfe02136b874fe02af72e', source: NATIVE_RENDER_CASE_LIMIT_MIGRATION_SOURCE });
export const NATIVE_IMPORT_STAGING_MIGRATION_MODE = 'import-staging-0006';
export const NATIVE_IMPORT_STAGING_MIGRATION_INPUTS = freeze([
	{ path: 'src/lib/results-review/native/migrations/0002_native_import_staging.sql', bytes: 8533, sha256: 'sha256:99b54c990330b8d3fc1c73e06e1d9350dbdcdbea386aa4145bd49a7b004272a0' },
]);
// The already applied increment this one runs after: a dependency record only, never emitted, rewritten or replayed.
export const NATIVE_IMPORT_STAGING_APPLIED_EVIDENCE = freeze({ path: 'migrations/0005_native_evidence.sql', bytes: 4529,
	sha256: 'sha256:3fd4aab4b8f89adbf62a34a1cf67ac2941fd4ee30977f48af9980107d3f001db' });
export const NATIVE_INTAKE_FILE_SETS_MIGRATION_MODE = 'intake-file-sets-0007';
export const NATIVE_INTAKE_FILE_SETS_MIGRATION_INPUTS = freeze([
	{ path: 'src/lib/submissions/migrations/0002_submissions_file_sets.sql', bytes: 14281, sha256: 'sha256:13c7f0f9a6b43c1fc12c10001612bc38bbbbe2ef79e159b7f240d00aa6a7eeac' },
	{ path: 'src/lib/publication/hosted/migrations/0005_provenance_file_sets.sql', bytes: 1259, sha256: 'sha256:77f0697ff4fc75d5a47aa2821d8ead42bf686cc263bcab6c3839f820d4800657' },
]);
// The already applied increment this one runs after: a dependency record only, never emitted, rewritten or replayed.
export const NATIVE_INTAKE_FILE_SETS_APPLIED_IMPORT_STAGING = freeze({ path: 'migrations/0006_native_import_staging.sql', bytes: 8735,
	sha256: 'sha256:a5ff09a1db8dc2abc890d7734b9744b4186baf4ddf84d86241bb4c23b6690b18' });
export const NATIVE_PDF_SESSIONS_MIGRATION_MODE = 'pdf-sessions-0008';
export const NATIVE_PDF_SESSIONS_MIGRATION_INPUTS = freeze([
	{ path: 'src/lib/viewer/hosted/migrations/0004_pdf_evidence_sessions.sql', bytes: 4930, sha256: 'sha256:777a00c3e4a7e5d63f151ec29621fc39f7b84611a876485ae266d196da52ae5b' },
]);
// The already applied increment this one runs after: a dependency record only, never emitted, rewritten or replayed.
export const NATIVE_PDF_SESSIONS_APPLIED_INTAKE_FILE_SETS = freeze({ path: 'migrations/0007_native_intake_file_sets.sql', bytes: 15914,
	sha256: 'sha256:e90183aa1663336a1eaa8c3032fa6a239bba3c9323517003b48a6fd1c9a27871' });
export const NATIVE_ORIGINAL_METADATA_MIGRATION_MODE = 'original-metadata-0009';
export const NATIVE_ORIGINAL_METADATA_MIGRATION_INPUTS = freeze([
	{ path: 'src/lib/storage/cloud/migrations/0003_rs_original_etag.sql', bytes: 663, sha256: 'sha256:4d0c5ce2b59bdc070a628b0d43880eaa339656ccb07eb2f602947f004b22121d' },
]);
export const NATIVE_ORIGINAL_METADATA_APPLIED_PDF_SESSIONS = freeze({ path: 'migrations/0008_native_pdf_sessions.sql', bytes: 5263,
	sha256: 'sha256:de0b32f6349fc6b47a8854e368bbb8ea513c791961a5f1e2fa8401c4b4ec0b5a' });
const CLIENTS = freeze([
	{ slot: 'client-a', name: 'cc-sbx-a-20261023-db', id: 'cd257736-7bf3-49f6-8544-ac58c2207802' },
	{ slot: 'client-b', name: 'cc-sbx-b-20261025-r1-db', id: '7c340891-9fcc-4398-8128-68abe726f130' },
] as const);
export type NativeRuntimeMigrationSlot = typeof CLIENTS[number]['slot'];

// Read only own data descriptors. Never run a caller getter, iterator, toJSON or array method.
function record(value: unknown, keys: readonly string[], at: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error(`${at}: expected plain data`);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (Reflect.ownKeys(descriptors).length !== keys.length) throw new Error(`${at}: unexpected keys`);
	const captured: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const d = descriptors[key];
		if (!d || !Object.hasOwn(d, 'value')) throw new Error(`${at}: missing or accessor field`);
		captured[key] = d.value;
	}
	return captured;
}
function dense(value: unknown, length: number, at: string): unknown[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`${at}: expected dense plain array`);
	const d = Object.getOwnPropertyDescriptors(value);
	if (Object.getOwnPropertyDescriptor(value, 'length')?.value !== length || Reflect.ownKeys(d).length !== length + 1) throw new Error(`${at}: missing, extra or overridden array inputs`);
	const captured: unknown[] = [];
	for (let i = 0; i < length; i++) {
		const item = d[String(i)];
		if (!item || !Object.hasOwn(item, 'value')) throw new Error(`${at}: hole, inherited or accessor input`);
		captured.push(item.value);
	}
	return captured;
}
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const arrayBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')!.get!;
const copyBytes = Uint8Array.prototype.set;
function captureBytes(value: unknown, length: number): Uint8Array {
	// Brand-check first: even a proxy must be refused without invoking its traps.
	const size = typedArrayByteLength.call(value);
	const prototype = Object.getPrototypeOf(value);
	if ((prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) || !(value instanceof Uint8Array)) throw new Error('expected plain byte array');
	// Read internal slots, never caller-owned view/backing-store properties. The ArrayBuffer
	// intrinsic also rejects shared storage, even with a forged ArrayBuffer prototype.
	const buffer = typedArrayBuffer.call(value);
	if (arrayBufferResizable.call(buffer) || size !== length || Reflect.ownKeys(value).length !== length) throw new Error('input bytes differ or overridden');
	const captured = new Uint8Array(length);
	copyBytes.call(captured, value);
	return captured;
}

type Pin = { readonly path: string; readonly bytes: number; readonly sha256: string };
type Output = { path: string; bytes: number; sha256: string };
function buildTargets() {
	return CLIENTS.map(db => {
		const configFile = `${db.slot}.wrangler.json`;
		const accountId = 'fb4c31b91c5d89b7a54afbdc34823170';
		const configText = json({ account_id: accountId, send_metrics: false, d1_databases: [{ binding: 'DB', database_name: db.name, database_id: db.id, migrations_dir: 'migrations' }] });
		return { slot: db.slot, accountId, databaseName: db.name, databaseId: db.id, configFile, configText,
			argv: ['wrangler', 'd1', 'migrations', 'apply', db.name, '--remote', '--config', configFile] };
	});
}
type Target = ReturnType<typeof buildTargets>[number];
/** A fixed packet shape. Only this module's constants are ever passed in, never caller data. */
interface Packet<Manifest extends { readonly targets: readonly Target[] }> {
	readonly tag: string | undefined;
	readonly inputs: readonly Pin[];
	readonly sqlFile: string;
	readonly manifestFile: string;
	readonly header: string;
	readonly privateStage: boolean;
	readonly manifest: (output: Output, targets: Target[]) => Manifest;
}
const RUNTIME_PACKET = {
	tag: undefined, inputs: NATIVE_RUNTIME_MIGRATION_INPUTS, sqlFile: SQL_FILE, manifestFile: 'runtime-migration.json', privateStage: false,
	header: `-- ClearCase native runtime increment; source ${NATIVE_RUNTIME_MIGRATION_SOURCE}\n-- Requires unchanged 0001_native_alpha.sql; never replaces initial migration history.\n`,
	manifest: (output: Output, targets: Target[]) => ({ schema: 'clearcase.native-runtime-migration/1', source: NATIVE_RUNTIME_MIGRATION_SOURCE,
		initialSchemaDependency: NATIVE_RUNTIME_INITIAL_SCHEMA, inputs: NATIVE_RUNTIME_MIGRATION_INPUTS, output, targets, providerProof: false, provisioned: false }),
};
const RENDER_CASE_LIMIT_PACKET = {
	tag: NATIVE_RENDER_CASE_LIMIT_MIGRATION_MODE, inputs: NATIVE_RENDER_CASE_LIMIT_MIGRATION_INPUTS, sqlFile: RENDER_CASE_LIMIT_SQL_FILE, manifestFile: 'render-case-limit-migration.json', privateStage: true,
	header: `-- ClearCase native render case-limit increment 0004; input source ${NATIVE_RENDER_CASE_LIMIT_MIGRATION_SOURCE}\n-- Requires unchanged 0001_native_alpha.sql and applied 0002_native_runtime.sql; never replaces either.\n`,
	manifest: (output: Output, targets: Target[]) => ({ schema: 'clearcase.native-render-case-limit-migration/1', mode: NATIVE_RENDER_CASE_LIMIT_MIGRATION_MODE, source: NATIVE_RENDER_CASE_LIMIT_MIGRATION_SOURCE,
		initialSchemaDependency: NATIVE_RUNTIME_INITIAL_SCHEMA, appliedRuntimeDependency: NATIVE_RENDER_CASE_LIMIT_APPLIED_RUNTIME, inputs: NATIVE_RENDER_CASE_LIMIT_MIGRATION_INPUTS, output, targets, providerProof: false, provisioned: false }),
};

const EVIDENCE_PACKET = {
	tag: NATIVE_EVIDENCE_MIGRATION_MODE, inputs: NATIVE_EVIDENCE_MIGRATION_INPUTS, sqlFile: 'migrations/0005_native_evidence.sql', manifestFile: 'evidence-migration.json', privateStage: true,
	header: '-- ClearCase native evidence increment 0005. Requires applied 0001, 0002 and 0004; 0003 remains reserved.\n',
	manifest: (output: Output, targets: Target[]) => ({ schema: 'clearcase.native-evidence-migration/1', mode: NATIVE_EVIDENCE_MIGRATION_MODE,
		initialSchemaDependency: NATIVE_RUNTIME_INITIAL_SCHEMA, appliedRuntimeDependency: NATIVE_RENDER_CASE_LIMIT_APPLIED_RUNTIME, appliedRenderCaseLimitDependency: NATIVE_EVIDENCE_APPLIED_RENDER_CASE_LIMIT,
		inputs: NATIVE_EVIDENCE_MIGRATION_INPUTS, output, targets, providerProof: false, provisioned: false }),
};

const IMPORT_STAGING_PACKET = {
	tag: NATIVE_IMPORT_STAGING_MIGRATION_MODE, inputs: NATIVE_IMPORT_STAGING_MIGRATION_INPUTS, sqlFile: 'migrations/0006_native_import_staging.sql', manifestFile: 'import-staging-migration.json', privateStage: true,
	header: '-- ClearCase native chunked-import staging increment 0006. Requires applied 0001, 0002, 0004 and 0005; 0003 remains reserved.\n',
	manifest: (output: Output, targets: Target[]) => ({ schema: 'clearcase.native-import-staging-migration/1', mode: NATIVE_IMPORT_STAGING_MIGRATION_MODE,
		initialSchemaDependency: NATIVE_RUNTIME_INITIAL_SCHEMA, appliedRuntimeDependency: NATIVE_RENDER_CASE_LIMIT_APPLIED_RUNTIME, appliedRenderCaseLimitDependency: NATIVE_EVIDENCE_APPLIED_RENDER_CASE_LIMIT,
		appliedEvidenceDependency: NATIVE_IMPORT_STAGING_APPLIED_EVIDENCE, inputs: NATIVE_IMPORT_STAGING_MIGRATION_INPUTS, output, targets, providerProof: false, provisioned: false }),
};

const INTAKE_FILE_SETS_PACKET = {
	tag: NATIVE_INTAKE_FILE_SETS_MIGRATION_MODE, inputs: NATIVE_INTAKE_FILE_SETS_MIGRATION_INPUTS, sqlFile: 'migrations/0007_native_intake_file_sets.sql', manifestFile: 'intake-file-sets-migration.json', privateStage: true,
	header: '-- ClearCase native multi-file intake increment 0007. Requires applied 0001, 0002, 0004, 0005 and 0006; 0003 remains reserved.\n'
		+ '-- Rebuilds submissions_revision by copy-back under deferred foreign keys; one transaction, never replayed.\n',
	manifest: (output: Output, targets: Target[]) => ({ schema: 'clearcase.native-intake-file-sets-migration/1', mode: NATIVE_INTAKE_FILE_SETS_MIGRATION_MODE,
		initialSchemaDependency: NATIVE_RUNTIME_INITIAL_SCHEMA, appliedRuntimeDependency: NATIVE_RENDER_CASE_LIMIT_APPLIED_RUNTIME, appliedRenderCaseLimitDependency: NATIVE_EVIDENCE_APPLIED_RENDER_CASE_LIMIT,
		appliedEvidenceDependency: NATIVE_IMPORT_STAGING_APPLIED_EVIDENCE, appliedImportStagingDependency: NATIVE_INTAKE_FILE_SETS_APPLIED_IMPORT_STAGING,
		inputs: NATIVE_INTAKE_FILE_SETS_MIGRATION_INPUTS, output, targets, providerProof: false, provisioned: false }),
};

const PDF_SESSIONS_PACKET = {
	tag: NATIVE_PDF_SESSIONS_MIGRATION_MODE, inputs: NATIVE_PDF_SESSIONS_MIGRATION_INPUTS, sqlFile: 'migrations/0008_native_pdf_sessions.sql', manifestFile: 'pdf-sessions-migration.json', privateStage: true,
	header: '-- ClearCase native scaled PDF evidence sessions increment 0008. Requires applied 0001, 0002, 0004, 0005, 0006 and 0007; 0003 remains reserved.\n'
		+ '-- Additive: the viewer\'s 0004 session admission tables and their seals; viewer 0003 (content receipts) arrived in 0005.\n',
	manifest: (output: Output, targets: Target[]) => ({ schema: 'clearcase.native-pdf-sessions-migration/1', mode: NATIVE_PDF_SESSIONS_MIGRATION_MODE,
		initialSchemaDependency: NATIVE_RUNTIME_INITIAL_SCHEMA, appliedRuntimeDependency: NATIVE_RENDER_CASE_LIMIT_APPLIED_RUNTIME, appliedRenderCaseLimitDependency: NATIVE_EVIDENCE_APPLIED_RENDER_CASE_LIMIT,
		appliedEvidenceDependency: NATIVE_IMPORT_STAGING_APPLIED_EVIDENCE, appliedImportStagingDependency: NATIVE_INTAKE_FILE_SETS_APPLIED_IMPORT_STAGING,
		appliedIntakeFileSetsDependency: NATIVE_PDF_SESSIONS_APPLIED_INTAKE_FILE_SETS, inputs: NATIVE_PDF_SESSIONS_MIGRATION_INPUTS, output, targets, providerProof: false, provisioned: false }),
};

const ORIGINAL_METADATA_PACKET = {
	tag: NATIVE_ORIGINAL_METADATA_MIGRATION_MODE, inputs: NATIVE_ORIGINAL_METADATA_MIGRATION_INPUTS, sqlFile: 'migrations/0009_rs_original_etag.sql', manifestFile: 'original-metadata-migration.json', privateStage: true,
	header: '-- ClearCase native original delivery metadata increment 0009. Requires the applied native increments through 0008.\n',
	manifest: (output: Output, targets: Target[]) => ({ schema: 'clearcase.native-original-metadata-migration/1', mode: NATIVE_ORIGINAL_METADATA_MIGRATION_MODE,
		initialSchemaDependency: NATIVE_RUNTIME_INITIAL_SCHEMA, appliedPdfSessionsDependency: NATIVE_ORIGINAL_METADATA_APPLIED_PDF_SESSIONS,
		inputs: NATIVE_ORIGINAL_METADATA_MIGRATION_INPUTS, output, targets, providerProof: false, provisioned: false }),
};

function assemble<M extends { readonly targets: readonly Target[] }>(packet: Packet<M>, inputs: readonly { path: string; bytes: Uint8Array }[]) {
	const items = dense(inputs, packet.inputs.length, 'inputs');
	const chunks: string[] = [];
	for (let i = 0; i < items.length; i++) {
		const input = record(items[i], ['path', 'bytes'], `input ${i}`);
		const pin = packet.inputs[i]!;
		if (input.path !== pin.path) throw new Error(`input order/path differs at ${i}`);
		const bytes = captureBytes(input.bytes, pin.bytes);
		if (sha(bytes) !== pin.sha256) throw new Error(`${pin.path}: bytes differ from source pin`);
		chunks.push(`-- ${pin.path}\n${new TextDecoder('utf-8', { fatal: true }).decode(bytes)}\n`);
	}
	const sql = `${packet.header}${chunks.join('\n')}`;
	const manifest = packet.manifest({ path: packet.sqlFile, bytes: Buffer.byteLength(sql), sha256: sha(sql) }, buildTargets());
	return freeze({ sql, manifest, manifestText: json(manifest) });
}

/** Exact three pinned inputs only. Copies each byte buffer once before hashing and emitting that copy. */
export function assembleNativeRuntimeMigration(inputs: readonly { path: string; bytes: Uint8Array }[]) {
	return assemble(RUNTIME_PACKET, inputs);
}
/** The single pinned viewer case-limit input only, under the same one-copy capture. Emits a separately named 0004. */
export function assembleNativeRenderCaseLimitMigration(inputs: readonly { path: string; bytes: Uint8Array }[]) {
	return assemble(RENDER_CASE_LIMIT_PACKET, inputs);
}

export function assembleNativeEvidenceMigration(inputs: readonly { path: string; bytes: Uint8Array }[]) {
	return assemble(EVIDENCE_PACKET, inputs);
}

/** The single pinned chunked-import input only, under the same one-copy capture. Emits a separately named 0006 after the applied 0005. */
export function assembleNativeImportStagingMigration(inputs: readonly { path: string; bytes: Uint8Array }[]) {
	return assemble(IMPORT_STAGING_PACKET, inputs);
}

/** The two pinned multi-file intake inputs only, in order, under the same one-copy capture. Emits a separately named 0007 after the applied 0006. */
export function assembleNativeIntakeFileSetsMigration(inputs: readonly { path: string; bytes: Uint8Array }[]) {
	return assemble(INTAKE_FILE_SETS_PACKET, inputs);
}

/** The single pinned viewer PDF-session input only, under the same one-copy capture. Emits a separately named 0008 after the applied 0007. */
export function assembleNativePdfSessionsMigration(inputs: readonly { path: string; bytes: Uint8Array }[]) {
	return assemble(PDF_SESSIONS_PACKET, inputs);
}

/** Adds nullable original metadata after the historical packets; their emitted bytes remain unchanged. */
export function assembleNativeOriginalMetadataMigration(inputs: readonly { path: string; bytes: Uint8Array }[]) {
	return assemble(ORIGINAL_METADATA_PACKET, inputs);
}

function realPath(file: string, directory: boolean) {
	for (let at = path.resolve(file), first = true; ; at = path.dirname(at), first = false) {
		const stat = lstatSync(at);
		if (stat.isSymbolicLink() || !(first && !directory ? stat.isFile() && stat.nlink === 1 : stat.isDirectory())) throw new Error(`${at}: expected real unlinked ${directory ? 'directory' : 'file'}`);
		if (at === path.dirname(at)) break;
	}
}
function location(value: unknown): string {
	if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('expected path');
	// Reject raw traversal before resolve can erase a link/.. boundary. Ordinary relative
	// locations and a trailing directory slash remain useful for prepare/read callers.
	if (value.split(path.sep).some(part => part === '.' || part === '..')) throw new Error('path traversal is not permitted');
	return path.resolve(value);
}
// A private stage is owned by this user and closed to group and other, judged on the open descriptor.
function requirePrivate(stat: Stats) {
	if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('stage entry is not private to this user');
}
function readBytes(file: string, expectedSize: number, privateStage: boolean) {
	realPath(file, false);
	const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expectedSize) throw new Error('expected unlinked file with exact pinned size');
		if (privateStage) requirePrivate(stat);
		return readFileSync(fd);
	} finally { closeSync(fd); }
}
function privateDirectory(dir: string) {
	const named = lstatSync(dir);
	const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		if (!stat.isDirectory() || stat.dev !== named.dev || stat.ino !== named.ino) throw new Error(`${dir}: expected real unlinked directory`);
		requirePrivate(stat);
		return stat;
	} finally { closeSync(fd); }
}
function fromRoot<M extends { readonly targets: readonly Target[] }>(packet: Packet<M>, root: string) {
	realPath(root, true);
	return assemble(packet, packet.inputs.map(pin => ({ path: pin.path, bytes: readBytes(path.join(root, pin.path), pin.bytes, false) })));
}
function files(packet: Packet<{ readonly targets: readonly Target[] }>, plan: { sql: string; manifestText: string; manifest: { targets: readonly Target[] } }) {
	return new Map([[packet.sqlFile, plan.sql], [packet.manifestFile, plan.manifestText], ...plan.manifest.targets.map(t => [t.configFile, t.configText] as [string, string])]);
}
// The checked shape of a later packet names its mode; the runtime shape stays exactly as it was.
const stamped = (packet: Packet<{ readonly targets: readonly Target[] }>) => packet.tag === undefined ? {} : { mode: packet.tag };

/** Exclusive new directory only. A preexisting stage is never removed or changed. */
function prepare<M extends { readonly targets: readonly Target[] }>(packet: Packet<M>, value: { root: string; out: string }) {
	const v = record(value, ['root', 'out'], 'prepare');
	const root = location(v.root), out = location(v.out);
	const plan = fromRoot(packet, root);
	realPath(path.dirname(out), true);
	const dirMode = packet.privateStage ? { mode: 0o700 } : undefined;
	mkdirSync(out, dirMode); // Exclusive: throws for existing files, directories and dangling links.
	const owned = lstatSync(out);
	try {
		mkdirSync(path.join(out, 'migrations'), dirMode);
		for (const [file, bytes] of files(packet, plan)) writeFileSync(path.join(out, file), bytes, { flag: 'wx', mode: packet.privateStage ? 0o600 : 0o644 });
		return read(packet, { root, stage: out });
	} catch (error) {
		const current = lstatSync(out, { throwIfNoEntry: false });
		if (current?.isDirectory() && current.ino === owned.ino && current.dev === owned.dev) rmSync(out, { recursive: true, force: true });
		throw error;
	}
}

/** Re-read all pinned sources and exact stage entries before each parent-owned application. */
function read<M extends { readonly targets: readonly Target[] }>(packet: Packet<M>, value: { root: string; stage: string }) {
	const v = record(value, ['root', 'stage'], 'read');
	const root = location(v.root), stage = location(v.stage);
	const plan = fromRoot(packet, root);
	realPath(stage, true);
	const guard = packet.privateStage ? [stage, path.join(stage, 'migrations')] : [];
	const opened = guard.map(privateDirectory);
	const expected = files(packet, plan);
	const entries: string[] = [];
	for (const name of readdirSync(stage)) {
		if (name === 'migrations') {
			realPath(path.join(stage, name), true);
			for (const migration of readdirSync(path.join(stage, name))) entries.push(`${name}/${migration}`);
		} else entries.push(name);
	}
	if (entries.length !== expected.size || entries.some(name => !expected.has(name))) throw new Error('unexpected or missing stage entries');
	for (const [file, bytes] of expected) if (!readBytes(path.join(stage, file), Buffer.byteLength(bytes), packet.privateStage).equals(Buffer.from(bytes))) throw new Error(`${file}: staged bytes differ`);
	// Same directories, unchanged while they were listed and read.
	guard.forEach((dir, i) => {
		const again = privateDirectory(dir), first = opened[i]!;
		if (again.dev !== first.dev || again.ino !== first.ino || again.mtimeMs !== first.mtimeMs || again.ctimeMs !== first.ctimeMs) throw new Error(`${dir}: stage changed while being read`);
	});
	return freeze({ stage, ...stamped(packet), ...plan });
}

/** Fixed invocation only; no execution. The initial-schema provider readback remains the parent's duty. */
function checkInvocation<M extends { readonly targets: readonly Target[] }>(packet: Packet<M>, value: { root: string; stage: string; cwd: string; slot: NativeRuntimeMigrationSlot; argv: readonly string[] }) {
	const v = record(value, ['root', 'stage', 'cwd', 'slot', 'argv'], 'invocation');
	const checked = read(packet, { root: location(v.root), stage: location(v.stage) });
	const target = checked.manifest.targets.find(t => t.slot === v.slot);
	if (!target) throw new Error('not an approved target');
	// The parent must execute this exact spelling, not a lexically equivalent path whose
	// filesystem traversal could land elsewhere. checked.stage has no linked ancestors.
	if (v.cwd !== checked.stage) throw new Error('invocation differs from exact plan');
	realPath(checked.stage, true);
	const argv = dense(v.argv, target.argv.length, 'argv');
	if (argv.some((arg, i) => arg !== target.argv[i])) throw new Error('invocation differs from exact plan');
	return freeze({ ...checked, target });
}

export const prepareNativeRuntimeMigration = (value: { root: string; out: string }) => prepare(RUNTIME_PACKET, value);
export const readNativeRuntimeMigration = (value: { root: string; stage: string }) => read(RUNTIME_PACKET, value);
export const checkNativeRuntimeMigrationInvocation = (value: { root: string; stage: string; cwd: string; slot: NativeRuntimeMigrationSlot; argv: readonly string[] }) => checkInvocation(RUNTIME_PACKET, value);

/** Render case-limit 0004 packet: a new, private, separately named stage. It can never be read or checked as the 0002 packet. */
export const prepareNativeRenderCaseLimitMigration = (value: { root: string; out: string }) => prepare(RENDER_CASE_LIMIT_PACKET, value);
export const readNativeRenderCaseLimitMigration = (value: { root: string; stage: string }) => read(RENDER_CASE_LIMIT_PACKET, value);
export const checkNativeRenderCaseLimitMigrationInvocation = (value: { root: string; stage: string; cwd: string; slot: NativeRuntimeMigrationSlot; argv: readonly string[] }) => checkInvocation(RENDER_CASE_LIMIT_PACKET, value);
export const prepareNativeEvidenceMigration = (value: { root: string; out: string }) => prepare(EVIDENCE_PACKET, value);
export const readNativeEvidenceMigration = (value: { root: string; stage: string }) => read(EVIDENCE_PACKET, value);
export const checkNativeEvidenceMigrationInvocation = (value: { root: string; stage: string; cwd: string; slot: NativeRuntimeMigrationSlot; argv: readonly string[] }) => checkInvocation(EVIDENCE_PACKET, value);
export const prepareNativeImportStagingMigration = (value: { root: string; out: string }) => prepare(IMPORT_STAGING_PACKET, value);
export const readNativeImportStagingMigration = (value: { root: string; stage: string }) => read(IMPORT_STAGING_PACKET, value);
export const checkNativeImportStagingMigrationInvocation = (value: { root: string; stage: string; cwd: string; slot: NativeRuntimeMigrationSlot; argv: readonly string[] }) => checkInvocation(IMPORT_STAGING_PACKET, value);
export const prepareNativeIntakeFileSetsMigration = (value: { root: string; out: string }) => prepare(INTAKE_FILE_SETS_PACKET, value);
export const readNativeIntakeFileSetsMigration = (value: { root: string; stage: string }) => read(INTAKE_FILE_SETS_PACKET, value);
export const checkNativeIntakeFileSetsMigrationInvocation = (value: { root: string; stage: string; cwd: string; slot: NativeRuntimeMigrationSlot; argv: readonly string[] }) => checkInvocation(INTAKE_FILE_SETS_PACKET, value);
export const prepareNativePdfSessionsMigration = (value: { root: string; out: string }) => prepare(PDF_SESSIONS_PACKET, value);
export const readNativePdfSessionsMigration = (value: { root: string; stage: string }) => read(PDF_SESSIONS_PACKET, value);
export const checkNativePdfSessionsMigrationInvocation = (value: { root: string; stage: string; cwd: string; slot: NativeRuntimeMigrationSlot; argv: readonly string[] }) => checkInvocation(PDF_SESSIONS_PACKET, value);
export const prepareNativeOriginalMetadataMigration = (value: { root: string; out: string }) => prepare(ORIGINAL_METADATA_PACKET, value);
export const readNativeOriginalMetadataMigration = (value: { root: string; stage: string }) => read(ORIGINAL_METADATA_PACKET, value);
export const checkNativeOriginalMetadataMigrationInvocation = (value: { root: string; stage: string; cwd: string; slot: NativeRuntimeMigrationSlot; argv: readonly string[] }) => checkInvocation(ORIGINAL_METADATA_PACKET, value);
