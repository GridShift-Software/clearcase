// The checked pipeline's explicit native profile (target -> stage -> prebuilt), a NEW profile beside the accepted-D
// GRS-107 legacy `clearcase.deploy-target/1`, which keeps its own parser and safeguards unchanged. This module is pure
// data checking: no filesystem, environment, network, credential, timer or process access. deploy/probes/target.ts
// owns the staging mechanics (copy, digest, symlink and special-file refusal) and calls in here with text.
//
// Desired, not observed. A native target is the exact scoped deployment the parent intends: approved account, zone,
// client, Worker, custom-domain hostname, D1 (name and UUID), private EU R2, workers.dev and Preview URLs off, explicit
// CPU limit, secret NAMES, vars, compatibility and runtime/source/artifact/migrations identity. It never carries the
// Workers custom-domain ID, version IDs or other provider-assigned identifiers that only exist after a deploy: those
// belong to the observed native controls manifest (deploy/native-alpha/controls.ts), which this profile does not
// replace. A draft with a null D1 UUID is refused as a draft, never treated as executable, and no ID is invented here.
//
// D1 EU is a property of the provider resource (its jurisdiction at creation), not a Wrangler binding field: the
// bundled Wrangler 4.151.1 config-schema.json `d1_databases` items have binding, database_name, database_id,
// preview_database_id, migrations_table, migrations_dir, migrations_pattern, database_internal_env and remote, and no
// jurisdiction. The target records `d1.jurisdiction: "eu"` as policy that the stage record carries for the parent's
// provider readback; it is never written into a config. R2 `jurisdiction` IS a Wrangler r2_buckets field, and
// `routes[{pattern, zone_id, custom_domain}]` (ZoneIdRoute), `workers_dev`, `preview_urls` and `limits.cpu_ms` are
// RawEnvironment fields in the same schema.
//
// Adapter: Wrangler only. cf 1.0.0-beta.20 (the probe's pinned cf) converts a Wrangler custom-domain route into a
// `domains` list of hostname strings and flags any zone_id/zone_name on it as "Custom-domain route options require
// manual review" (dist/wrangler-migration-*.mjs, convertTriggers), so a cf config cannot bind the exact approved zone
// ID of the custom domain; what its Build Output carries for domains, workers.dev and limits is unmeasured here (a cf
// build is parent-only). The native profile therefore refuses cf configs and cf Build Output as a measured capability
// gap, and the checked Wrangler config in the stage is the one adapter. This is not an unchecked config generator: the
// parent writes the reviewed wrangler.jsonc, and this module only compares it with the target.
//
// Evidence: a PASS here is LOCAL unit/structural only. It is not funded admission, a controls proof, a real EU
// placement, an applied migration or a deploy.
import { APPROVED_NATIVE_SCOPE } from './controls.ts';

export const NATIVE_TARGET_SCHEMA = 'clearcase.deploy-target.native/1';
export const NATIVE_STAGE_SCHEMA = 'clearcase.deploy-stage.native/1';
/** The only files a native client directory and stage hold beside migrations/ (and, in a stage, artifact/ and stage.json). */
export const NATIVE_CONFIG_FILE = 'wrangler.jsonc';
export const NATIVE_CLIENT_FILES = ['target.json', NATIVE_CONFIG_FILE] as const;
/** Same paths as target.ts STAGED (asserted equal by the unit tests); duplicated so this module imports nothing from target.ts. */
export const NATIVE_STAGED = { entry: 'artifact/cloudflare/_worker.js', assets: 'artifact/cloudflare', migrations: 'migrations', version: 'artifact/cloudflare/_app/version.json' } as const;
/** The hosted-gate test-double marker (scripts/ci/hosted-artifact.ts GATE); a production artifact never contains it. */
export const HOSTED_GATE_MARKER = 'clearcase-test-double:hosted-gate';
export const CF_NATIVE_GAP =
	'native profile capability gap: cf 1.0.0-beta.20 cannot bind the custom domain to the exact approved zone ID (zone_id on a custom-domain route needs manual review in its migration) and its Build Output for domains/workers.dev/limits is unmeasured; the native profile uses only the checked Wrangler config';

