/// <reference types="node" />
// Offline only: no credentials, environment, Git, subprocess or provider access.
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
function captureBytes(value: unknown, length: number): Uint8Array {
	if (!(value instanceof Uint8Array) || (Object.getPrototypeOf(value) !== Uint8Array.prototype && Object.getPrototypeOf(value) !== Buffer.prototype)) throw new Error('expected plain byte array');
	// Intrinsic typed-array getters reject proxies; shared/resizable backing stores are not stable inputs.
	const proto = Object.getPrototypeOf(Uint8Array.prototype);
	const size = Object.getOwnPropertyDescriptor(proto, 'byteLength')!.get!.call(value);
	const buffer = Object.getOwnPropertyDescriptor(proto, 'buffer')!.get!.call(value);
	if (!(buffer instanceof ArrayBuffer) || buffer.resizable || size !== length || Reflect.ownKeys(value).length !== length) throw new Error('input bytes differ or overridden');
	const captured = new Uint8Array(length);
	Uint8Array.prototype.set.call(captured, value);
	return captured;
}

/** Exact three pinned inputs only. Copies each byte buffer once before hashing and emitting that copy. */
export function assembleNativeRuntimeMigration(inputs: readonly { path: string; bytes: Uint8Array }[]) {
	const items = dense(inputs, NATIVE_RUNTIME_MIGRATION_INPUTS.length, 'inputs');
	const chunks: string[] = [];
	for (let i = 0; i < items.length; i++) {
		const input = record(items[i], ['path', 'bytes'], `input ${i}`);
		const pin = NATIVE_RUNTIME_MIGRATION_INPUTS[i]!;
		if (input.path !== pin.path) throw new Error(`input order/path differs at ${i}`);
		const bytes = captureBytes(input.bytes, pin.bytes);
		if (sha(bytes) !== pin.sha256) throw new Error(`${pin.path}: bytes differ from source pin`);
		chunks.push(`-- ${pin.path}\n${new TextDecoder('utf-8', { fatal: true }).decode(bytes)}\n`);
	}
	const sql = `-- ClearCase native runtime increment; source ${NATIVE_RUNTIME_MIGRATION_SOURCE}\n-- Requires unchanged 0001_native_alpha.sql; never replaces initial migration history.\n${chunks.join('\n')}`;
	const targets = CLIENTS.map(db => {
		const configFile = `${db.slot}.wrangler.json`;
		const accountId = 'fb4c31b91c5d89b7a54afbdc34823170';
		const configText = json({ account_id: accountId, send_metrics: false, d1_databases: [{ binding: 'DB', database_name: db.name, database_id: db.id, migrations_dir: 'migrations' }] });
		return { slot: db.slot, accountId, databaseName: db.name, databaseId: db.id, configFile, configText,
			argv: ['wrangler', 'd1', 'migrations', 'apply', db.name, '--remote', '--config', configFile] };
	});
	const manifest = { schema: 'clearcase.native-runtime-migration/1', source: NATIVE_RUNTIME_MIGRATION_SOURCE,
		initialSchemaDependency: NATIVE_RUNTIME_INITIAL_SCHEMA, inputs: NATIVE_RUNTIME_MIGRATION_INPUTS,
		output: { path: SQL_FILE, bytes: Buffer.byteLength(sql), sha256: sha(sql) }, targets, providerProof: false, provisioned: false };
	return freeze({ sql, manifest, manifestText: json(manifest) });
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
	return path.resolve(value);
}
function readBytes(file: string, expectedSize: number) {
	realPath(file, false);
	const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expectedSize) throw new Error('expected unlinked file with exact pinned size');
		return readFileSync(fd);
	} finally { closeSync(fd); }
}
function fromRoot(root: string) {
	realPath(root, true);
	return assembleNativeRuntimeMigration(NATIVE_RUNTIME_MIGRATION_INPUTS.map(pin => ({ path: pin.path, bytes: readBytes(path.join(root, pin.path), pin.bytes) })));
}
function files(plan: ReturnType<typeof assembleNativeRuntimeMigration>) {
	return new Map([[SQL_FILE, plan.sql], ['runtime-migration.json', plan.manifestText], ...plan.manifest.targets.map(t => [t.configFile, t.configText] as [string, string])]);
}

/** Exclusive new directory only. A preexisting stage is never removed or changed. */
export function prepareNativeRuntimeMigration(value: { root: string; out: string }) {
	const v = record(value, ['root', 'out'], 'prepare');
	const root = location(v.root), out = location(v.out);
	const plan = fromRoot(root);
	realPath(path.dirname(out), true);
	mkdirSync(out); // Exclusive: throws for existing files, directories and dangling links.
	const owned = lstatSync(out);
	try {
		mkdirSync(path.join(out, 'migrations'));
		for (const [file, bytes] of files(plan)) writeFileSync(path.join(out, file), bytes, { flag: 'wx', mode: 0o644 });
		return readNativeRuntimeMigration({ root, stage: out });
	} catch (error) {
		const current = lstatSync(out, { throwIfNoEntry: false });
		if (current?.isDirectory() && current.ino === owned.ino && current.dev === owned.dev) rmSync(out, { recursive: true, force: true });
		throw error;
	}
}

/** Re-read all pinned sources and exact stage entries before each parent-owned application. */
export function readNativeRuntimeMigration(value: { root: string; stage: string }) {
	const v = record(value, ['root', 'stage'], 'read');
	const root = location(v.root), stage = location(v.stage);
	const plan = fromRoot(root);
	realPath(stage, true);
	const expected = files(plan);
	const entries: string[] = [];
	for (const name of readdirSync(stage)) {
		if (name === 'migrations') {
			realPath(path.join(stage, name), true);
			for (const migration of readdirSync(path.join(stage, name))) entries.push(`${name}/${migration}`);
		} else entries.push(name);
	}
	if (entries.length !== expected.size || entries.some(name => !expected.has(name))) throw new Error('unexpected or missing stage entries');
	for (const [file, bytes] of expected) if (!readBytes(path.join(stage, file), Buffer.byteLength(bytes)).equals(Buffer.from(bytes))) throw new Error(`${file}: staged bytes differ`);
	return freeze({ stage, ...plan });
}

/** Fixed invocation only; no execution. The initial-schema provider readback remains the parent's duty. */
export function checkNativeRuntimeMigrationInvocation(value: { root: string; stage: string; cwd: string; slot: NativeRuntimeMigrationSlot; argv: readonly string[] }) {
	const v = record(value, ['root', 'stage', 'cwd', 'slot', 'argv'], 'invocation');
	const checked = readNativeRuntimeMigration({ root: location(v.root), stage: location(v.stage) });
	const target = checked.manifest.targets.find(t => t.slot === v.slot);
	if (!target) throw new Error('not an approved target');
	const cwd = location(v.cwd);
	realPath(cwd, true);
	const argv = dense(v.argv, target.argv.length, 'argv');
	if (cwd !== checked.stage || argv.some((arg, i) => arg !== target.argv[i])) throw new Error('invocation differs from exact plan');
	return freeze({ ...checked, target });
}
