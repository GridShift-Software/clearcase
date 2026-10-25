/// <reference types="node" />
// The file-checking owner explicitly needs Node types, including in native-alpha's types:[] private check.
// Separate first-deployment profile. Does not relax native/1's custom-domain policy.
// No provider/process/environment access. Only prepare/read touch files; plan is deterministic.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { checkNativeArtifact, nativeWalk, readRegular } from '../probes/target.ts';
import { NATIVE_STAGED, parseNativeJson } from './pipeline.ts';
import { validateBuildStamp } from '../../src/lib/server/runtime/build.ts';

export const WORKERS_DEV_BOOTSTRAP_SCHEMA = 'clearcase.workers-dev-bootstrap/1';
export type BootstrapSlot = 'client-a' | 'client-b' | 'staff';
export type BootstrapSettings = {
	pins: { source: string; artifact: string; entry: string };
	compatibilityDate: string;
	compatibilityFlags: ['nodejs_compat'];
};
const ACCOUNT = 'fb4c31b91c5d89b7a54afbdc34823170';
const SLOTS = ['client-a', 'client-b', 'staff'] as const;
const CLIENTS = {
	'client-a': { worker: 'cc-sbx-a-20261023', database: 'cc-sbx-a-20261023-db', uuid: 'cd257736-7bf3-49f6-8544-ac58c2207802', bucket: 'cc-sbx-a-20261023-files' },
	'client-b': { worker: 'cc-sbx-b-20261023', database: 'cc-sbx-b-20261023-db', uuid: '3322ef6b-6735-4922-b029-8fb58f06f623', bucket: 'cc-sbx-b-20261023-files' },
} as const;
const MANIFEST = 'bootstrap.json';
const sha = (bytes: string | Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function exact(value: unknown, keys: readonly string[], at: string): asserts value is Record<string, unknown> {
	if (!object(value) || Object.keys(value).length !== keys.length || keys.some((k) => !Object.hasOwn(value, k))) throw new Error(`${at}: expected exactly ${keys.join(', ')}; overrides and unknown keys are refused`);
}
function settings(value: unknown): BootstrapSettings {
	exact(value, ['pins', 'compatibilityDate', 'compatibilityFlags'], 'settings');
	exact(value.pins, ['source', 'artifact', 'entry'], 'external pins');
	if (typeof value.pins.source !== 'string' || !/^[0-9a-f]{40}$/.test(value.pins.source)) throw new Error('external source pin must be a full Git SHA');
	for (const k of ['artifact', 'entry']) if (typeof value.pins[k] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value.pins[k])) throw new Error(`external ${k} pin must be sha256:<64 lowercase hex>`);
	const date = value.compatibilityDate;
	if (typeof date !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('compatibilityDate must be a real YYYY-MM-DD date');
	if (JSON.stringify(value.compatibilityFlags) !== '["nodejs_compat"]') throw new Error('bootstrap requires exactly nodejs_compat; the parent must build for this flag');
	return structuredClone(value) as BootstrapSettings;
}
function freeze<T>(value: T): T {
	if (value !== null && typeof value === 'object') {
		Object.values(value).forEach(freeze);
		Object.freeze(value);
	}
	return value;
}

/** No files or provider state read. Pins must come from the parent's reviewed build, never from a stage. */
export function planWorkersDevBootstrap(value: unknown) {
	const s = settings(value);
	const targets = SLOTS.map((slot) => {
		const client = slot === 'staff' ? null : CLIENTS[slot];
		const config = {
			name: client?.worker ?? 'cc-sbx-staff-20261023', account_id: ACCOUNT,
			main: NATIVE_STAGED.entry, no_bundle: true, find_additional_modules: false, minify: false,
			compatibility_date: s.compatibilityDate, compatibility_flags: s.compatibilityFlags,
			// Workers Free enforces its own CPU ceiling and rejects even a 10ms custom limit.
			send_metrics: false, workers_dev: true, preview_urls: false, routes: [],
			assets: { directory: NATIVE_STAGED.assets, binding: 'ASSETS' },
			vars: { CLEARCASE_INSTANCE_ROLE: client ? 'client' : 'staff', CLEARCASE_CLIENT_ID: client ? slot : '' },
			// No migrations, secrets, service bindings or raw config escape hatch. Staff has no client stores.
			...(client ? {
				d1_databases: [{ binding: 'DB', database_name: client.database, database_id: client.uuid }],
				r2_buckets: [{ binding: 'BUCKET', bucket_name: client.bucket, jurisdiction: 'eu' }],
			} : {}),
		};
		const configFile = `${slot}.wrangler.json`;
		const configText = json(config);
		return {
			slot, role: client ? 'client' : 'staff', clientId: client ? slot : null,
			configFile, configText, configSha256: sha(configText),
			argv: ['wrangler', 'deploy', '--config', configFile],
			// Desired policy, not fresh provider evidence. D1 jurisdiction is NOT a Wrangler binding key.
			stores: client ? { d1Jurisdiction: 'eu', r2Jurisdiction: 'eu', r2Public: false, r2DevUrl: false } : null,
			readiness: client ? 'services-unconfigured' : 'unconfigured-portal-shell',
		};
	});
	return freeze({ schema: WORKERS_DEV_BOOTSTRAP_SCHEMA, settings: s, targets });
}

/** Extract the existing build:hosted JSON string marker, without executing uploaded code. External entry pins
 * remain the authority for the reviewed code: finding a marker alone is not proof that any arbitrary code is safe. */
function productionStamp(entry: string, source: string) {
	const stamps = new Map<string, ReturnType<typeof validateBuildStamp>>();
	const ast = ts.createSourceFile('_worker.js', entry, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const visit = (node: ts.Node): void => {
		if (ts.isStringLiteralLike(node) && node.text.startsWith('{')) {
			let candidate: unknown;
			try { candidate = parseNativeJson(node.text); } catch { candidate = null; }
			if (object(candidate) && Object.hasOwn(candidate, 'revision') && Object.hasOwn(candidate, 'profile') && Object.hasOwn(candidate, 'target')) {
				const stamp = validateBuildStamp(candidate);
				if (stamp.profile !== 'production' || stamp.target !== 'cloudflare' || stamp.revision !== source || stamp.dirty || stamp.exported) throw new Error('embedded production marker must name the external source pin and a clean, non-exported production build');
				stamps.set(JSON.stringify(stamp), stamp);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(ast);
	if (stamps.size !== 1) throw new Error('entry must hold exactly one distinct build:hosted production marker');
	return [...stamps.values()][0]!;
}

function checkedArtifact(artifact: string, s: BootstrapSettings) {
	const checked = checkNativeArtifact({ artifact, compatibilityFlags: s.compatibilityFlags });
	if (checked.problems.length || !checked.digest || !checked.upload) throw new Error(checked.problems.join('\n') || 'artifact could not be checked');
	if (checked.digest !== s.pins.artifact) throw new Error('artifact bytes differ from external artifact pin');
	if (checked.upload.entry.sha256 !== s.pins.entry) throw new Error('entry bytes differ from external entry pin');
	const read = (relative: string) => {
		const bytes = readRegular(path.join(artifact, relative.slice('artifact/'.length)), artifact);
		const file = checked.upload!.files.find((f) => f.path === relative);
		if (!file || file.sha256 !== sha(bytes)) throw new Error(`${relative} changed during verification`);
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	};
	const version = parseNativeJson(read(NATIVE_STAGED.version));
	exact(version, ['version'], NATIVE_STAGED.version);
	if (version.version !== s.pins.source) throw new Error('version.json differs from external source pin');
	const stamp = productionStamp(read(NATIVE_STAGED.entry), s.pins.source);
	return { artifactSha256: checked.digest, stamp, upload: checked.upload };
}
function record(plan: ReturnType<typeof planWorkersDevBootstrap>, artifact: ReturnType<typeof checkedArtifact>) {
	// nativeUpload's invocation belongs to native/1, not this profile. Only targets[].argv is executable here.
	const { invocation: _nativeInvocation, ...upload } = artifact.upload;
	return { ...plan, ...artifact, upload, deployed: false, providerProof: false };
}
function realAncestors(dir: string) {
	for (let at = path.resolve(dir); ; at = path.dirname(at)) {
		if (!lstatSync(at).isDirectory()) throw new Error(`${at}: expected a real directory, not a symlink`);
		if (at === path.dirname(at)) break;
	}
}

/** File-checking owner API: emits configs + manifest and copies ONE unchanged artifact, never builds or uploads.
 * out must not exist; all three invocations use out as cwd. A failed preparation removes only its newly made out. */
export function prepareWorkersDevBootstrap(value: { artifact: string; out: string; settings: unknown }) {
	exact(value, ['artifact', 'out', 'settings'], 'prepare');
	const plan = planWorkersDevBootstrap(value.settings);
	if (typeof value.artifact !== 'string' || typeof value.out !== 'string') throw new Error('artifact and out must be paths');
	const artifact = path.resolve(value.artifact), out = path.resolve(value.out);
	realAncestors(path.dirname(out));
	realAncestors(artifact);
	if (existsSync(out)) throw new Error('bootstrap out must not exist');
	if (out.startsWith(`${artifact}${path.sep}`)) throw new Error('bootstrap out cannot be inside the source artifact');
	checkedArtifact(artifact, plan.settings);
	mkdirSync(out);
	try {
		mkdirSync(path.join(out, 'artifact'));
		for (const e of nativeWalk(artifact)) {
			const destination = path.join(out, 'artifact', e.rel);
			if (e.dir) mkdirSync(destination);
			else writeFileSync(destination, readRegular(path.join(artifact, e.rel), artifact), { flag: 'wx', mode: 0o644 });
		}
		const manifest = record(plan, checkedArtifact(path.join(out, 'artifact'), plan.settings));
		for (const t of plan.targets) writeFileSync(path.join(out, t.configFile), t.configText, { flag: 'wx', mode: 0o644 });
		writeFileSync(path.join(out, MANIFEST), json(manifest), { flag: 'wx', mode: 0o644 });
		return readWorkersDevBootstrap({ stage: out, settings: value.settings });
	} catch (e) {
		rmSync(out, { recursive: true, force: true });
		throw e;
	}
}

/** Recheck immediately before EACH upload with external pins. Exact canonical bytes prevent config/binding overrides,
 * extra files (including dotenv), stale manifests, and code/asset edits. Same-user check-to-upload races remain parent-owned. */
export function readWorkersDevBootstrap(value: { stage: string; settings: unknown }) {
	exact(value, ['stage', 'settings'], 'read');
	const plan = planWorkersDevBootstrap(value.settings);
	if (typeof value.stage !== 'string') throw new Error('stage must be a path');
	const stage = path.resolve(value.stage);
	realAncestors(stage);
	const facts = checkedArtifact(path.join(stage, 'artifact'), plan.settings);
	const manifest = record(plan, facts);
	const expected = new Map<string, boolean>([[MANIFEST, false], ['artifact', true]]);
	for (const t of plan.targets) expected.set(t.configFile, false);
	for (const f of facts.upload.files) {
		expected.set(f.path, false);
		for (let dir = path.posix.dirname(f.path); dir !== '.'; dir = path.posix.dirname(dir)) expected.set(dir, true);
	}
	const entries = nativeWalk(stage);
	if (entries.length !== expected.size || entries.some((e) => expected.get(e.rel.split(path.sep).join('/')) !== e.dir)) throw new Error('bootstrap stage has unexpected or missing files/directories');
	const match = (name: string, text: string) => {
		if (!readRegular(path.join(stage, name), stage).equals(Buffer.from(text))) throw new Error(`${name}: bytes differ from the exact bootstrap profile`);
	};
	for (const t of plan.targets) match(t.configFile, t.configText);
	const manifestText = json(manifest);
	match(MANIFEST, manifestText);
	return freeze({ stage, manifest, manifestText, manifestSha256: sha(manifestText) });
}

/** Read-only upload guard. No extra flags, alternative cwd, environment selection, name or config override. */
export function checkWorkersDevBootstrapInvocation(value: { stage: string; settings: unknown; cwd: string; slot: BootstrapSlot; argv: readonly string[] }) {
	exact(value, ['stage', 'settings', 'cwd', 'slot', 'argv'], 'invocation');
	const checked = readWorkersDevBootstrap({ stage: value.stage, settings: value.settings });
	const target = checked.manifest.targets.find((t) => t.slot === value.slot);
	if (!target) throw new Error('not an approved bootstrap slot');
	realAncestors(value.cwd);
	if (realpathSync(value.cwd) !== checked.stage) throw new Error('upload cwd is not the checked bootstrap stage');
	if (JSON.stringify(value.argv) !== JSON.stringify(target.argv)) throw new Error('upload argv is not exactly the bounded bootstrap invocation');
	return checked;
}