export type NativeTarget = {
	schema: typeof NATIVE_TARGET_SCHEMA;
	client: string;
	accountId: string;
	worker: string;
	zone: { id: string; name: string };
	customDomain: { hostname: string; zoneId: string };
	workersDev: false;
	previewUrls: false;
	limits: { cpu_ms: number; subrequests?: number };
	d1: { binding: 'DB'; name: string; id: string; jurisdiction: 'eu' };
	r2: { binding: 'BUCKET'; bucket: string; jurisdiction: 'eu'; publicAccess: false };
	secrets: string[];
	vars: Record<string, string>;
	runtime: { profile: 'production'; sourceSha: string; artifactSha256: string; migrationsSha256: string; compatibilityDate: string; compatibilityFlags: string[]; assetsBinding: string };
};

const NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;
const BINDING = /^[A-Z][A-Z0-9_]{0,62}$/;
const ACCOUNT = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FLAG = /^[a-z0-9_]{1,64}$/;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const show = (v: unknown) => (v === undefined ? 'missing' : JSON.stringify(v));
const posInt = (v: unknown, max: number) => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= max;
const sameKeys = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

/** Every key of `value` outside `allowed`, and every allowed key that is missing, as problems: the native profile reads every key it allows. */
function exactKeys(value: Record<string, unknown>, required: readonly string[], at: string, problems: string[], optional: readonly string[] = []) {
	for (const k of Object.keys(value)) if (!required.includes(k) && !optional.includes(k)) problems.push(`${at}.${k} is not a key the native profile reads; remove it or extend the profile`);
	for (const k of required) if (!Object.hasOwn(value, k)) problems.push(`${at}.${k} is missing`);
}

/** The approved native scope's entry for `client`, or undefined. */
const approvedClient = (client: unknown) => APPROVED_NATIVE_SCOPE.clients.find((c) => c.client === client);

