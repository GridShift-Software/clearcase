/// <reference types="node" />
// Offline only: no credentials, environment, Git, subprocess, network or provider access. Staged output is source-only
// settings: it proves no provider resource, Clerk instance, login, tenant, Browser allocation or running Worker.
import { createHash } from 'node:crypto';
import { constants, chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { types } from 'node:util';
import { CLERK_ENV, readClerkIdentityConfig } from '../../src/lib/auth/clerk/config.ts';
import { CEILINGS as AUDIT_CEILINGS, auditConfig } from '../../src/lib/audit/config.ts';
import { storageBudgets } from '../../src/lib/storage/cloud/budgets.ts';
import { storageQuotas } from '../../src/lib/storage/cloud/quotas.ts';
import { intakeBudget } from '../../src/lib/submissions/budget.ts';
import { nativeImportBudget } from '../../src/lib/results-review/native/budget.ts';
import { USER_WORK_CEILINGS, userWorkConfig } from '../../src/lib/user-work/hosted/index.ts';
import { hostedValidationPolicy } from '../../src/lib/server/runtime/hosted/validation-policy.ts';
import { NATIVE_PDF_RENDER_CEILINGS } from '../../src/lib/viewer/hosted/native-render-check.ts';
import { resolveExactDeployment, validateClientManifest, type ExactDeploymentTuple } from '../../src/lib/tenancy/manifest.ts';
import { NATIVE_BROWSER_BINDING, parseNativeJson } from './pipeline.ts';

export const NATIVE_RUNTIME_CONFIG_SCHEMA = 'clearcase.native-runtime-config/1';
export const NATIVE_RUNTIME_CLIENT_SCHEMA = 'clearcase.native-runtime-config.client/1';
/** The schema string hostedServices' nativeContext requires inside CLEARCASE_NATIVE_CONFIG. */
export const NATIVE_RUNTIME_SETTINGS_SCHEMA = 'clearcase.native-runtime/1';
export const NATIVE_RUNTIME_CONFIG_VAR = 'CLEARCASE_NATIVE_CONFIG';
export const NATIVE_RUNTIME_CONFIG_MANIFEST = 'runtime-config.json';
/**
 * UTF-8 byte cap for EVERY emitted variable value. Cloudflare documents "5 KB" per environment variable without saying whether that
 * is 5000 or 5120 bytes, so the cap is the conservative 5000: a value that fits is inside either reading. Larger refuses. The exact
 * byte at which the provider refuses, any variable count limit and any account limit are not claimed or checked here.
 */
export const NATIVE_RUNTIME_CONFIG_MAX_BYTES = 5000;
const MAX_CLIENTS = 8, MAX_NODES = 2048, MAX_DEPTH = 8, MAX_STRING = 8192, MAX_INPUT_BYTES = 262_144;
// native-render-check.ts keeps these private. The tests drive the real checker and read lease_ms from its reservation, so a
// drift in either constant fails there rather than silently under-planning the allocation.
const RENDER_CLEANUP_MS = 2_000, RENDER_IDLE_TAIL_MS = 60_000;
/** Worst-case reservation the real checker charges for one run, success included: run deadline + cleanup + idle tail. */
export const nativeRenderLeaseMs = (maxRunMs: number) => maxRunMs + RENDER_CLEANUP_MS + RENDER_IDLE_TAIL_MS;
const sha = (bytes: string | Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
function freeze<T>(value: T): T {
	if (value !== null && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
	return value;
}

// Every refusal is a fixed string built from static labels and positions. No input value, validator message or thrown value
// is ever read, coerced or echoed: a catch discards what it caught. The map answers only for errors this module issued.
const issued = new WeakMap<object, string>();
function refuse(message: string): never {
	const error = new Error(message);
	issued.set(error, message);
	throw error;
}
/** The immutable message of an error this module issued, else undefined. A lookup by identity never inspects the error. */
export function nativeRuntimeConfigDiagnostic(error: unknown): string | undefined {
	return typeof error === 'object' && error !== null ? issued.get(error) : undefined;
}
function guard<T>(at: string, work: () => T): T {
	try {
		return work();
	} catch (caught) {
		if (typeof caught === 'object' && caught !== null && issued.has(caught)) throw caught;
		return refuse(`${at}: refused by the current runtime validator`);
	}
}

// Caller data is read ONCE, from own data descriptors only, into a frozen null-prototype copy. A proxy is refused before any
// reflection, so no trap runs; a getter, iterator, toJSON, inherited field, symbol key, hole or subclass is never invoked.
type Plain = null | boolean | number | string | readonly Plain[] | { readonly [key: string]: Plain };
function snapshot(value: unknown, at: string, state: { nodes: number }, depth: number): Plain {
	if (++state.nodes > MAX_NODES) refuse(`${at}: too many values`);
	if (value === null || typeof value === 'boolean') return value;
	if (typeof value === 'number') return Number.isFinite(value) ? value : refuse(`${at}: not a finite number`);
	if (typeof value === 'string') return value.length <= MAX_STRING ? value : refuse(`${at}: string too long`);
	if (typeof value !== 'object' || depth >= MAX_DEPTH || types.isProxy(value)) return refuse(`${at}: not plain data`);
	const proto = Object.getPrototypeOf(value);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const keys = Reflect.ownKeys(descriptors);
	const data = (key: string): unknown => {
		const d = descriptors[key];
		if (!d || !Object.hasOwn(d, 'value') || d.enumerable !== true) refuse(`${at}: hidden, inherited or accessor field`);
		return d!.value;
	};
	if (Array.isArray(value)) {
		const length = descriptors.length?.value;
		if (proto !== Array.prototype || typeof length !== 'number' || length > MAX_CLIENTS * 2 || keys.length !== length + 1) refuse(`${at}: not a dense plain array`);
		return Object.freeze(Array.from({ length: length as number }, (_, i) => snapshot(data(String(i)), `${at}[${i}]`, state, depth + 1)));
	}
	if (proto !== Object.prototype && proto !== null) refuse(`${at}: not a plain object`);
	const copy: Record<string, Plain> = Object.create(null);
	for (const key of keys) {
		if (typeof key !== 'string') refuse(`${at}: symbol-keyed field`);
		Object.defineProperty(copy, key, { value: snapshot(data(key as string), `${at}.*`, state, depth + 1), enumerable: true });
	}
	return Object.freeze(copy);
}
const SECRET_SHAPES = [
	/\bsk_(?:test|live)_/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\./, /\bcf(?:at|ut|k)_[A-Za-z0-9]{8,}/i,
	/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/i, /\bwhsec_/i, /(?:api[_-]?token|api[_-]?key|secret|passw(?:or)?d|private[_-]?key)[A-Za-z0-9_-]*\s*[:=]/i,
];
function noSecrets(value: Plain, at: string): void {
	if (typeof value === 'string') { if (SECRET_SHAPES.some((shape) => shape.test(value))) refuse(`${at}: a secret-shaped value is refused (secret values never belong in this input)`); }
	else if (Array.isArray(value)) value.forEach((item, i) => noSecrets(item, `${at}[${i}]`));
	else if (value !== null && typeof value === 'object') for (const [key, item] of Object.entries(value)) { noSecrets(key, at); noSecrets(item, at); }
}
function capture(value: unknown, at: string): Plain {
	const plain = snapshot(value, at, { nodes: 0 }, 0);
	noSecrets(plain, at);
	return plain;
}
const isRecord = (v: Plain): v is { readonly [key: string]: Plain } => v !== null && typeof v === 'object' && !Array.isArray(v);
function exact(value: Plain, keys: readonly string[], at: string): { readonly [key: string]: Plain } {
	if (!isRecord(value)) return refuse(`${at}: expected an object`);
	const present = Object.keys(value);
	if (present.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) refuse(`${at}: expected exactly ${keys.join(', ')}; missing, unknown and defaulted fields are refused`);
	return value;
}
const text = (value: Plain, at: string): string => typeof value === 'string' && value !== '' ? value : refuse(`${at}: expected a non-empty string`);
const textOrNull = (value: Plain, at: string): string | null => value === null ? null : text(value, at);
const flag = (value: Plain, at: string): boolean => typeof value === 'boolean' ? value : refuse(`${at}: expected true or false`);
const count = (value: Plain, at: string): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : refuse(`${at}: expected a finite positive integer`);
/** A mutable ordinary copy for the current validators, which read plain objects and arrays. */
function thaw(value: Plain): unknown {
	if (Array.isArray(value)) return value.map(thaw);
	if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, thaw(v)]));
	return value;
}
function objectOf(value: Plain, at: string): unknown {
	if (!isRecord(value)) refuse(`${at}: expected an object, not JSON text`);
	return thaw(value);
}

