/// <reference types="node" />
// The file-checking owner explicitly needs Node types, including in native-alpha's types:[] private check.
// Separate first-deployment profile. Does not relax native/1's custom-domain policy.
// One Worker serves ONE origin: CLEARCASE_APP_ORIGIN, the manifest hostname and Clerk's fixed sign-in callbacks all name it, and the runtime
// refuses any pair that differs. `origin` is the single switch between the two pinned sets; workers.dev stays enabled as a static fallback.
// No provider/process/environment access. Only prepare/read touch files; plan is deterministic.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { types } from 'node:util';
import ts from 'typescript';
import { checkNativeArtifact, nativeWalk, readRegular } from '../probes/target.ts';
import { CLERK_ENV } from '../../src/lib/auth/clerk/config.ts';
import { APPROVED_NATIVE_SCOPE } from './controls.ts';
import { NATIVE_BROWSER_BINDING, NATIVE_STAGED, parseNativeJson } from './pipeline.ts';
import {
	NATIVE_RUNTIME_CONFIG_MAX_BYTES, NATIVE_RUNTIME_CONFIG_VAR, NATIVE_RUNTIME_SECRET_NAMES, nativeRuntimeConfigDiagnostic, planNativeRuntimeConfig,
	type NativeRuntimeConfigPlan,
} from './runtime-config.ts';
import { validateBuildStamp } from '../../src/lib/server/runtime/build.ts';

export const WORKERS_DEV_BOOTSTRAP_SCHEMA = 'clearcase.workers-dev-bootstrap/1';
export type BootstrapSlot = 'client-a' | 'client-b' | 'staff';
export type BootstrapClientSlot = Exclude<BootstrapSlot, 'staff'>;
/** Which pinned hostname set the planned runtime configuration must name. Absent means 'workers-dev'. */
export type BootstrapOrigin = 'workers-dev' | 'custom-domain';
export type BootstrapSettings = {
	pins: { source: string; artifact: string; entry: string };
	compatibilityDate: string;
	compatibilityFlags: ['nodejs_compat'];
	/** Explicit opt-in, absent by default: the client slots (distinct, in client-a, client-b order) that bind exactly BROWSER. Staff is refused. */
	browserClients?: readonly BootstrapClientSlot[];
	/** Explicit, absent by default: the INPUT of planNativeRuntimeConfig (never a vars map). Its validated public vars are merged into the matching
	 * client configs; every planned tuple must be this bootstrap's own, and the planned renderers must equal browserClients. */
	runtimeConfig?: unknown;
	/** Explicit, absent by default (= 'workers-dev'): the one origin set the planned hostnames and app origins must equal. */
	origin?: BootstrapOrigin;
};
const ACCOUNT = 'fb4c31b91c5d89b7a54afbdc34823170';
/** The account's workers.dev subdomain: public provider metadata observed from the account API and every live URL, pinned beside ACCOUNT. */
const WORKERS_DEV_SUBDOMAIN = 'shiny-sunset-211d';
const SLOTS = ['client-a', 'client-b', 'staff'] as const;
const CLIENTS = {
	'client-a': { worker: 'cc-sbx-a-20261023', database: 'cc-sbx-a-20261023-db', uuid: 'cd257736-7bf3-49f6-8544-ac58c2207802', bucket: 'cc-sbx-a-20261023-files' },
	'client-b': { worker: 'cc-sbx-b-20261023', database: 'cc-sbx-b-20261025-r1-db', uuid: '7c340891-9fcc-4398-8128-68abe726f130', bucket: 'cc-sbx-b-20261023-files' },
} as const;
/** The custom-domain hostname of a slot: this module owns no hostname text, it reads the reviewed scope and checks it names the same Worker. */
function customHostname(slot: BootstrapClientSlot): string {
	const approved = APPROVED_NATIVE_SCOPE.clients.find((c) => c.client === slot);
	if (!approved || approved.worker !== CLIENTS[slot].worker || approved.hostname.includes('*') || !approved.hostname.endsWith(`.${APPROVED_NATIVE_SCOPE.zone.name}`))
		throw new Error(`${slot}: the approved custom-domain scope does not name this Worker inside the approved zone`);
	return approved.hostname;
}
/** The one hostname a client Worker may serve under each origin. Anything else, a wildcard or another zone included, never equals it. */
export const bootstrapHostname = (slot: BootstrapClientSlot, origin: BootstrapOrigin = 'workers-dev') =>
	origin === 'custom-domain' ? customHostname(slot) : `${CLIENTS[slot].worker}.${WORKERS_DEV_SUBDOMAIN}.workers.dev`;
