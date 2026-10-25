/// <reference types="node" />
// Offline, pinned schema assembly only. Never imports provisioning, credentials or a provider client.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const NATIVE_SCHEMA_SOURCE = 'c6f0d9536e381dc8eebbf2035f49834409434761';
const ACCOUNT = 'fb4c31b91c5d89b7a54afbdc34823170';
const CLIENTS = {
	'client-a': { name: 'cc-sbx-a-20261023-db', id: 'cd257736-7bf3-49f6-8544-ac58c2207802' },
	'client-b': { name: 'cc-sbx-b-20261025-r1-db', id: '7c340891-9fcc-4398-8128-68abe726f130' },
} as const;
export type NativeSchemaSlot = keyof typeof CLIENTS;
const SQL_FILE = 'migrations/0001_native_alpha.sql';
// Identical DDL to start:hosted's sentinel, without its synthetic INSERT or R2 object.
export const NATIVE_RUNTIME_DDL = 'CREATE TABLE IF NOT EXISTS runtime_sentinel (name TEXT PRIMARY KEY, value TEXT NOT NULL);\n';
const sha = (bytes: string | Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
function freeze<T>(value: T): T {
	if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
	return value;
}
export const NATIVE_SCHEMA_INPUTS = freeze([
	{ path: 'src/lib/audit/migrations/0001_native_audit.sql', bytes: 6528, sha256: 'sha256:07bda4d566abf3be9ff85ae10b20bd0f370f5354497dc6a4cf7bf7fead363349' },
	{ path: 'src/lib/storage/cloud/migrations/0001_rs_results_storage.sql', bytes: 7366, sha256: 'sha256:548fc6264ab2e9fbaaa148a794605a97023eff4e22e2ad1f4a2244e1c44490c8' },
	{ path: 'src/lib/tenancy/migrations/0001_tenant_case_grants.sql', bytes: 2158, sha256: 'sha256:0dfb7802c283acff7f65b30c77c7bf64d1146572b73b26dba1f80b2cf53f29af' },
	{ path: 'src/lib/tenancy/migrations/0002_tenant_grant_operations.sql', bytes: 1365, sha256: 'sha256:921668f0d6bbfd8b2ef7c1d1aab5d147a4031a8916ca7d33418159725b6fbcae' },
	{ path: 'src/lib/tenancy/migrations/0003_tenant_upload_grants.sql', bytes: 6353, sha256: 'sha256:9bc1d5ac5e61557ddc1f16c9f0aaa2c63e53378a023d0b24af9e984783d18bd5' },
	{ path: 'src/lib/storage/cloud/migrations/0002_rs_verification_work.sql', bytes: 863, sha256: 'sha256:0030447407d716978cdba336257d51464b67f482b67397f39440c23038984012' },
	{ path: 'src/lib/submissions/migrations/0001_submissions_intake.sql', bytes: 7999, sha256: 'sha256:b1650c82b7801afffc6f085e2069f7bdeaf30d122945f810942940261e7db15e' },
	{ path: 'src/lib/user-work/hosted/migrations/0001_uw_user_work.sql', bytes: 7492, sha256: 'sha256:0f38155b73ae7eaebe39ab2b82a233a75a6ee644f0d8bd06088979dbd0686b31' },
	{ path: 'src/lib/results-review/native/migrations/0001_native_candidate_import.sql', bytes: 13182, sha256: 'sha256:f0911a82634c728d1e9939d6141bf547f9e25c1ff4211a1bfca039023315cfaa' },
	{ path: 'src/lib/publication/hosted/migrations/0001_publication_ledger.sql', bytes: 7323, sha256: 'sha256:239b3e4dac6b9fe5ef90dddedbf841a6663d6e2456068bfddbe7b5e40b066cac' },
	{ path: 'src/lib/publication/hosted/migrations/0002_atomic_publication.sql', bytes: 23634, sha256: 'sha256:abac05fa9bb401bcf0d78582ec8c7693216827ac28b9070cb01e1334c86a16dc' },
]);

function exact(value: unknown, keys: string[], at: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) throw new Error(`${at}: unexpected or missing keys`);
}