const TUPLE_KEYS = ['clientId', 'hostname', 'worker', 'd1DatabaseId', 'd1DatabaseName', 'r2Bucket'] as const;
const CLIENT_KEYS = ['deployment', 'appOrigin', 'clerk', 'policy'] as const;
const CLERK_KEYS = ['clientPublishableKey', 'staffPublishableKey', 'apiUrl', 'signInUrl', 'staffSignInUrl', 'audience', 'mfaRequired'] as const;
const POLICY_KEYS = ['auditLimits', 'storageBudgets', 'storageQuotas', 'userWorkLimits', 'intakeBudget', 'importBudget', 'nativeRenderBudget'] as const;
const ALLOCATION_KEYS = ['maxConcurrentBrowsers', 'maxReservedBrowserMsPerDay'] as const;
/** Bindings the current hostedServices reads from env. BROWSER exists only for a client with an explicit render budget. */
const BINDINGS = { d1: 'DB', r2: 'BUCKET', assets: 'ASSETS' } as const;
export const NATIVE_RUNTIME_SECRET_NAMES = freeze([CLERK_ENV.client.secretKey, CLERK_ENV.client.jwtKey, CLERK_ENV.staff.secretKey, CLERK_ENV.staff.jwtKey] as const);
const STAFF = freeze({
	slot: 'staff', runtimeConfig: 'unsupported',
	reason: 'clerkIdentityProviderFromEnv needs a CLEARCASE_CLIENT_ID and both Clerk instances, and hostedServices reads no staff-only mode; no existing API configures a client-less identity-only staff Worker. It stays an unconfigured ASSETS-only shell and borrows no client database.',
});

