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
// Final upload bytes (fix r1, M1). The native config forbids upload-time bundling by REQUIRING `no_bundle: true` and
// `find_additional_modules: false` (Wrangler 4.151.1 config-schema.json: `find_additional_modules` "Defaults to true if
// `no_bundle` is true", so it is declared, not left to the default). Wrangler then uploads exactly the `main` module's
// bytes plus the assets directory: nothing is resolved, bundled or shimmed at upload time. The module must therefore be
// a closed, prebundled graph: a scan of its parsed syntax (target.ts, `scanModule`) must find no bare, relative,
// outside-stage or computed import, no `require` call and no host module beyond NATIVE_HOST_IMPORTS. The stage
// record then names every uploaded file by its own sha256 and the entry by bytes and hash. A self-contained final
// bundle is the initial native profile; producing it (the real SvelteKit production build and its final bundling) is
// parent-only and was not run here.
//
// Dynamic host imports (NATIVE24). The real framework bundle (Wrangler 4.151.1 over adapter-cloudflare 8.0.1, measured
// d1a6ce…) keeps two literal `import("node:async_hooks")` (SvelteKit event.js, Svelte render-context.js) and Svelte's
// `obfuscated_import = (module_name) => import(module_name)`, called only as `obfuscated_import("node:crypto")` in a
// WebCrypto fallback. With no_bundle and find_additional_modules:false the uploaded Worker is one module, so a dynamic
// import can only reach a runtime built-in. A dynamic import is therefore accepted only when every specifier it can
// receive is statically proven (a string literal, or a forwarding wrapper whose every use is a direct call with a
// string literal: target.ts `scanModule` holds the proof) AND names a module in NATIVE_DYNAMIC_HOST_IMPORTS that the
// target's compatibility flags enable. The flag table follows Wrangler 4.151.1 itself: in its "als" mode (nodejs_als
// without nodejs_compat) only `node:async_hooks` is external (als-external.ts), and any other node built-in needs
// nodejs_compat (rewriteNodeCompatBuildFailure). Anything unproven, escaping, computed or user-derived is refused.
//
// Public assets (NATIVE24, L1). The server entry lives alone in artifact/cloudflare/ and the public assets alone in
// artifact/public/, the one assets directory. Wrangler 4.151.1 uploads every file of the assets directory except its
// root `.assetsignore`, `_headers` and `_redirects` (createAssetsIgnoreFunction), and uploads `_headers`/`_redirects`
// as routing rules. `nativeArtifactLayout` refuses an .assetsignore (an empty one also silences Wrangler's own
// _worker.js guard), `_redirects`, `_routes.json`, any `_headers` other than the exact adapter-cloudflare 8.0.1 rules,
// source maps, dotfiles, `_worker.js*`, a byte-identical copy of the entry and Wrangler's 25 MiB / 20,000 limits, and it
// classifies every public file by its own hash: what is hashed is exactly what is uploaded.
//
// Workers refuse code generation from strings at runtime (eval/new Function), so a string cannot reopen a proven import;
// the forwarding proof also refuses any `eval` identifier. The proof assumes JavaScript intrinsics (Object.defineProperty,
// through esbuild's keep-names `__name`) are not replaced by bundled code; direct shadowing or writes are refused.
//
// Reviewed pins (fix r1, M2). A stage record, the staged target.json and the staged hashes all come from the same
// directory, so they can only agree with each other. `prebuilt` therefore also needs NativePins, supplied by the
// credentialed caller from the reviewed record and never read from the stage: the sha256 of the reviewed target.json and
// wrangler.jsonc bytes, the artifact, migrations and entry digests and the source commit. A reviewed `--clients`
// directory must be a real directory outside the stage and must hold byte-identical target.json and wrangler.jsonc.
// The pins are the root of trust: whoever chooses them chooses what may be uploaded. A file path is not a human approval.
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
export const NATIVE_STAGED = { entry: 'artifact/cloudflare/_worker.js', assets: 'artifact/public', migrations: 'migrations', version: 'artifact/public/_app/version.json' } as const;
/** NATIVE24: the entry and the public assets are separate trees (the legacy STAGED assets directory held the entry). */
export const NATIVE_ENTRY_DIR = 'artifact/cloudflare';
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