/** A native target read as data, bound to the approved native scope, or a throw listing every problem. */
export function parseNativeTarget(value: unknown, file: string): NativeTarget {
	const problems: string[] = [];
	const fail = (m: string) => problems.push(`${file}: ${m}`);
	if (!isObject(value)) throw new Error(`${file}: not an object`);
	const keyProblems: string[] = [];
	exactKeys(value, ['schema', 'client', 'accountId', 'worker', 'zone', 'customDomain', 'workersDev', 'previewUrls', 'limits', 'd1', 'r2', 'secrets', 'vars', 'runtime'], file, keyProblems);
	problems.push(...keyProblems);
	const v = value;
	if (v.schema !== NATIVE_TARGET_SCHEMA) fail(`schema is ${show(v.schema)}, not ${NATIVE_TARGET_SCHEMA}`);
	const approved = approvedClient(v.client);
	if (typeof v.client !== 'string' || !NAME.test(v.client) || !approved) fail(`client ${show(v.client)} is not an approved native client`);
	if (typeof v.accountId !== 'string' || !ACCOUNT.test(v.accountId) || v.accountId !== APPROVED_NATIVE_SCOPE.accountId) fail(`accountId ${show(v.accountId)} is not the approved native account`);
	if (!approved || v.worker !== approved.worker) fail(`worker ${show(v.worker)} is not the approved ${approved?.worker ?? 'native Worker'}`);
	const zone = APPROVED_NATIVE_SCOPE.zone;
	if (!isObject(v.zone) || !sameKeys(v.zone, ['id', 'name']) || v.zone.id !== zone.id || v.zone.name !== zone.name) fail(`zone ${show(v.zone)} is not exactly the approved zone { id, name }`);
	const cd = v.customDomain;
	if (!isObject(cd) || !sameKeys(cd, ['hostname', 'zoneId'])) fail(`customDomain ${show(cd)} is not exactly { hostname, zoneId }`);
	else {
		if (typeof cd.hostname !== 'string' || !HOST.test(cd.hostname) || !approved || cd.hostname !== approved.hostname) fail(`customDomain hostname ${show(cd.hostname)} is not the approved exact ${approved?.hostname ?? 'hostname'} (lower case, no wildcard, path or trailing dot)`);
		if (cd.zoneId !== zone.id) fail(`customDomain zoneId ${show(cd.zoneId)} is not the approved zone`);
		if (typeof cd.hostname === 'string' && !cd.hostname.endsWith(`.${zone.name}`)) fail(`customDomain hostname ${show(cd.hostname)} is not inside the approved zone ${zone.name}`);
	}
	if (v.workersDev !== false) fail(`workersDev is ${show(v.workersDev)}, not false`);
	if (v.previewUrls !== false) fail(`previewUrls is ${show(v.previewUrls)}, not false`);
	if (!isObject(v.limits) || !Object.keys(v.limits).every((k) => k === 'cpu_ms' || k === 'subrequests') || !posInt(v.limits.cpu_ms, 300_000) || (Object.hasOwn(v.limits, 'subrequests') && !posInt(v.limits.subrequests, 10_000_000)))
		fail(`limits ${show(v.limits)} is not { cpu_ms (a positive integer of milliseconds), subrequests? }`);
	const d1 = v.d1;
	if (!isObject(d1) || !sameKeys(d1, ['binding', 'name', 'id', 'jurisdiction'])) fail(`d1 ${show(d1)} is not exactly { binding, name, id, jurisdiction }`);
	else {
		if (d1.binding !== 'DB' || !approved || d1.name !== approved.d1Name) fail(`d1 ${show(d1.binding)}/${show(d1.name)} is not DB/${approved?.d1Name ?? 'the approved D1'}`);
		if (d1.id === null) fail('d1 id is null: this is a draft target, not an executable one; the parent fills the observed D1 UUID after creation, and nothing here invents it');
		else if (typeof d1.id !== 'string' || !UUID.test(d1.id)) fail(`d1 id ${show(d1.id)} is not a D1 UUID`);
		if (d1.jurisdiction !== 'eu') fail(`d1 jurisdiction ${show(d1.jurisdiction)} is not "eu"`);
	}
	const r2 = v.r2;
	if (!isObject(r2) || !sameKeys(r2, ['binding', 'bucket', 'jurisdiction', 'publicAccess'])) fail(`r2 ${show(r2)} is not exactly { binding, bucket, jurisdiction, publicAccess }`);
	else {
		if (r2.binding !== 'BUCKET' || !approved || r2.bucket !== approved.r2Bucket) fail(`r2 ${show(r2.binding)}/${show(r2.bucket)} is not BUCKET/${approved?.r2Bucket ?? 'the approved bucket'}`);
		if (r2.jurisdiction !== 'eu') fail(`r2 jurisdiction ${show(r2.jurisdiction)} is not "eu"`);
		if (r2.publicAccess !== false) fail(`r2 publicAccess ${show(r2.publicAccess)} is not false (the bucket is private)`);
	}
	if (!Array.isArray(v.secrets) || !v.secrets.every((s) => typeof s === 'string' && BINDING.test(s)) || new Set(v.secrets).size !== v.secrets.length) fail(`secrets ${show(v.secrets)} is not a list of distinct secret NAMES`);
	if (!isObject(v.vars) || !Object.entries(v.vars).every(([k, x]) => BINDING.test(k) && typeof x === 'string')) fail(`vars ${show(v.vars)} is not binding names to strings`);
	else if (v.vars.CLEARCASE_CLIENT_ID !== v.client) fail(`vars.CLEARCASE_CLIENT_ID is ${show(v.vars.CLEARCASE_CLIENT_ID)}, not the client ${show(v.client)}`);
	if (Array.isArray(v.secrets) && isObject(v.vars)) for (const s of v.secrets) if (Object.hasOwn(v.vars, s as string)) fail(`${show(s)} is both a secret name and a var`);
	const rt = v.runtime;
	if (!isObject(rt) || !sameKeys(rt, ['profile', 'sourceSha', 'artifactSha256', 'migrationsSha256', 'compatibilityDate', 'compatibilityFlags', 'assetsBinding'])) fail(`runtime ${show(rt)} is not exactly { profile, sourceSha, artifactSha256, migrationsSha256, compatibilityDate, compatibilityFlags, assetsBinding }`);
	else {
		if (rt.profile !== 'production') fail(`runtime profile ${show(rt.profile)} is not "production" (a hosted-gate artifact carries test doubles)`);
		if (typeof rt.sourceSha !== 'string' || !SHA40.test(rt.sourceSha)) fail(`runtime sourceSha ${show(rt.sourceSha)} is not a 40-hex commit`);
		for (const k of ['artifactSha256', 'migrationsSha256'] as const) if (typeof rt[k] !== 'string' || !SHA256.test(rt[k] as string)) fail(`runtime ${k} ${show(rt[k])} is not sha256:<hex>`);
		if (typeof rt.compatibilityDate !== 'string' || !DATE.test(rt.compatibilityDate)) fail(`runtime compatibilityDate ${show(rt.compatibilityDate)} is not YYYY-MM-DD`);
		if (!Array.isArray(rt.compatibilityFlags) || !rt.compatibilityFlags.every((f) => typeof f === 'string' && FLAG.test(f)) || new Set(rt.compatibilityFlags).size !== rt.compatibilityFlags.length) fail(`runtime compatibilityFlags ${show(rt.compatibilityFlags)} is not a list of distinct flags`);
		if (typeof rt.assetsBinding !== 'string' || !BINDING.test(rt.assetsBinding)) fail(`runtime assetsBinding ${show(rt.assetsBinding)} is not a binding name`);
	}
	if (problems.length) throw new Error(problems.join('\n'));
	return value as NativeTarget;
}