function renderBudget(value: Plain, at: string): Readonly<Record<keyof typeof NATIVE_PDF_RENDER_CEILINGS, number>> | null {
	if (value === null) return null;
	const budget = exact(value, Object.keys(NATIVE_PDF_RENDER_CEILINGS), at);
	// Same rule as createNativePreviewRenderChecker's validation: each field a positive safe integer within its ceiling, case <= client.
	const out: Record<string, number> = {};
	for (const [key, ceiling] of Object.entries(NATIVE_PDF_RENDER_CEILINGS)) {
		const n = budget[key];
		if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0 || n > ceiling) refuse(`${at}.${key}: expected a positive integer within the renderer ceiling`);
		out[key] = n as number;
	}
	if (out.maxRunsPerCasePerDay! > out.maxRunsPerClientPerDay!) refuse(`${at}: maxRunsPerCasePerDay may not exceed maxRunsPerClientPerDay`);
	return out as Record<keyof typeof NATIVE_PDF_RENDER_CEILINGS, number>;
}

// A placeholder lets the REAL Clerk configuration reader judge the public values. It exists only inside this call, matches the
// reader's secret pattern and the publishable key's mode, and is never emitted. Built at run time so no key-shaped literal exists.
const placeholder = (mode: string, fill: string) => ['sk', mode, fill.repeat(24)].join('_');
const DEV_PUBLISHABLE = /^pk_test_/;