/** Pure function: exact pinned input bytes, paths and order; no SQL, source-pin or target overrides. */
export function assembleNativeSchema(inputs: readonly { path: string; bytes: Uint8Array }[]) {
	if (!Array.isArray(inputs) || inputs.length !== NATIVE_SCHEMA_INPUTS.length) throw new Error('missing or extra schema inputs');
	const chunks: string[] = [];
	for (let i = 0; i < NATIVE_SCHEMA_INPUTS.length; i++) {
		if (!Object.hasOwn(inputs, i)) throw new Error(`missing schema input at ${i}`);
		const input = inputs[i];
		exact(input, ['path', 'bytes'], `input ${i}`);
		const pin = NATIVE_SCHEMA_INPUTS[i]!;
		if (input.path !== pin.path) throw new Error(`schema input order/path differs at ${i}: expected ${pin.path}`);
		if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength !== pin.bytes || sha(input.bytes) !== pin.sha256) throw new Error(`${pin.path}: schema input bytes differ from source pin`);
		chunks.push(`-- ${pin.path}\n${new TextDecoder('utf-8', { fatal: true }).decode(input.bytes)}\n`);
	}
	const sql = `-- ClearCase native alpha schema; source ${NATIVE_SCHEMA_SOURCE}\n-- DDL only. Trusted binding identities, cases, grants and runtime sentinel data are separate.\n${NATIVE_RUNTIME_DDL}\n${chunks.join('\n')}`;
	const targets = (Object.keys(CLIENTS) as NativeSchemaSlot[]).map(slot => {
		const db = CLIENTS[slot];
		const configFile = `${slot}.wrangler.json`;
		const configText = json({ account_id: ACCOUNT, send_metrics: false, d1_databases: [{ binding: 'DB', database_name: db.name, database_id: db.id, migrations_dir: 'migrations' }] });
		return { slot, accountId: ACCOUNT, databaseName: db.name, databaseId: db.id, configFile, configText,
			argv: ['wrangler', 'd1', 'migrations', 'apply', db.name, '--remote', '--config', configFile] };
	});
	const manifest = { schema: 'clearcase.native-schema/1', source: NATIVE_SCHEMA_SOURCE,
		inputs: [{ path: 'generated:runtime_sentinel', bytes: Buffer.byteLength(NATIVE_RUNTIME_DDL), sha256: sha(NATIVE_RUNTIME_DDL) }, ...NATIVE_SCHEMA_INPUTS],
		output: { path: SQL_FILE, bytes: Buffer.byteLength(sql), sha256: sha(sql) }, targets, providerProof: false, provisioned: false };
	return freeze({ sql, manifest, manifestText: json(manifest) });
}

// Refuse symlinks, including parents, rather than following them to another worker's files.
function realPath(file: string, directory: boolean) {
	for (let at = path.resolve(file), first = true; ; at = path.dirname(at), first = false) {
		const stat = lstatSync(at);
		if (stat.isSymbolicLink() || !(first && !directory ? stat.isFile() : stat.isDirectory())) throw new Error(`${at}: expected a real ${first && !directory ? 'file' : 'directory'}`);
		if (at === path.dirname(at)) break;
	}
}
function fromRoot(root: string) {
	if (typeof root !== 'string' || !root) throw new Error('root must be a path');
	realPath(root, true);
	return assembleNativeSchema(NATIVE_SCHEMA_INPUTS.map(pin => {
		const file = path.resolve(root, pin.path);
		realPath(file, false);
		return { path: pin.path, bytes: readFileSync(file) };
	}));
}
function files(plan: ReturnType<typeof assembleNativeSchema>) {
	return new Map([[SQL_FILE, plan.sql], ['schema.json', plan.manifestText], ...plan.manifest.targets.map(t => [t.configFile, t.configText] as [string, string])]);
}

/** Creates a new stage only; no Git, process execution, environment or provider access. */
export function prepareNativeSchema(value: { root: string; out: string }) {
	exact(value, ['root', 'out'], 'prepare');
	const plan = fromRoot(value.root);
	if (typeof value.out !== 'string' || !value.out) throw new Error('out must be a path');
	const out = path.resolve(value.out);
	realPath(path.dirname(out), true);
	if (existsSync(out)) throw new Error('schema out must not exist');
	mkdirSync(out);
	try {
		mkdirSync(path.join(out, 'migrations'));
		for (const [file, bytes] of files(plan)) writeFileSync(path.join(out, file), bytes, { flag: 'wx', mode: 0o644 });
		return readNativeSchema({ root: value.root, stage: out });
	} catch (error) { rmSync(out, { recursive: true, force: true }); throw error; }
}

/** Re-reads pinned sources AND exact staged bytes immediately before each parent's execution. */
export function readNativeSchema(value: { root: string; stage: string }) {
	exact(value, ['root', 'stage'], 'read');
	const plan = fromRoot(value.root);
	if (typeof value.stage !== 'string' || !value.stage) throw new Error('stage must be a path');
	const stage = path.resolve(value.stage);
	realPath(stage, true);
	const expected = files(plan);
	const entries: string[] = [];
	for (const name of readdirSync(stage)) {
		if (name === 'migrations') {
			realPath(path.join(stage, name), true);
			for (const migration of readdirSync(path.join(stage, name))) entries.push(`${name}/${migration}`);
		} else entries.push(name);
	}
	if (entries.length !== expected.size || entries.some(name => !expected.has(name))) throw new Error('unexpected or missing schema stage entries');
	for (const [file, bytes] of expected) {
		const full = path.join(stage, file);
		realPath(full, false);
		if (!readFileSync(full).equals(Buffer.from(bytes))) throw new Error(`${file}: staged bytes differ from pinned schema plan`);
	}
	return freeze({ stage, ...plan });
}

/** Parent-only execution seam. Returns a fixed approved target; never executes it. */
export function checkNativeSchemaInvocation(value: { root: string; stage: string; cwd: string; slot: NativeSchemaSlot; argv: readonly string[] }) {
	exact(value, ['root', 'stage', 'cwd', 'slot', 'argv'], 'invocation');
	const checked = readNativeSchema({ root: value.root, stage: value.stage });
	const target = checked.manifest.targets.find(t => t.slot === value.slot);
	if (!target) throw new Error('not an approved client database target');
	if (typeof value.cwd !== 'string') throw new Error('cwd must be a path');
	realPath(value.cwd, true);
	if (path.resolve(value.cwd) !== checked.stage || JSON.stringify(value.argv) !== JSON.stringify(target.argv)) throw new Error('invocation differs from exact schema plan');
	return freeze({ ...checked, target });
}