/** Each native client's identifiers that a config may name, keyed by kind; hostnames compare in lower case. */
const nativeIdentifiers = (t: { worker: string; hostname: string; d1Name: string; d1Id?: string; r2Bucket: string }) => ({ worker: [t.worker], hostname: [t.hostname.toLowerCase()], 'd1 name': [t.d1Name], 'd1 id': t.d1Id ? [t.d1Id] : [], 'r2 bucket': [t.r2Bucket] });
const fromTarget = (t: NativeTarget) => nativeIdentifiers({ worker: t.worker, hostname: t.customDomain.hostname, d1Name: t.d1.name, d1Id: t.d1.id, r2Bucket: t.r2.bucket });

/** `targets` itself, or a throw when two of them share a client or an identifier: a shared one would blind every wrong-client comparison. */
export function distinctNative(targets: NativeTarget[]): NativeTarget[] {
	const owner = new Map<string, string>();
	const clients = new Set<string>();
	for (const t of targets) {
		if (clients.has(t.client)) throw new Error(`client ${t.client} has two native targets`);
		clients.add(t.client);
		for (const [kind, values] of Object.entries(fromTarget(t)))
			for (const x of values) {
				const prior = owner.get(x);
				if (prior && prior !== t.client) throw new Error(`${kind} ${x} is in both ${prior}'s and ${t.client}'s native targets`);
				owner.set(x, t.client);
			}
	}
	return targets;
}

/** Identifier -> owning client, from every native target and from every approved native client the targets do not cover. */
export function nativeOwners(targets: NativeTarget[]): Map<string, string> {
	const owners = new Map<string, string>();
	for (const t of targets) for (const x of Object.values(fromTarget(t)).flat()) owners.set(x, t.client);
	for (const c of APPROVED_NATIVE_SCOPE.clients) for (const x of Object.values(nativeIdentifiers({ worker: c.worker, hostname: c.hostname, d1Name: c.d1Name, r2Bucket: c.r2Bucket })).flat()) if (!owners.has(x)) owners.set(x, c.client);
	return owners;
}

const WRANGLER_KEYS = ['name', 'account_id', 'main', 'compatibility_date', 'compatibility_flags', 'send_metrics', 'workers_dev', 'preview_urls', 'routes', 'limits', 'assets', 'vars', 'secrets', 'd1_databases', 'r2_buckets'] as const;

/**
 * Every reason the native wrangler.jsonc `text` must not deploy `client`; empty means it names exactly the client's
 * native target. Read as data (JSON after whole-line `//` comments), never evaluated. Every key is required and
 * compared; an extra key, binding, route or setting is refused, as is any string equal (case-free) to another native
 * client's identifier.
 */