function planClient(manifest: ReturnType<typeof validateClientManifest>, value: Plain, at: string) {
	const input = exact(value, CLIENT_KEYS, at);
	const tupleInput = exact(input.deployment!, TUPLE_KEYS, `${at}.deployment`);
	const deployment = guard(`${at}.deployment`, () => resolveExactDeployment(manifest, thaw(tupleInput as Plain) as ExactDeploymentTuple));
	const appOrigin = text(input.appOrigin!, `${at}.appOrigin`);
	if (appOrigin !== `https://${deployment.hostname}`) refuse(`${at}.appOrigin: must be exactly https:// plus the manifest hostname`);

	const clerkInput = exact(input.clerk!, CLERK_KEYS, `${at}.clerk`);
	const clientPk = text(clerkInput.clientPublishableKey!, `${at}.clerk.clientPublishableKey`), staffPk = text(clerkInput.staffPublishableKey!, `${at}.clerk.staffPublishableKey`);
	if (!DEV_PUBLISHABLE.test(clientPk) || !DEV_PUBLISHABLE.test(staffPk)) refuse(`${at}.clerk: only development (test-mode) publishable keys are accepted`);
	const optional = (key: 'apiUrl' | 'signInUrl' | 'staffSignInUrl' | 'audience', name: string) => {
		const v = textOrNull(clerkInput[key]!, `${at}.clerk.${key}`);
		return v === null ? {} : { [name]: v };
	};
	const read = readClerkIdentityConfig({
		[CLERK_ENV.clientId]: deployment.clientId, [CLERK_ENV.appOrigin]: appOrigin,
		[CLERK_ENV.client.publishableKey]: clientPk, [CLERK_ENV.client.secretKey]: placeholder('test', 'a'),
		[CLERK_ENV.staff.publishableKey]: staffPk, [CLERK_ENV.staff.secretKey]: placeholder('test', 'b'),
		[CLERK_ENV.mfaRequired]: flag(clerkInput.mfaRequired!, `${at}.clerk.mfaRequired`) ? 'true' : 'false',
		...optional('apiUrl', CLERK_ENV.apiUrl), ...optional('signInUrl', CLERK_ENV.signInUrl),
		...optional('staffSignInUrl', CLERK_ENV.staffSignInUrl), ...optional('audience', CLERK_ENV.audience),
	}, { keys: 'optional' });
	if (!read.ok) return refuse(`${at}.clerk: not accepted by the current Clerk configuration reader`);
	const clerk = read.config;
	// Source IDs, issuers, host and client must all agree, exactly as hostedServices' nativeContext compares them.
	if (clerk.clientId !== deployment.clientId || clerk.client.issuer !== deployment.clientIssuer || clerk.staff.issuer !== deployment.staffIssuer ||
		new URL(clerk.appOrigin).hostname !== deployment.hostname) refuse(`${at}: the Clerk issuers, host and client do not match the manifest deployment`);

	const policy = exact(input.policy!, POLICY_KEYS, `${at}.policy`);
	const audit = guard(`${at}.policy.auditLimits`, () => auditConfig({ clientId: deployment.clientId, trustedIssuers: [deployment.clientIssuer, deployment.staffIssuer],
		limits: thaw(exact(policy.auditLimits!, Object.keys(AUDIT_CEILINGS), `${at}.policy.auditLimits`)) }));
	const budgets = storageBudgets(objectOf(policy.storageBudgets!, `${at}.policy.storageBudgets`));
	if (!budgets) refuse(`${at}.policy.storageBudgets: missing, unknown, non-finite or inconsistent`);
	const quotas = storageQuotas(objectOf(policy.storageQuotas!, `${at}.policy.storageQuotas`));
	if (!quotas) refuse(`${at}.policy.storageQuotas: missing, unknown or non-finite`);
	const work = guard(`${at}.policy.userWorkLimits`, () => userWorkConfig({ clientId: deployment.clientId,
		limits: thaw(exact(policy.userWorkLimits!, Object.keys(USER_WORK_CEILINGS), `${at}.policy.userWorkLimits`)) }));
	const intake = intakeBudget(objectOf(policy.intakeBudget!, `${at}.policy.intakeBudget`), { maxOriginalBytes: budgets!.maxOriginalBytes });
	if (!intake) refuse(`${at}.policy.intakeBudget: missing, unknown, non-finite or above the original-store bound`);
	const imports = nativeImportBudget(objectOf(policy.importBudget!, `${at}.policy.importBudget`), { stagerMaxPackageBytes: budgets!.maxPackageBytes });
	// hostedServices silently composes no import port when either relation fails, so the planner refuses instead.
	if (!imports || imports.maxFiles > budgets!.maxPackageFiles || imports.maxFileBytes > budgets!.maxPackageFileBytes)
		refuse(`${at}.policy.importBudget: missing, unknown, non-finite or above the storage package bounds`);
	if (hostedValidationPolicy(budgets) === null) refuse(`${at}.policy: the storage budgets give no publication validation policy`);
	const render = renderBudget(policy.nativeRenderBudget!, `${at}.policy.nativeRenderBudget`);

	// Key order is fixed, so the emitted text is deterministic and byte-comparable.
	const settings = {
		schema: NATIVE_RUNTIME_SETTINGS_SCHEMA,
		deployment: Object.fromEntries(TUPLE_KEYS.map((key) => [key, deployment[key]])),
		manifest: { staffIssuer: deployment.staffIssuer, clients: [Object.fromEntries(Object.entries(manifest.clients.find((c) => c.clientId === deployment.clientId)!))] },
		auditLimits: { ...audit.limits }, storageBudgets: { ...budgets }, storageQuotas: { ...quotas },
		userWorkLimits: { ...work.limits }, intakeBudget: { ...intake }, importBudget: { ...imports },
		...(render ? { nativeRenderBudget: { ...render } } : {}),
	};
	const nativeConfig = JSON.stringify(settings);
	const nativeConfigBytes = Buffer.byteLength(nativeConfig);
	const vars: Record<string, string> = {
		[CLERK_ENV.clientId]: clerk.clientId, [CLERK_ENV.appOrigin]: clerk.appOrigin,
		[CLERK_ENV.client.publishableKey]: clerk.client.publishableKey, [CLERK_ENV.staff.publishableKey]: clerk.staff.publishableKey,
		[CLERK_ENV.mfaRequired]: clerk.mfaRequired ? 'true' : 'false',
		...(clerk.apiUrl === null ? {} : { [CLERK_ENV.apiUrl]: clerk.apiUrl }),
		...(clerk.signInUrl === null ? {} : { [CLERK_ENV.signInUrl]: clerk.signInUrl }),
		...(clerk.staffSignInUrl === null ? {} : { [CLERK_ENV.staffSignInUrl]: clerk.staffSignInUrl }),
		...(clerk.audience === null ? {} : { [CLERK_ENV.audience]: clerk.audience }),
		[NATIVE_RUNTIME_CONFIG_VAR]: nativeConfig,
	};
	// One rule for the whole class: every emitted value, by UTF-8 bytes, before anything is written. The message names the variable
	// (a fixed name from this module) and never its value.
	for (const [name, value] of Object.entries(vars))
		if (Buffer.byteLength(value) > NATIVE_RUNTIME_CONFIG_MAX_BYTES) refuse(`${at}: ${name} exceeds ${NATIVE_RUNTIME_CONFIG_MAX_BYTES} bytes`);
	const file = {
		schema: NATIVE_RUNTIME_CLIENT_SCHEMA, clientId: deployment.clientId, worker: deployment.worker, hostname: deployment.hostname,
		vars, secrets: [...NATIVE_RUNTIME_SECRET_NAMES],
		bindings: { d1: BINDINGS.d1, r2: BINDINGS.r2, assets: BINDINGS.assets, browser: render ? NATIVE_BROWSER_BINDING : null },
	};
	return { clientId: deployment.clientId, worker: deployment.worker, hostname: deployment.hostname, render, nativeConfigBytes, file, fileName: `${deployment.clientId}.runtime.json`, text: json(file) };
}