/**
 * `text` as data with a bounded strict parser: a duplicate key (JSON.parse keeps the last), nesting deeper than 32,
 * trailing characters, a bare control character or a lone-surrogate-free violation of JSON syntax is refused. With
 * `comments`, whole-line `//` comments are dropped first. A `__proto__` key becomes an inert own property. Never
 * evaluated. This follows src/lib/case-package/strict-json.ts (GRS-10) but is self-contained: that module cannot be
 * imported here, because the deployment probe's Vite transform would then resolve the app's `$app/tsconfig` (the same
 * reason deploy/probes/tsconfig.json is standalone), which exists only after a SvelteKit sync.
 */
export function parseNativeJson(text: string, comments = false): unknown {
	const src = comments ? text.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n') : text;
	let i = 0;
	const err = (m: string): never => {
		throw new Error(`${m} at offset ${i}`);
	};
	const ws = () => {
		while (src[i] === ' ' || src[i] === '\t' || src[i] === '\n' || src[i] === '\r') i++;
	};
	const str = (): string => {
		let j = i + 1;
		while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
		if (j >= src.length) err('unterminated string');
		const raw = src.slice(i, j + 1);
		try {
			const v: unknown = JSON.parse(raw);
			i = j + 1;
			return v as string;
		} catch {
			return err('invalid string');
		}
	};
	const value = (depth: number): unknown => {
		if (depth > 32) err('nesting is deeper than 32');
		ws();
		const c = src[i];
		if (c === '{') {
			i++;
			const o: Record<string, unknown> = {};
			ws();
			if (src[i] === '}') return i++, o;
			for (;;) {
				ws();
				if (src[i] !== '"') err('expected a string key');
				const k = str();
				if (Object.hasOwn(o, k)) err(`duplicate key ${JSON.stringify(k.slice(0, 64))}`);
				ws();
				if (src[i++] !== ':') err('expected ":"');
				Object.defineProperty(o, k, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
				ws();
				const d = src[i++];
				if (d === '}') return o;
				if (d !== ',') err('expected "," or "}"');
			}
		}
		if (c === '[') {
			i++;
			const a: unknown[] = [];
			ws();
			if (src[i] === ']') return i++, a;
			for (;;) {
				a.push(value(depth + 1));
				ws();
				const d = src[i++];
				if (d === ']') return a;
				if (d !== ',') err('expected "," or "]"');
			}
		}
		if (c === '"') return str();
		const lit = /true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
		lit.lastIndex = i;
		const m = lit.exec(src);
		if (!m) return err('unexpected token');
		i += m[0].length;
		return JSON.parse(m[0]);
	};
	const result = value(0);
	ws();
	if (i < src.length) err('trailing characters');
	return result;
}

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

const WRANGLER_KEYS = ['name', 'account_id', 'main', 'no_bundle', 'find_additional_modules', 'compatibility_date', 'compatibility_flags', 'send_metrics', 'workers_dev', 'preview_urls', 'routes', 'limits', 'assets', 'vars', 'secrets', 'd1_databases', 'r2_buckets'] as const;

/**
 * Every reason the native wrangler.jsonc `text` must not deploy `client`; empty means it names exactly the client's
 * native target. Read as data (strict JSON after whole-line `//` comments), never evaluated. Every key is required and
 * compared; an extra key, binding, route or setting is refused, as is any string equal (case-free) to another native
 * client's identifier.
 */
export function checkNativeWrangler(a: { client: string; targets: NativeTarget[]; text: string }): string[] {
	const target = a.targets.find((t) => t.client === a.client);
	if (!target) return [`no native target for ${a.client}`];
	let config: unknown;
	try {
		config = parseNativeJson(a.text, true);
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
	// The upload must be the prebundled final module: no bundling at upload time, and no tree sweep for extra modules.
	expect('no_bundle', config.no_bundle, true);
	expect('find_additional_modules', config.find_additional_modules, false);
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
		const dir = typeof config.assets.directory === 'string' ? config.assets.directory.replace(/^(\.\/)+/, '').replace(/\/+$/, '') : undefined;
		if (dir !== undefined && (dir === '' || dir === '.' || NATIVE_STAGED.entry === dir || NATIVE_STAGED.entry.startsWith(`${dir}/`)))
			problems.push(`the assets directory ${JSON.stringify(config.assets.directory)} holds the Worker entry ${NATIVE_STAGED.entry}: the server bundle would be uploaded as a public asset (the public assets are ${NATIVE_STAGED.assets}, apart from the entry)`);
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

/** The exact upload command, run with the stage as its working directory: no override of any kind. */
export const NATIVE_UPLOAD_ARGV = ['wrangler', 'deploy', '--config', NATIVE_CONFIG_FILE] as const;

/** Problems with `argv` as the native upload command: it must be exactly NATIVE_UPLOAD_ARGV, so no flag can override the checked config. */
export function nativeUploadInvocationProblems(argv: readonly string[]): string[] {
	if (argv.length === NATIVE_UPLOAD_ARGV.length && NATIVE_UPLOAD_ARGV.every((x, i) => argv[i] === x)) return [];
	return [`the upload command is ${JSON.stringify(argv)}, not exactly ${JSON.stringify(NATIVE_UPLOAD_ARGV)}: a CLI flag (--name, --env, --route, --var, --define, --compatibility-*, --keep-vars, --no-bundle, --minify, --config, --outdir, --dry-run) would override or bypass the checked config`];
}

/**
 * The only host-runtime modules the final bundle may import statically: `cloudflare:workers` (the Worker environment, which
 * the SvelteKit adapter-cloudflare worker.js imports) and `node:async_hooks` (AsyncLocalStorage under the target's
 * `nodejs_als` flag). Every other specifier is refused; extending this list is a reviewed change to this file.
 */
export const NATIVE_HOST_IMPORTS = ['cloudflare:workers', 'node:async_hooks'] as const;

/**
 * NATIVE24: the only runtime built-ins a dynamic `import()` may name, each with the compatibility flags of which one must
 * be on (and its `no_` opposite off). `node:async_hooks` is the AsyncLocalStorage module that SvelteKit and Svelte load;
 * `node:crypto` is Svelte's WebCrypto fallback, a built-in only under nodejs_compat (Wrangler 4.151.1 treats any node
 * built-in but async_hooks as needing nodejs_compat). Extending this table is a reviewed change to this file.
 */
export const NATIVE_DYNAMIC_HOST_IMPORTS: Readonly<Record<string, readonly string[]>> = Object.freeze({ 'node:async_hooks': Object.freeze(['nodejs_als', 'nodejs_compat']), 'node:crypto': Object.freeze(['nodejs_compat']) });
/** The flags each static host import needs once the target's flags are known (`cloudflare:workers` needs none). */
const STATIC_HOST_FLAGS: Readonly<Record<string, readonly string[]>> = { 'cloudflare:workers': [], 'node:async_hooks': ['nodejs_als', 'nodejs_compat'] };
const enabled = (needs: readonly string[], flags: readonly string[]) => needs.length === 0 || needs.some((f) => flags.includes(f) && !flags.includes(`no_${f}`));

/** How one `import()` call site's specifiers were proven (target.ts `scanModule`), or why they were not. Lines are 1-based. */
export type DynamicImportFact =
	| { via: 'literal'; specifier: string; line: number }
	| { via: 'forwarder'; forwarder: string; line: number; calls: { specifier: string; line: number }[] }
	| { via: 'unproven'; reason: string; line: number };

/** What target.ts's parser found in the entry module's syntax (nothing here reads or runs the module). `dynamic` classifies each `import()` call; facts without it refuse every dynamic import. */
export type ModuleFacts = { syntaxErrors: string[]; specifiers: string[]; computedSpecifiers: number; dynamicImports: number; requireCalls: number; dynamic?: DynamicImportFact[] };

/**
 * Every reason the entry module is not a closed, prebundled graph that `no_bundle` may upload as it is. Without the
 * target's `flags` (the pre-NATIVE24 two-argument call) or without the `dynamic` classification, every dynamic import is
 * refused as before; with both, a dynamic import passes only when each specifier is proven and enabled by `flags`.
 */
export function uploadModuleProblems(f: ModuleFacts, entry: string = NATIVE_STAGED.entry, flags?: readonly string[]): string[] {
	const problems: string[] = [];
	if (f.syntaxErrors.length) problems.push(`${entry} is not valid JavaScript, so its imports cannot be judged: ${f.syntaxErrors.slice(0, 3).join('; ')}`);
	for (const spec of [...new Set(f.specifiers)].sort())
		if (!(NATIVE_HOST_IMPORTS as readonly string[]).includes(spec))
			problems.push(`${entry} imports ${JSON.stringify(spec)}: with no_bundle nothing resolves it at upload time, so the final bundle must be closed (only ${NATIVE_HOST_IMPORTS.join(', ')} may be imported as host modules; a bare, relative or outside-stage import is refused)`);
		else if (flags !== undefined && !enabled(STATIC_HOST_FLAGS[spec]!, flags))
			problems.push(`${entry} imports ${JSON.stringify(spec)}, which the target's compatibility flags ${JSON.stringify(flags)} do not enable: it needs one of ${STATIC_HOST_FLAGS[spec]!.join(', ')}`);
	if (f.computedSpecifiers) problems.push(`${entry} has ${f.computedSpecifiers} import or export-from with a specifier that is not a string literal`);
	if (f.dynamicImports && (flags === undefined || f.dynamic === undefined))
		problems.push(`${entry} has ${f.dynamicImports} dynamic import() call(s): a dynamic import cannot be bound to the uploaded bytes (computed or not, it is refused)`);
	else if (f.dynamic !== undefined && flags !== undefined) {
		if (f.dynamic.length !== f.dynamicImports) problems.push(`${entry} has ${f.dynamicImports} dynamic import() call(s) but ${f.dynamic.length} were classified: every dynamic import must be judged`);
		const judge = (spec: string, line: number, via: string) => {
			const needs = NATIVE_DYNAMIC_HOST_IMPORTS[spec];
			if (!needs) problems.push(`${entry} has a dynamic import of ${JSON.stringify(spec)} (line ${line}, ${via}): only the runtime built-ins ${Object.keys(NATIVE_DYNAMIC_HOST_IMPORTS).join(', ')} may be imported dynamically; a package, relative chunk or other host module is refused (nothing else is uploaded)`);
			else if (!enabled(needs, flags)) problems.push(`${entry} has a dynamic import of ${JSON.stringify(spec)} (line ${line}, ${via}) that the target's compatibility flags ${JSON.stringify(flags)} do not enable: it needs one of ${needs.join(', ')}`);
		};
		for (const d of f.dynamic) {
			if (d.via === 'unproven') problems.push(`${entry} has a dynamic import() at line ${d.line} whose specifier is not proven to be a runtime built-in: ${d.reason}`);
			else if (d.via === 'literal') judge(d.specifier, d.line, 'a string literal');
			else for (const c of d.calls) judge(c.specifier, c.line, `through the forwarder ${d.forwarder} defined at line ${d.line}`);
		}
	}
	if (f.requireCalls) problems.push(`${entry} has ${f.requireCalls} require() call(s): the final bundle must be a closed ES module graph`);
	return problems;
}

/** The static host imports a closed bundle uses, sorted and distinct, for the stage record. */
export const hostImportsOf = (f: ModuleFacts): string[] => [...new Set(f.specifiers)].sort();

export type DynamicHostImport = { specifier: string; via: string; sites: number };
/** The proven dynamic host imports, per specifier and proof (`literal` or `forwarder <name>`), with their call-site counts, sorted. */
export function dynamicHostImportsOf(f: ModuleFacts): DynamicHostImport[] {
	const count = new Map<string, DynamicHostImport>();
	const add = (specifier: string, via: string) => {
		const k = JSON.stringify([specifier, via]);
		const c = count.get(k) ?? { specifier, via, sites: 0 };
		c.sites++;
		count.set(k, c);
	};
	for (const d of f.dynamic ?? []) {
		if (d.via === 'literal') add(d.specifier, 'literal');
		else if (d.via === 'forwarder') for (const c of d.calls) add(c.specifier, `forwarder ${d.forwarder}`);
	}
	return [...count.values()].sort((x, y) => (x.specifier < y.specifier ? -1 : x.specifier > y.specifier ? 1 : x.via < y.via ? -1 : x.via > y.via ? 1 : 0));
}

export type UploadFile = { path: string; bytes: number; sha256: string };
/** The public assets Wrangler uploads (every file of the assets directory but `_headers`), and the `_headers` rules it applies. */
export type NativeAssets = { directory: typeof NATIVE_STAGED.assets; files: UploadFile[]; headers: UploadFile | null };
export type NativeUpload = { mode: 'prebundled-no-bundle'; bundler: 'none'; entry: { path: string; sha256: string; bytes: number }; hostImports: string[]; dynamicHostImports: DynamicHostImport[]; additionalModules: false; assets: NativeAssets; files: UploadFile[]; invocation: string[] };

/** The record of the ACTUAL final upload bytes: the entry by bytes and hash, the public assets and header rules by their own hashes, every artifact file, and the exact command. */
export function nativeUpload(a: { entry: { sha256: string; bytes: number }; hostImports: string[]; dynamicHostImports: DynamicHostImport[]; assets: NativeAssets; files: UploadFile[] }): NativeUpload {
	return { mode: 'prebundled-no-bundle', bundler: 'none', entry: { path: NATIVE_STAGED.entry, ...a.entry }, hostImports: a.hostImports, dynamicHostImports: a.dynamicHostImports, additionalModules: false, assets: a.assets, files: a.files, invocation: [...NATIVE_UPLOAD_ARGV] };
}

/**
 * The exact `_headers` adapter-cloudflare 8.0.1 writes for a Workers build with no user `_headers` (generate_headers for
 * app dir `_app`): noindex and no-cache on /_app/*, immutable caching on /_app/immutable/*. It is the only header policy
 * the native profile accepts; any other byte, rule or file is refused.
 */
export const NATIVE_ADAPTER_HEADERS =
	'# === START AUTOGENERATED SVELTE IMMUTABLE HEADERS ===\n/_app/*\n  X-Robots-Tag: noindex\n  Cache-Control: no-cache\n# === END AUTOGENERATED SVELTE IMMUTABLE HEADERS ===\n# === START AUTOGENERATED SVELTE IMMUTABLE HEADERS ===\n/_app/immutable/*\n  ! Cache-Control\n  Cache-Control: public, immutable, max-age=31536000\n# === END AUTOGENERATED SVELTE IMMUTABLE HEADERS ===';
/** Wrangler 4.151.1 MAX_ASSET_SIZE and MAX_ASSET_COUNT_DEFAULT. */
export const NATIVE_MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const NATIVE_MAX_ASSET_COUNT = 20_000;

/**
 * The artifact's layout and public-asset policy, from every artifact file (`artifact/...` posix paths, own sizes and
 * hashes) and the `_headers` text when the public root holds one: problems, and the public assets classified. Only
 * artifact/cloudflare/_worker.js may sit outside artifact/public, and the public tree must hold exactly what is served.
 */
export function nativeArtifactLayout(a: { files: UploadFile[]; entrySha256: string; headersText: string | null }): { problems: string[]; assets: NativeAssets } {
	const problems: string[] = [];
	const assets: NativeAssets = { directory: NATIVE_STAGED.assets, files: [], headers: null };
	const pub = `${NATIVE_STAGED.assets}/`;
	for (const f of a.files) {
		if (f.path === NATIVE_STAGED.entry) continue;
		if (f.path.startsWith(`${NATIVE_ENTRY_DIR}/`)) {
			problems.push(`${f.path} is not the Worker entry: only ${NATIVE_STAGED.entry} is uploaded from ${NATIVE_ENTRY_DIR}, as the one module (a source map, chunk or asset beside it is refused)`);
			continue;
		}
		if (!f.path.startsWith(pub)) {
			problems.push(`${f.path} is not part of a native artifact (only ${NATIVE_STAGED.entry}, the server entry, and ${NATIVE_STAGED.assets}/, the public assets)`);
			continue;
		}
		const rel = f.path.slice(pub.length);
		const segments = rel.split('/');
		const name = segments.at(-1)!;
		if (rel === '.assetsignore') problems.push(`${f.path}: an .assetsignore (empty or not) changes which public files Wrangler uploads, and an empty one silences Wrangler's own _worker.js guard; the public directory must hold exactly what is served`);
		else if (segments.some((s) => s.startsWith('.'))) problems.push(`${f.path} is a dotfile or lies in a dot directory: it is refused as a public asset`);
		else if (rel === '_redirects') problems.push(`${f.path}: redirect rules are not part of the native profile (Wrangler would upload and apply them)`);
		else if (rel === '_routes.json') problems.push(`${f.path} is a Pages routing file: in Workers static assets it would only be served as a public file`);
		else if (rel === '_headers') {
			if (a.headersText !== NATIVE_ADAPTER_HEADERS) problems.push(`${f.path} is not the exact adapter-cloudflare 8.0.1 header rules (noindex/no-cache on /_app/*, immutable on /_app/immutable/*): any other _headers policy is refused`);
			else assets.headers = f;
		} else if (segments.some((s) => s.startsWith('_worker.js'))) problems.push(`${f.path} is a server Worker file in the public assets: the server bundle must never be public`);
		else if (name.endsWith('.map')) problems.push(`${f.path} is a source map: it is refused as a public asset`);
		else if (f.sha256 === a.entrySha256) problems.push(`${f.path} is byte-identical to the Worker entry: a renamed server bundle would be public`);
		else if (f.bytes > NATIVE_MAX_ASSET_BYTES) problems.push(`${f.path} is ${f.bytes} bytes, over the 25 MiB Workers asset limit (Wrangler 4.151.1 MAX_ASSET_SIZE)`);
		else assets.files.push(f);
	}
	if (assets.files.length === 0) problems.push(`${NATIVE_STAGED.assets} holds no public assets`);
	if (assets.files.length > NATIVE_MAX_ASSET_COUNT) problems.push(`${NATIVE_STAGED.assets} holds ${assets.files.length} public assets, over Wrangler 4.151.1's ${NATIVE_MAX_ASSET_COUNT}`);
	return { problems, assets };
}

/** The external pins a credentialed caller supplies to `prebuilt`, from the reviewed record and never from the stage. */
export type NativePins = { target: string; config: string; artifact: string; migrations: string; entry: string; source: string };
export const NATIVE_PIN_KEYS = ['target', 'config', 'artifact', 'migrations', 'entry', 'source'] as const;
export const NATIVE_PIN_WHAT: Record<keyof NativePins, string> = {
	target: 'sha256 of the reviewed target.json bytes',
	config: 'sha256 of the reviewed wrangler.jsonc bytes',
	artifact: 'artifact digest (sha256:<hex>)',
	migrations: 'migrations digest (sha256:<hex>)',
	entry: 'sha256 of the final Worker entry module bytes',
	source: 'source commit (40 hex)',
};
const pinValid = (k: keyof NativePins, v: unknown) => typeof v === 'string' && (k === 'source' ? SHA40 : SHA256).test(v);

/** `value` as NativePins, or the reasons it is not: every pin is required, well formed, and nothing else is read. */
export function parseNativePins(value: unknown): { pins?: NativePins; problems: string[] } {
	if (value === undefined || value === null) return { problems: [`the external pins are required (${NATIVE_PIN_KEYS.map((k) => `--pin-${k}`).join(', ')}) and are never read from the stage; none were given`] };
	if (!isObject(value)) return { problems: ['the external pins are not an object'] };
	const problems: string[] = [];
	exactKeys(value, NATIVE_PIN_KEYS, 'pins', problems);
	for (const k of NATIVE_PIN_KEYS) if (Object.hasOwn(value, k) && !pinValid(k, value[k])) problems.push(`pin ${k} ${show(value[k])} is not a ${NATIVE_PIN_WHAT[k]}`);
	return problems.length ? { problems } : { pins: value as NativePins, problems };
}

/** Where each pinned quantity was observed, hashed from the stage (and the reviewed directory), never copied from the stage record. */
export type ObservedPins = Partial<Record<keyof NativePins, string>>;

/** Every pin that does not equal what was observed, plus every pin the reviewed target itself contradicts. */
export function pinProblems(pins: NativePins, observed: ObservedPins, t: NativeTarget): string[] {
	const problems: string[] = [];
	for (const k of NATIVE_PIN_KEYS) {
		const got = observed[k];
		if (got !== undefined && got !== pins[k]) problems.push(`external pin ${k} (--pin-${k}) ${pins[k]} is not the staged ${NATIVE_PIN_WHAT[k]} ${got}`);
	}
	const reviewed: [keyof NativePins, string][] = [['artifact', t.runtime.artifactSha256], ['migrations', t.runtime.migrationsSha256], ['source', t.runtime.sourceSha]];
	for (const [k, v] of reviewed) if (pins[k] !== v) problems.push(`external pin ${k} (--pin-${k}) ${pins[k]} is not the target's ${v}`);
	return problems;
}

/** The record a native stage writes and its prebuilt check recomputes byte for byte. Every claim flag is constant false. */
export function nativeStageRecord(t: NativeTarget, a: { files: Record<string, string>; artifact: string; migrations: string; upload: NativeUpload }) {
	return {
		schema: NATIVE_STAGE_SCHEMA,
		profile: 'native',
		adapter: 'wrangler',
		client: t.client,
		files: a.files,
		artifact: a.artifact,
		migrations: a.migrations,
		upload: a.upload,
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
		v = parseNativeJson(text);
	} catch (e) {
		return [`${NATIVE_STAGED.version} is not JSON: ${(e as Error).message}`];
	}
	if (!isObject(v) || v.version !== t.runtime.sourceSha) return [`${NATIVE_STAGED.version} names ${show(isObject(v) ? v.version : v)}, not the target's source ${t.runtime.sourceSha}`];
	return [];
}

/** The native stage record, as written and recomputed (a separate binder reads it through target.ts `readNativeStage`). */
export type NativeStageRecord = ReturnType<typeof nativeStageRecord>;