export function checkNativeWrangler(a: { client: string; targets: NativeTarget[]; text: string }): string[] {
	const target = a.targets.find((t) => t.client === a.client);
	if (!target) return [`no native target for ${a.client}`];
	let config: unknown;
	try {
		config = JSON.parse(a.text.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n'));
	} catch (e) {
		return [`the native Wrangler config is not JSON with whole-line comments: ${(e as Error).message}`];
	}
	if (!isObject(config)) return ['the native Wrangler config is not an object'];
	const problems: string[] = [];
	exactKeys(config, WRANGLER_KEYS, 'config', problems);
	const owners = nativeOwners(a.targets);
	const foreign = new Set<string>();
	const named = (got: unknown) => (typeof got === 'string' ? owners.get(got.toLowerCase()) : undefined);
	const expect = (what: string, got: unknown, want: unknown) => {
		if (got === want) return;
		const owner = named(got);
		if (owner && owner !== a.client) foreign.add((got as string).toLowerCase());
		problems.push(owner && owner !== a.client ? `${what} ${got} belongs to ${owner}, not ${a.client}` : `${what} is ${show(got)}, not ${show(want)}`);
	};
	const same = (what: string, got: unknown, want: unknown) => {
		if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${what} is ${show(got)}, not ${show(want)}`);
	};
	expect('account id', config.account_id, target.accountId);
	expect('worker', config.name, target.worker);
	expect('the Worker entry', config.main, NATIVE_STAGED.entry);
	expect('compatibility_date', config.compatibility_date, target.runtime.compatibilityDate);
	same('compatibility_flags', config.compatibility_flags, target.runtime.compatibilityFlags);
	expect('send_metrics', config.send_metrics, false);
	expect('workers_dev', config.workers_dev, false);
	expect('preview_urls', config.preview_urls, false);
	const routes = config.routes;
	if (!Array.isArray(routes) || routes.length !== 1) problems.push(`routes is ${show(routes)}, not exactly ${a.client}'s one custom domain`);
	for (const [i, r] of (Array.isArray(routes) ? routes : []).entries()) {
		const at = `config.routes[${i}]`;
		if (!isObject(r)) {
			problems.push(`${at} is ${show(r)}, not a custom-domain route object`);
			continue;
		}
		exactKeys(r, ['pattern', 'zone_id', 'custom_domain'], at, problems);
		expect(`${at} custom-domain hostname`, r.pattern, target.customDomain.hostname);
		expect(`${at} zone_id`, r.zone_id, target.customDomain.zoneId);
		expect(`${at} custom_domain`, r.custom_domain, true);
	}
	if (!isObject(config.limits)) problems.push(`limits is ${show(config.limits)}, not ${show(target.limits)}`);
	else {
		exactKeys(config.limits, Object.keys(target.limits), 'config.limits', problems);
		for (const k of Object.keys(target.limits) as (keyof NativeTarget['limits'])[]) expect(`limits.${k}`, config.limits[k], target.limits[k]);
	}
	if (!isObject(config.assets)) problems.push(`assets is ${show(config.assets)}, not the staged artifact`);
	else {
		exactKeys(config.assets, ['directory', 'binding'], 'config.assets', problems);
		expect('the assets directory', config.assets.directory, NATIVE_STAGED.assets);
		expect('the assets binding', config.assets.binding, target.runtime.assetsBinding);
	}
	if (!isObject(config.vars) || JSON.stringify(Object.entries(config.vars).sort()) !== JSON.stringify(Object.entries(target.vars).sort())) problems.push(`vars are ${show(config.vars)}, not ${a.client}'s ${show(target.vars)}`);
	if (!isObject(config.secrets)) problems.push(`secrets is ${show(config.secrets)}, not { required: [...] }`);
	else {
		exactKeys(config.secrets, ['required'], 'config.secrets', problems);
		const req = config.secrets.required;
		const sorted = Array.isArray(req) ? [...req].sort() : req;
		if (!Array.isArray(req) || new Set(req).size !== req.length || JSON.stringify(sorted) !== JSON.stringify([...target.secrets].sort())) problems.push(`secret names are ${show(req)}, not ${a.client}'s ${show(target.secrets)}`);
	}
	const d1 = config.d1_databases;
	if (!Array.isArray(d1) || d1.length !== 1) problems.push(`the config binds ${Array.isArray(d1) ? d1.length : show(d1)} D1 databases, not exactly ${a.client}'s one`);
	for (const [i, d] of (Array.isArray(d1) ? d1 : []).entries()) {
		const at = `config.d1_databases[${i}]`;
		const o = isObject(d) ? d : {};
		exactKeys(o, ['binding', 'database_name', 'database_id', 'migrations_dir'], at, problems);
		expect('d1 binding', o.binding, target.d1.binding);
		expect('d1 name', o.database_name, target.d1.name);
		expect('d1 id', o.database_id, target.d1.id);
		expect('the migrations directory', o.migrations_dir, NATIVE_STAGED.migrations);
	}
	const r2 = config.r2_buckets;
	if (!Array.isArray(r2) || r2.length !== 1) problems.push(`the config binds ${Array.isArray(r2) ? r2.length : show(r2)} R2 buckets, not exactly ${a.client}'s one`);
	for (const [i, r] of (Array.isArray(r2) ? r2 : []).entries()) {
		const at = `config.r2_buckets[${i}]`;
		const o = isObject(r) ? r : {};
		exactKeys(o, ['binding', 'bucket_name', 'jurisdiction'], at, problems);
		expect('r2 binding', o.binding, target.r2.binding);
		expect('r2 bucket', o.bucket_name, target.r2.bucket);
		expect('r2 jurisdiction', o.jurisdiction, target.r2.jurisdiction);
	}
	// Another native client's identifier as any string value (case-free), keys included, the fields above included.
	const walk = (x: unknown): void => {
		if (typeof x === 'string') {
			const owner = named(x);
			if (owner && owner !== a.client && !foreign.has(x.toLowerCase())) (foreign.add(x.toLowerCase()), problems.push(`${x} belongs to ${owner}, not ${a.client}`));
		} else if (Array.isArray(x)) x.forEach(walk);
		else if (isObject(x)) for (const [k, y] of Object.entries(x)) (walk(k), walk(y));
	};
	walk(config);
	return problems;
}

/** The record a native stage writes and its prebuilt check recomputes byte for byte. Every claim flag is constant false. */
export function nativeStageRecord(t: NativeTarget, a: { files: Record<string, string>; artifact: string; migrations: string }) {
	return {
		schema: NATIVE_STAGE_SCHEMA,
		profile: 'native',
		adapter: 'wrangler',
		client: t.client,
		files: a.files,
		artifact: a.artifact,
		migrations: a.migrations,
		runtime: { profile: t.runtime.profile, sourceSha: t.runtime.sourceSha },
		desired: { accountId: t.accountId, worker: t.worker, zoneId: t.zone.id, hostname: t.customDomain.hostname, d1Id: t.d1.id, r2Bucket: t.r2.bucket },
		policy: { workersDev: false, previewUrls: false, d1Jurisdiction: t.d1.jurisdiction, r2Jurisdiction: t.r2.jurisdiction, r2PublicAccess: false, remoteMigrations: 'not-applied-by-stage' },
		state: 'STAGED-UNVERIFIED',
		fundedAdmission: false,
		controlsProof: false,
		providerProof: false,
		deployed: false,
	} as const;
}

/** Problems with the staged artifact's identity: its `_app/version.json` must name the target's source commit. */
export function versionProblems(text: string | null, t: NativeTarget): string[] {
	if (text === null) return [`${NATIVE_STAGED.version} is missing from the staged artifact`];
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch (e) {
		return [`${NATIVE_STAGED.version} is not JSON: ${(e as Error).message}`];
	}
	if (!isObject(v) || v.version !== t.runtime.sourceSha) return [`${NATIVE_STAGED.version} names ${show(isObject(v) ? v.version : v)}, not the target's source ${t.runtime.sourceSha}`];
	return [];
}