/**
 * Pure, deterministic and offline. One strict own-data snapshot of `value` is validated against the CURRENT validators that
 * hostedServices and clerkIdentityProviderFromEnv run, and everything emitted comes from that snapshot. Nothing defaults:
 * a missing, unknown, sparse, accessor, secret-shaped, inconsistent or over-ceiling value refuses the whole plan.
 */
export function planNativeRuntimeConfig(value: unknown) {
	const input = exact(capture(value, 'input'), ['manifest', 'clients', 'browserAllocation'], 'input');
	const manifest = guard('input.manifest', () => validateClientManifest(objectOf(input.manifest!, 'input.manifest')));
	const list = input.clients!;
	if (!Array.isArray(list) || list.length < 1 || list.length > MAX_CLIENTS) refuse('input.clients: expected 1 to 8 client entries');
	const clients = (list as readonly Plain[]).map((item, i) => planClient(manifest, item, `input.clients[${i}]`));
	if (new Set(clients.map((c) => c.clientId)).size !== clients.length || new Set(clients.map((c) => c.worker)).size !== clients.length) refuse('input.clients: a client may be planned once');

	// A planned allocation, not proof of account availability or spend. The reservation SQL charges every launch the full lease and
	// refuses a launch before the previous lease ends (next_launch_ms), so one client never holds more than one browser at a time.
	// Null means "no client renders": any opt-in must carry the explicit aggregate policy, because the finite check is the point.
	const browsers = clients.filter((c) => c.render);
	let allocation = null;
	if (input.browserAllocation === null && browsers.length)
		refuse('input.browserAllocation: an explicit planned allocation is required because a client opted in to Browser rendering; null is allowed only when no client opts in');
	if (input.browserAllocation !== null) {
		const policy = exact(input.browserAllocation!, ALLOCATION_KEYS, 'input.browserAllocation');
		const maxConcurrentBrowsers = count(policy.maxConcurrentBrowsers!, 'input.browserAllocation.maxConcurrentBrowsers');
		const maxReservedBrowserMsPerDay = count(policy.maxReservedBrowserMsPerDay!, 'input.browserAllocation.maxReservedBrowserMsPerDay');
		if (!browsers.length) refuse('input.browserAllocation: no planned client has a render budget to allocate');
		const perClient = browsers.map((c) => {
			const leaseMsWorstCase = nativeRenderLeaseMs(c.render!.maxRunMs);
			return { clientId: c.clientId, maxRunMs: c.render!.maxRunMs, cleanupMs: RENDER_CLEANUP_MS, idleTailMs: RENDER_IDLE_TAIL_MS, leaseMsWorstCase,
				maxRunsPerClientPerDay: c.render!.maxRunsPerClientPerDay, maxConcurrentBrowsers: 1, reservedMsPerDay: leaseMsWorstCase * c.render!.maxRunsPerClientPerDay };
		});
		const totals = { concurrentBrowsers: perClient.length, reservedMsPerDay: perClient.reduce((sum, c) => sum + c.reservedMsPerDay, 0) };
		if (totals.concurrentBrowsers > maxConcurrentBrowsers || totals.reservedMsPerDay > maxReservedBrowserMsPerDay) refuse('input.browserAllocation: the planned clients exceed the explicit aggregate policy');
		allocation = { kind: 'planned-allocation', accountAvailabilityProven: false, spendProven: false,
			policy: { maxConcurrentBrowsers, maxReservedBrowserMsPerDay }, clients: perClient, totals };
	}

	const files = new Map<string, string>(clients.map((c) => [c.fileName, c.text]));
	const manifestOut = {
		schema: NATIVE_RUNTIME_CONFIG_SCHEMA, settingsSchema: NATIVE_RUNTIME_SETTINGS_SCHEMA,
		clients: clients.map((c) => ({ clientId: c.clientId, worker: c.worker, hostname: c.hostname, file: c.fileName, bytes: Buffer.byteLength(c.text), sha256: sha(c.text),
			nativeConfigBytes: c.nativeConfigBytes, secretNames: [...NATIVE_RUNTIME_SECRET_NAMES], browserBinding: c.file.bindings.browser })),
		staff: STAFF, plannedBrowserAllocation: allocation,
		providerProof: false, provisioned: false, deployed: false,
		evidence: 'source-only settings; not provider, health, login, tenant or runtime proof',
	};
	const manifestText = json(manifestOut);
	files.set(NATIVE_RUNTIME_CONFIG_MANIFEST, manifestText);
	return freeze({ manifest: manifestOut, manifestText, files, clients: clients.map((c) => c.file) });
}
export type NativeRuntimeConfigPlan = ReturnType<typeof planNativeRuntimeConfig>;