const MANIFEST = 'bootstrap.json';
const sha = (bytes: string | Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function exact(value: unknown, keys: readonly string[], at: string): asserts value is Record<string, unknown> {
	if (!object(value) || Object.keys(value).length !== keys.length || keys.some((k) => !Object.hasOwn(value, k))) throw new Error(`${at}: expected exactly ${keys.join(', ')}; overrides and unknown keys are refused`);
}
// Caller-owned inputs are read ONCE, from own enumerable data descriptors, into a fresh null-prototype record or array:
// never a getter, proxy trap, iterator, inherited field, toJSON or overridden array method. Validation and use share that snapshot.
const plain = (value: unknown): value is object => typeof value === 'object' && value !== null && !types.isProxy(value);
function capture(value: unknown, required: readonly string[], at: string, optional: readonly string[] = []): Record<string, unknown> {
	const refuse = () => new Error(`${at}: expected exactly ${[...required, ...optional.map((k) => `[${k}]`)].join(', ')}; overrides, unknown, inherited and accessor fields are refused`);
	if (!plain(value) || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw refuse();
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const keys = Reflect.ownKeys(descriptors);
	if (keys.some((k) => typeof k !== 'string' || (!required.includes(k) && !optional.includes(k))) || required.some((k) => !Object.hasOwn(descriptors, k))) throw refuse();
	const captured: Record<string, unknown> = Object.create(null);
	for (const key of keys as string[]) {
		const d = descriptors[key]!;
		if (!Object.hasOwn(d, 'value') || !d.enumerable) throw refuse();
		captured[key] = d.value;
	}
	return captured;
}
/** A fresh copy of a dense plain array of at most `max` primitive strings, or null for anything else (holes, accessors,
 * extra or inherited members, and elements that are objects, boxed strings or numbers): no element is coerced or called. */
function strings(value: unknown, max: number): string[] | null {
	if (!plain(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const length = (descriptors.length as PropertyDescriptor | undefined)?.value;
	if (typeof length !== 'number' || length > max || Reflect.ownKeys(descriptors).length !== length + 1) return null;
	const captured: string[] = [];
	for (let i = 0; i < length; i++) {
		const d = descriptors[String(i)];
		if (!d || !Object.hasOwn(d, 'value') || !d.enumerable || typeof d.value !== 'string') return null;
		captured.push(d.value);
	}
	return captured;
}
function settings(value: unknown) {
	const top = capture(value, ['pins', 'compatibilityDate', 'compatibilityFlags'], 'settings', ['browserClients', 'runtimeConfig', 'origin']);
	const pins = capture(top.pins, ['source', 'artifact', 'entry'], 'external pins');
	if (typeof pins.source !== 'string' || !/^[0-9a-f]{40}$/.test(pins.source)) throw new Error('external source pin must be a full Git SHA');
	for (const k of ['artifact', 'entry']) if (typeof pins[k] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(pins[k] as string)) throw new Error(`external ${k} pin must be sha256:<64 lowercase hex>`);
	const date = top.compatibilityDate;
	if (typeof date !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('compatibilityDate must be a real YYYY-MM-DD date');
	const flags = strings(top.compatibilityFlags, 1);
	if (flags?.length !== 1 || flags[0] !== 'nodejs_compat') throw new Error('bootstrap requires exactly nodejs_compat; the parent must build for this flag');
	let browserClients: BootstrapClientSlot[] | undefined;
	if (Object.hasOwn(top, 'browserClients')) {
		const clients = strings(top.browserClients, SLOTS.length);
		if (!clients?.length || clients.some((c) => c !== 'client-a' && c !== 'client-b')) throw new Error('browserClients must be a non-empty plain list of client-a and client-b; staff, any other slot, holes, accessors and overridden members are refused');
		if (JSON.stringify(clients) !== JSON.stringify(SLOTS.filter((c) => clients.includes(c)))) throw new Error('browserClients must list each client at most once, in client-a, client-b order');
		browserClients = clients as BootstrapClientSlot[];
	}
	let origin: BootstrapOrigin | undefined;
	if (Object.hasOwn(top, 'origin')) {
		if (top.origin !== 'workers-dev' && top.origin !== 'custom-domain') throw new Error("origin must be exactly 'workers-dev' or 'custom-domain'");
		origin = top.origin;
	}
	// The planner snapshots its own input here, inside planning, so before any file is read; nothing later touches the caller's object.
	const runtime = Object.hasOwn(top, 'runtimeConfig') ? runtimeConfig(top.runtimeConfig, browserClients ?? [], origin ?? 'workers-dev') : null;
	const resolved: BootstrapSettings = {
		pins: { source: pins.source, artifact: pins.artifact as string, entry: pins.entry as string }, compatibilityDate: date, compatibilityFlags: ['nodejs_compat'],
		...(browserClients ? { browserClients } : {}), ...(origin ? { origin } : {}),
	};
	return { settings: resolved, runtime };
}

// The only variable names the planner may hand a Worker: its public Clerk values and the settings blob. Secret bindings, the instance role
// and anything else are refused here even if a changed planner emitted them (names, not values, are all this module reads of a refusal).
const SECRET_SET = new Set<string>(NATIVE_RUNTIME_SECRET_NAMES);
const PUBLIC_VARS = new Set<string>([
	CLERK_ENV.clientId, CLERK_ENV.appOrigin, CLERK_ENV.client.publishableKey, CLERK_ENV.staff.publishableKey, CLERK_ENV.apiUrl, CLERK_ENV.mfaRequired,
	CLERK_ENV.signInUrl, CLERK_ENV.staffSignInUrl, CLERK_ENV.audience, NATIVE_RUNTIME_CONFIG_VAR,
].filter((name) => !SECRET_SET.has(name)));
const TUPLE_KEYS = ['clientId', 'hostname', 'worker', 'd1DatabaseId', 'd1DatabaseName', 'r2Bucket'] as const;
type RuntimeClient = { vars: Readonly<Record<string, string>>; requiredSecretNames: readonly string[]; renders: boolean; fileSha256: string };
type RuntimePlan = { record: { manifestSha256: string; manifest: NativeRuntimeConfigPlan['manifest'] }; clients: ReadonlyMap<BootstrapClientSlot, RuntimeClient> };
const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const deny = (why: string): never => { throw new Error(`runtimeConfig: ${why}`); };

/** One planner result, checked against this bootstrap's own targets. Only fixed text is thrown: the planner's issued diagnostic or a static
 * label, never an input value, key, hostname or thrown value. Plain `unknown` in; frozen derived records out. */
function runtimeConfig(input: unknown, browserClients: readonly BootstrapClientSlot[], origin: BootstrapOrigin): RuntimePlan {
	let plan: NativeRuntimeConfigPlan;
	try {
		plan = planNativeRuntimeConfig(input);
	} catch (caught) {
		return deny(nativeRuntimeConfigDiagnostic(caught) ?? 'refused by the runtime configuration planner');
	}
	const clients = new Map<BootstrapClientSlot, RuntimeClient>();
	for (const file of plan.clients) {
		const slot = file.clientId;
		if (slot !== 'client-a' && slot !== 'client-b') deny('a planned client is not a bootstrap client slot');
		const target = CLIENTS[slot as BootstrapClientSlot];
		if (clients.has(slot as BootstrapClientSlot)) deny('a client may be planned once');
		const names = Object.keys(file.vars);
		if (names.some((name) => !PUBLIC_VARS.has(name)) || names.some((name) => typeof file.vars[name] !== 'string' || Buffer.byteLength(file.vars[name]!) > NATIVE_RUNTIME_CONFIG_MAX_BYTES))
			deny('the planned variables are not exactly the planner public values');
		if (file.vars[CLERK_ENV.clientId] !== slot) deny('the planned client id is not the bootstrap slot');
		if (!sameList(file.secrets, NATIVE_RUNTIME_SECRET_NAMES)) deny('the planned secret names are not the fixed list');
		const bindings = Object.keys(file.bindings);
		if (!sameList(bindings, ['d1', 'r2', 'assets', 'browser']) || file.bindings.d1 !== 'DB' || file.bindings.r2 !== 'BUCKET' || file.bindings.assets !== 'ASSETS' ||
			(file.bindings.browser !== null && file.bindings.browser !== NATIVE_BROWSER_BINDING)) deny('the planned bindings are not DB, BUCKET, ASSETS and an optional BROWSER');
		let deployment: Record<string, unknown> | null = null;
		try { deployment = (JSON.parse(file.vars[NATIVE_RUNTIME_CONFIG_VAR] ?? '') as { deployment?: Record<string, unknown> }).deployment ?? null; } catch { /* refused below */ }
		const expected = { clientId: slot, hostname: file.hostname, worker: target.worker, d1DatabaseId: target.uuid, d1DatabaseName: target.database, r2Bucket: target.bucket };
		if (!deployment || !sameList(Object.keys(deployment), TUPLE_KEYS) || TUPLE_KEYS.some((key) => deployment![key] !== expected[key]) || file.worker !== target.worker)
			deny('a planned deployment tuple is not this bootstrap target');
		// workers.dev serves <worker>.<account subdomain>.workers.dev: the subdomain is this account's pinned one, never the caller's.
		// The custom domain is this client's own single label under the approved zone; every other hostname, a wildcard included, refuses.
		if (origin === 'custom-domain' && (file.hostname.includes('*') || !file.hostname.endsWith(`.${APPROVED_NATIVE_SCOPE.zone.name}`))) deny('a planned hostname is a wildcard or outside the approved custom-domain zone');
		if (file.hostname !== bootstrapHostname(slot as BootstrapClientSlot, origin)) deny(origin === 'custom-domain' ? 'a planned hostname is not this client on its own custom domain' : 'a planned hostname is not this Worker on the pinned workers.dev account subdomain');
		const record = plan.manifest.clients.find((c) => c.clientId === slot);
		if (!record || record.browserBinding !== file.bindings.browser) deny('the planner manifest disagrees with the planned client file');
		clients.set(slot as BootstrapClientSlot, freeze({ vars: { ...file.vars }, requiredSecretNames: [...file.secrets], renders: file.bindings.browser !== null, fileSha256: record!.sha256 }));
	}
	// The planned renderers and BROWSER bindings come from one decision: the explicit plan. browserClients may only repeat it.
	const renderers = SLOTS.filter((slot): slot is BootstrapClientSlot => slot !== 'staff' && clients.get(slot)?.renders === true);
	if (!sameList(renderers, browserClients)) deny('browserClients must list exactly the clients the plan renders');
	return freeze({ record: { manifestSha256: sha(plan.manifestText), manifest: plan.manifest }, clients });
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
	const { settings: s, runtime } = settings(value);
	const targets = SLOTS.map((slot) => {
		const planned = slot === 'staff' ? undefined : runtime?.clients.get(slot);
		const client = slot === 'staff' ? null : CLIENTS[slot];
		const browser = slot !== 'staff' && s.browserClients?.includes(slot) === true;
		const config = {
			name: client?.worker ?? 'cc-sbx-staff-20261023', account_id: ACCOUNT,
			main: NATIVE_STAGED.entry, no_bundle: true, find_additional_modules: false, minify: false,
			compatibility_date: s.compatibilityDate, compatibility_flags: s.compatibilityFlags,
			// Workers Free enforces its own CPU ceiling and rejects even a 10ms custom limit.
			send_metrics: false, workers_dev: true, preview_urls: false, routes: [],
			assets: { directory: NATIVE_STAGED.assets, binding: 'ASSETS' },
			// Role and client id come first and are locked: the planned CLEARCASE_CLIENT_ID is checked equal, so the merge never moves them.
			vars: { CLEARCASE_INSTANCE_ROLE: client ? 'client' : 'staff', CLEARCASE_CLIENT_ID: client ? slot : '', ...planned?.vars },
			// No migrations, secrets, service bindings or raw config escape hatch. Staff has no client stores.
			...(client ? {
				d1_databases: [{ binding: 'DB', database_name: client.database, database_id: client.uuid }],
				r2_buckets: [{ binding: 'BUCKET', bucket_name: client.bucket, jurisdiction: 'eu' }],
				// Controlled capability, not service proof or a budget: only the exact binding, never remote/proxy/env variants.
				...(browser ? { browser: { binding: NATIVE_BROWSER_BINDING } } : {}),
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
			...(browser ? { browser: { binding: NATIVE_BROWSER_BINDING } } : {}),
			// Names and the planner file's hash only: secret VALUES are the parent's, supplied out of band, and no secret binding is in the config.
			...(planned ? { runtime: { varNames: Object.keys(planned.vars), requiredSecretNames: planned.requiredSecretNames, plannerFileSha256: planned.fileSha256 } } : {}),
		};
	});
	return freeze({ schema: WORKERS_DEV_BOOTSTRAP_SCHEMA, settings: s, targets, ...(runtime ? { runtimeConfig: runtime.record } : {}) });
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
export function prepareWorkersDevBootstrap(input: { artifact: string; out: string; settings: unknown }) {
	const value = capture(input, ['artifact', 'out', 'settings'], 'prepare');
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
		return readPlanned(out, plan);
	} catch (e) {
		rmSync(out, { recursive: true, force: true });
		throw e;
	}
}

/** Recheck immediately before EACH upload with external pins. Exact canonical bytes prevent config/binding overrides,
 * extra files (including dotenv), stale manifests, and code/asset edits. Same-user check-to-upload races remain parent-owned. */
export function readWorkersDevBootstrap(input: { stage: string; settings: unknown }) {
	const value = capture(input, ['stage', 'settings'], 'read');
	return readPlanned(value.stage, planWorkersDevBootstrap(value.settings));
}
/** The recheck against ONE already captured plan, so prepare and invocation never re-read the caller's settings. */
function readPlanned(stagePath: unknown, plan: ReturnType<typeof planWorkersDevBootstrap>) {
	if (typeof stagePath !== 'string') throw new Error('stage must be a path');
	const stage = path.resolve(stagePath);
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
export function checkWorkersDevBootstrapInvocation(input: { stage: string; settings: unknown; cwd: string; slot: BootstrapSlot; argv: readonly string[] }) {
	const value = capture(input, ['stage', 'settings', 'cwd', 'slot', 'argv'], 'invocation');
	// Every caller value is captured and typed before the stage is read; afterwards only these copies are compared.
	const argv = strings(value.argv, 64);
	if (!argv) throw new Error('upload argv is not a plain list of primitive strings, so not the bounded bootstrap invocation');
	if (typeof value.cwd !== 'string') throw new Error('upload cwd must be a path');
	const slot = value.slot;
	if (typeof slot !== 'string' || !(SLOTS as readonly string[]).includes(slot)) throw new Error('not an approved bootstrap slot');
	const checked = readPlanned(value.stage, planWorkersDevBootstrap(value.settings));
	const target = checked.manifest.targets.find((t) => t.slot === slot)!;
	realAncestors(value.cwd);
	if (realpathSync(value.cwd) !== checked.stage) throw new Error('upload cwd is not the checked bootstrap stage');
	if (JSON.stringify(argv) !== JSON.stringify(target.argv)) throw new Error('upload argv is not exactly the bounded bootstrap invocation (a plain list of strings)');
	return checked;
}