// ---- filesystem: exclusive staging and re-reading ----
function realPath(file: string, directory: boolean) {
	for (let at = file, first = true; ; at = path.dirname(at), first = false) {
		const stat = lstatSync(at);
		if (stat.isSymbolicLink() || !(first && !directory ? stat.isFile() && stat.nlink === 1 : stat.isDirectory())) throw new Error('expected a real unlinked path');
		if (at === path.dirname(at)) break;
	}
}
/** Absolute, already canonical (no dot segments, doubled or trailing separators): never normalized into acceptance. */
function location(value: unknown, at: string): string {
	if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value) || path.normalize(value) !== value || (value.length > 1 && value.endsWith(path.sep))) refuse(`${at}: expected a canonical absolute path`);
	return value as string;
}
const PRIVATE_DIRECTORY = 0o700, PRIVATE_FILE = 0o600;
function readBytes(file: string, size: number): Buffer {
	realPath(file, false);
	const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size !== size || (stat.mode & 0o7777) !== PRIVATE_FILE) throw new Error('expected a private unlinked file of the exact size');
		return readFileSync(fd);
	} finally { closeSync(fd); }
}
function shallow(value: unknown, keys: readonly string[], at: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value) || types.isProxy(value)) refuse(`${at}: expected plain data`);
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) refuse(`${at}: expected plain data`);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (Reflect.ownKeys(descriptors).length !== keys.length) refuse(`${at}: expected exactly ${keys.join(', ')}`);
	const captured: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const d = descriptors[key];
		if (!d || !Object.hasOwn(d, 'value') || d.enumerable !== true) refuse(`${at}: missing, hidden or accessor field`);
		captured[key] = d!.value;
	}
	return captured;
}

/** Exclusive new directory only. A preexisting stage is never removed or changed; only the directory this call made is cleaned up. */
export function prepareNativeRuntimeConfig(value: { input: unknown; out: string }) {
	const v = shallow(value, ['input', 'out'], 'prepare');
	const plan = planNativeRuntimeConfig(v.input);
	const out = location(v.out, 'prepare.out');
	try { realPath(path.dirname(out), true); } catch { refuse('prepare.out: the parent must be a real directory'); }
	try { mkdirSync(out, { mode: PRIVATE_DIRECTORY }); } catch { refuse('prepare.out: must be a new directory'); }
	const owned = lstatSync(out);
	try {
		chmodSync(out, PRIVATE_DIRECTORY);
		for (const [name, bytes] of plan.files) writeFileSync(path.join(out, name), bytes, { flag: 'wx', mode: PRIVATE_FILE });
		return readNativeRuntimeConfig({ input: v.input, stage: out });
	} catch (caught) {
		const current = lstatSync(out, { throwIfNoEntry: false });
		if (current?.isDirectory() && current.ino === owned.ino && current.dev === owned.dev) rmSync(out, { recursive: true, force: true });
		if (typeof caught === 'object' && caught !== null && issued.has(caught)) throw caught;
		return refuse('prepare: staging failed and the new directory was removed');
	}
}

/** Re-plans from `input` and requires the stage to hold exactly the planned entries, byte for byte, as regular unlinked files (exact mode 0600) in a directory of exact mode 0700, with no special bits. */
export function readNativeRuntimeConfig(value: { input: unknown; stage: string }) {
	const v = shallow(value, ['input', 'stage'], 'read');
	const plan = planNativeRuntimeConfig(v.input);
	const stage = location(v.stage, 'read.stage');
	try {
		realPath(stage, true);
		if ((lstatSync(stage).mode & 0o7777) !== PRIVATE_DIRECTORY) throw new Error('mode');
		const entries = readdirSync(stage);
		if (entries.length !== plan.files.size || entries.some((name) => !plan.files.has(name))) throw new Error('entries');
		for (const [name, bytes] of plan.files) if (!readBytes(path.join(stage, name), Buffer.byteLength(bytes)).equals(Buffer.from(bytes))) throw new Error('bytes');
	} catch { refuse('read: the stage is not exactly the planned entries and bytes'); }
	return freeze({ stage, ...plan });
}

/** Strict-JSON input file: a regular, unlinked, bounded file, parsed by the native profile's duplicate-key-refusing parser. */
export function loadNativeRuntimeConfigInput(file: string): unknown {
	const target = location(file, 'input file');
	let source: string;
	try {
		realPath(target, false);
		const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_INPUT_BYTES) throw new Error('size');
			source = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fd));
		} finally { closeSync(fd); }
	} catch { return refuse('input file: not a readable, bounded, unlinked UTF-8 file'); }
	try { return parseNativeJson(source); } catch { return refuse('input file: not strict JSON'); }
}
