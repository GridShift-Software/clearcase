// The trusted parent's target check (GRS-107). Every client shares one Cloudflare account, so the account is no
// boundary and a token that can deploy one client's Worker can deploy another's. Before anything is uploaded, the
// parent compares each reviewed deploy config with the client's reviewed target manifest (clients/<client>/target.json)
// and refuses a missing field, an unexpected key or binding, a Worker entry, assets directory or migrations directory
// outside the staged copies, and any string value that is another client's identifier, naming the client it belongs
// to. Configs are read as data: a cf config must be a JSON literal, and nothing here evaluates config code, because
// the parent is the process that later holds the upload credentials.
//
//   bun deploy/probes/target.ts check <client> [--format wrangler|cf --config FILE]
//   bun deploy/probes/target.ts stage <client> --artifact DIR --digest sha256:<hex> --out DIR
//   bun deploy/probes/target.ts prebuilt <client> --stage DIR
//
// `check` reads the client's committed wrangler.jsonc and cloudflare.config.ts unless --config names one file. `stage`
// refuses an artifact or migrations directory that is itself a symlink, copies the configs, the target, the artifact and
// the client's reviewed migrations/ into a new directory, the only directory an upload command then runs in, and then
// checks both configs against the staged target.json and digests the artifact there: the check and `stage.json` read the
// staged copy, not the source (only the other clients' targets come from the source).
// The digest covers regular files and directories only: a symlink, device, socket or FIFO anywhere in the artifact or
// the migrations, or as either root, is refused. `prebuilt` checks the Build Output a credential-free `cf build` wrote in
// that stage, because `cf deploy --prebuilt` uploads its bindings, not the cf config's, and refuses any file in it that the check does not read. Exit 0 PASS, 1 refused, 2 usage.
//
// Native profile (an explicit extension; without --profile every command above is the unchanged legacy /1 path):
//
//   bun deploy/probes/target.ts check <client> --profile native --clients DIR [--config FILE]
//   bun deploy/probes/target.ts stage <client> --profile native --clients DIR --artifact DIR --digest sha256:<hex> --out DIR
//   bun deploy/probes/target.ts prebuilt <client> --profile native --clients DIR --stage DIR
//
// The native target (`clearcase.deploy-target.native/1`, deploy/native-alpha/pipeline.ts) binds the approved account,
// zone, custom domain, workers.dev/Preview URLs off, CPU limit, private EU R2, D1 UUID and the runtime/source/artifact/
// migrations identity. Its clients directory is explicit (no committed default: real D1 UUIDs exist only after creation)
// and may hold only target.json, wrangler.jsonc and migrations/. The one adapter is the checked Wrangler config; a cf
// config is refused as a measured capability gap. `stage` copies and checks as the legacy stage does, also requires the
// artifact and migrations digests that the target names and the artifact's _app/version.json to name its source commit,
// and refuses the hosted-gate test-double marker. `prebuilt` re-verifies the whole stage just before an upload: only the
// five staged entries, no symlink or special file anywhere, every hash and the stage record recomputed byte for byte.
// It runs nothing: no Wrangler, no migrations, no credentials, no network.
//
// Fix r1 (native only; the legacy code above is unchanged): the native config must declare no_bundle:true and
// find_additional_modules:false, and the staged _worker.js must be a closed, prebundled module (its parsed imports are
// checked), with the final upload bytes recorded file by file in stage.json. `prebuilt` needs six external pins
// (--pin-target --pin-config --pin-artifact --pin-migrations --pin-entry --pin-source) and a reviewed --clients directory
// outside the stage, because a stage can only agree with itself. `invocation` checks the exact no-override upload command.
// Native command lines take exact flags only. Native reads use descriptors and refuse hard links and special files.
//
// NATIVE24 (native only): `scanModule` proves which runtime built-ins each dynamic import() can name (a literal, or a
// forwarding wrapper whose every use is a direct literal call) and pipeline.ts admits only those the target's flags
// enable; the artifact is artifact/cloudflare/_worker.js beside artifact/public/, judged by pipeline.ts
// `nativeArtifactLayout`; `checkNativeArtifact` serves scripts/hosted-native-bundle; `readNativeStage` returns an
// immutable reading of a verified stage for a separate binder.
import { createHash } from 'node:crypto';
import { closeSync, constants, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	CF_NATIVE_GAP,
	HOSTED_GATE_MARKER,
	NATIVE_CLIENT_FILES,
	NATIVE_CONFIG_FILE,
	NATIVE_PIN_KEYS,
	NATIVE_STAGE_SCHEMA,
	NATIVE_STAGED,
	checkNativeWrangler,
	distinctNative,
	dynamicHostImportsOf,
	hostImportsOf,
	nativeArtifactLayout,
	nativeStageRecord,
	nativeUpload,
	nativeUploadInvocationProblems,
	parseNativeJson,
	parseNativePins,
	parseNativeTarget,
	pinProblems,
	uploadModuleProblems,
	versionProblems,
	type DynamicImportFact,
	type ModuleFacts,
	type NativeStageRecord,
	type NativePins,
	type NativeTarget,
	type NativeUpload,
} from '../native-alpha/pipeline.ts';

export const TARGET_SCHEMA = 'clearcase.deploy-target/1';
export const CLIENTS_DIR = path.join(import.meta.dirname, 'clients');
export const CONFIG_FILES = { wrangler: 'wrangler.jsonc', cf: 'cloudflare.config.ts' } as const;
/** Where a stage puts the reviewed artifact and the client's migrations, relative to the configs: the only Worker entry, assets directory and migrations directory a config may name. */
export const STAGED = { entry: 'artifact/cloudflare/_worker.js', assets: 'artifact/cloudflare', migrations: 'migrations' } as const;
/** The Build Output Specification directory a credential-free `cf build` writes in a stage, which `cf deploy --prebuilt` uploads. */
export const BUILD_OUTPUT = '.cloudflare/output/v0';
const PREBUILT_MODULES = { '_worker.js': 'esm', '_worker.js.map': 'sourcemap' } as Record<string, string>;
export type Format = keyof typeof CONFIG_FILES;

export type Target = {
	schema: typeof TARGET_SCHEMA;
	client: string;
	accountId: string;
	worker: string;
	d1: { binding: string; name: string; id: string };
	r2: { binding: string; bucket: string };
	secrets: string[];
	vars: Record<string, string>;
};

/** What a config deploys to, read as data, before it is compared with a target. */
type Resolved = {
	accountId: unknown;
	worker: unknown;
	d1: { binding: unknown; name: unknown; id: unknown; migrations?: unknown }[];
	r2: { binding: unknown; bucket: unknown }[];
	secrets: unknown;
	vars: unknown;
	entry: unknown;
	/** The Wrangler assets directory; a cf config has none. */
	assets?: unknown;
	/** The whole parsed config, which the foreign-identifier sweep walks. */
	raw: unknown;
};

const NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;
const BINDING = /^[A-Z][A-Z0-9_]{0,62}$/;
const ACCOUNT = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const show = (v: unknown) => (v === undefined ? 'missing' : JSON.stringify(v));

/** Refuses any key outside `allowed`, so a field the check does not read cannot redirect a deploy. */
function onlyKeys(value: Record<string, unknown>, allowed: string[], at: string, problems: string[]) {
	for (const k of Object.keys(value)) if (!allowed.includes(k)) problems.push(`${at}.${k} is not a key the target check reads; remove it or extend the check`);
}

function parseTarget(value: unknown, file: string): Target {
	const problems: string[] = [];
	const fail = (m: string) => problems.push(`${file}: ${m}`);
	if (!isObject(value)) throw new Error(`${file}: not an object`);
	onlyKeys(value, ['schema', 'client', 'accountId', 'worker', 'd1', 'r2', 'secrets', 'vars'], file, problems);
	const { schema, client, accountId, worker, d1, r2, secrets, vars } = value;
	if (schema !== TARGET_SCHEMA) fail(`schema is ${show(schema)}, not ${TARGET_SCHEMA}`);
	if (typeof client !== 'string' || !NAME.test(client)) fail(`client is ${show(client)}`);
	if (typeof accountId !== 'string' || !ACCOUNT.test(accountId)) fail(`accountId is ${show(accountId)}, not 32 hex digits`);
	if (typeof worker !== 'string' || !NAME.test(worker)) fail(`worker is ${show(worker)}`);
	if (!isObject(d1) || typeof d1.binding !== 'string' || !BINDING.test(d1.binding) || typeof d1.name !== 'string' || !NAME.test(d1.name) || typeof d1.id !== 'string' || !UUID.test(d1.id))
		fail(`d1 is ${show(d1)}, not { binding, name, id (a UUID) }`);
	else onlyKeys(d1, ['binding', 'name', 'id'], `${file}: d1`, problems);
	if (!isObject(r2) || typeof r2.binding !== 'string' || !BINDING.test(r2.binding) || typeof r2.bucket !== 'string' || !NAME.test(r2.bucket)) fail(`r2 is ${show(r2)}, not { binding, bucket }`);
	else onlyKeys(r2, ['binding', 'bucket'], `${file}: r2`, problems);
	if (!Array.isArray(secrets) || !secrets.every((s) => typeof s === 'string' && BINDING.test(s)) || new Set(secrets).size !== secrets.length) fail(`secrets is ${show(secrets)}, not a list of distinct binding names`);
	if (!isObject(vars) || !Object.entries(vars).every(([k, v]) => BINDING.test(k) && typeof v === 'string')) fail(`vars is ${show(vars)}, not binding names to strings`);
	else if (vars.CLEARCASE_CLIENT_ID !== client) fail(`vars.CLEARCASE_CLIENT_ID is ${show(vars.CLEARCASE_CLIENT_ID)}, not the client ${show(client)}`);
	if (problems.length) throw new Error(problems.join('\n'));
	return value as Target;
}

/** Each client's identifiers that a config may name, keyed by kind. */
const identifiers = (t: Target) => ({ worker: [t.worker], 'd1 name': [t.d1.name], 'd1 id': [t.d1.id], 'r2 bucket': [t.r2.bucket] });

/** Every clients/<client>/target.json under `dir`. Refuses two targets that share an identifier: a shared one would make every wrong-client comparison blind. */
export function loadTargets(dir = CLIENTS_DIR): Target[] {
	const targets = readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => {
			const file = path.join(dir, e.name, 'target.json');
			const t = parseTarget(JSON.parse(readFileSync(file, 'utf8')), path.relative(process.cwd(), file));
			if (t.client !== e.name) throw new Error(`${file}: client ${t.client} is not its directory's name ${e.name}`);
			return t;
		});
	if (!targets.length) throw new Error(`${dir}: no client targets`);
	return distinct(targets);
}

/** `targets` itself, or a throw when two of them share an identifier. */
function distinct(targets: Target[]): Target[] {
	const owner = new Map<string, string>();
	for (const t of targets)
		for (const [kind, values] of Object.entries(identifiers(t)))
			for (const v of values) {
				const prior = owner.get(v);
				if (prior && prior !== t.client) throw new Error(`${kind} ${v} is in both ${prior}'s and ${t.client}'s targets`);
				owner.set(v, t.client);
			}
	return targets;
}

/** A wrangler.jsonc whose only comments are whole `//` lines, as data. */
function readWrangler(text: string, problems: string[]): Resolved | null {
	let config: unknown;
	try {
		config = JSON.parse(text.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n'));
	} catch (e) {
		problems.push(`the Wrangler config is not JSON with whole-line comments: ${(e as Error).message}`);
		return null;
	}
	if (!isObject(config)) return void problems.push('the Wrangler config is not an object'), null;
	onlyKeys(config, ['name', 'account_id', 'main', 'compatibility_date', 'compatibility_flags', 'send_metrics', 'assets', 'vars', 'secrets', 'd1_databases', 'r2_buckets'], 'config', problems);
	const list = (key: string) => (Array.isArray(config[key]) ? (config[key] as unknown[]) : (problems.push(`config.${key} is ${show(config[key])}, not a list`), []));
	const d1 = list('d1_databases').map((d, i) => {
		const o = isObject(d) ? d : {};
		onlyKeys(o, ['binding', 'database_name', 'database_id', 'migrations_dir'], `config.d1_databases[${i}]`, problems);
		return { binding: o.binding, name: o.database_name, id: o.database_id, migrations: o.migrations_dir };
	});
	const r2 = list('r2_buckets').map((r, i) => {
		const o = isObject(r) ? r : {};
		onlyKeys(o, ['binding', 'bucket_name'], `config.r2_buckets[${i}]`, problems);
		return { binding: o.binding, bucket: o.bucket_name };
	});
	const secrets = isObject(config.secrets) ? (onlyKeys(config.secrets, ['required'], 'config.secrets', problems), config.secrets.required) : undefined;
	const assets = isObject(config.assets) ? (onlyKeys(config.assets, ['directory', 'binding'], 'config.assets', problems), config.assets.directory) : undefined;
	return { accountId: config.account_id, worker: config.name, d1, r2, secrets, vars: config.vars, entry: config.main, assets, raw: config };
}

/** The one module a prebuilt Worker's manifest may start from, or the manifest itself when it names anything else. */
function prebuiltEntry(manifest: unknown): unknown {
	if (!isObject(manifest) || manifest.type !== 'complete' || !isObject(manifest.modules)) return manifest;
	const modules = Object.entries(manifest.modules);
	const known = modules.every(([name, m]) => isObject(m) && PREBUILT_MODULES[name] === m.type && Object.keys(m).length === 1);
	return known && modules.length === Object.keys(PREBUILT_MODULES).length && Object.keys(manifest).length === 3 ? manifest.mainModule : manifest;
}

/**
 * A cloudflare.config.ts that is `export default <JSON literal>;` after whole-line comments, as data, never evaluated; or,
 * for `prebuilt`, the Build Output's config.json with its one Worker's worker.config.json as `worker`.
 */
function readCf(text: string, problems: string[], prebuilt = false): Resolved | null {
	const body = text.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
	const literal = prebuilt ? [body, body] : /^\s*export default (\{[\s\S]*\});\s*$/.exec(body);
	let config: unknown;
	try {
		if (!literal) throw new Error('it is not `export default <JSON literal>;`');
		config = JSON.parse(literal[1]!);
	} catch (e) {
		problems.push(`the ${prebuilt ? 'Build Output' : 'cf config'} is not data only (${(e as Error).message}); the trusted parent never evaluates config code`);
		return null;
	}
	if (!isObject(config)) return void problems.push('the cf config is not an object'), null;
	onlyKeys(config, prebuilt ? ['accountId', 'buildContext', 'worker'] : ['accountId', 'worker'], 'config', problems);
	if (prebuilt && JSON.stringify(config.buildContext) !== '{"isPreview":false}') problems.push(`config.buildContext is ${show(config.buildContext)}, not a production build ({"isPreview":false})`);
	const worker = isObject(config.worker) ? config.worker : (problems.push(`config.worker is ${show(config.worker)}`), {});
	onlyKeys(worker, ['name', 'compatibilityDate', 'compatibilityFlags', prebuilt ? 'manifest' : 'entrypoint', 'env'], 'config.worker', problems);
	const env = isObject(worker.env) ? worker.env : (problems.push(`config.worker.env is ${show(worker.env)}`), {});
	const entry = prebuilt ? prebuiltEntry(worker.manifest) : worker.entrypoint;
	const resolved: Resolved & { secrets: string[]; vars: Record<string, unknown> } = { accountId: config.accountId, worker: worker.name, d1: [], r2: [], secrets: [], vars: {}, entry, raw: config };
	for (const [binding, b] of Object.entries(env)) {
		const at = `config.worker.env.${binding}`;
		const o = isObject(b) ? b : {};
		if (o.type === 'd1') (onlyKeys(o, ['type', 'name', 'id'], at, problems), resolved.d1.push({ binding, name: o.name, id: o.id }));
		else if (o.type === 'r2') (onlyKeys(o, ['type', 'name'], at, problems), resolved.r2.push({ binding, bucket: o.name }));
		else if (o.type === 'secret') (onlyKeys(o, ['type'], at, problems), resolved.secrets.push(binding));
		else if (o.type === 'text') (onlyKeys(o, ['type', 'value'], at, problems), (resolved.vars[binding] = o.value));
		else problems.push(`${at} is ${show(b)}: only d1, r2, secret and text bindings are allowed`);
	}
	return resolved;
}

/** Every reason `text` (a `format` config) must not deploy `client`; empty means it names exactly the client's target. */
export function checkTarget(a: { client: string; targets: Target[]; format: Format | 'prebuilt'; text: string }): string[] {
	const target = a.targets.find((t) => t.client === a.client);
	if (!target) return [`no target manifest for ${a.client}`];
	const problems: string[] = [];
	const config = a.format === 'wrangler' ? readWrangler(a.text, problems) : readCf(a.text, problems, a.format === 'prebuilt');
	if (!config) return problems;
	const owners = new Map(a.targets.flatMap((t) => Object.values(identifiers(t)).flat().map((v) => [v, t.client] as const)));
	const foreign = new Set<string>();
	const expect = (what: string, got: unknown, want: string) => {
		if (got === want) return;
		const owner = typeof got === 'string' ? owners.get(got) : undefined;
		if (owner) foreign.add(got as string);
		problems.push(owner ? `${what} ${got} belongs to ${owner}, not ${a.client}` : `${what} is ${show(got)}, not ${a.client}'s ${want}`);
	};
	expect('account id', config.accountId, target.accountId);
	expect('worker', config.worker, target.worker);
	// The stage checks the artifact's digest, so the config must upload that artifact and nothing beside it.
	const staged = (v: unknown) => (typeof v === 'string' ? path.posix.normalize(v) : v);
	const entry = a.format === 'prebuilt' ? path.basename(STAGED.entry) : STAGED.entry;
	if (staged(config.entry) !== entry) problems.push(`the Worker entry is ${show(config.entry)}, not the staged artifact's ${entry}`);
	if (a.format === 'wrangler' && staged(config.assets) !== STAGED.assets) problems.push(`the assets directory is ${show(config.assets)}, not the staged artifact's ${STAGED.assets}`);
	if (a.format === 'wrangler') for (const d of config.d1) if (staged(d.migrations) !== STAGED.migrations) problems.push(`the migrations directory is ${show(d.migrations)}, not the staged migrations ${STAGED.migrations}`);
	if (config.d1.length !== 1) problems.push(`the config binds ${config.d1.length} D1 databases, not exactly ${a.client}'s one`);
	for (const d of config.d1) (expect('d1 binding', d.binding, target.d1.binding), expect('d1 name', d.name, target.d1.name), expect('d1 id', d.id, target.d1.id));
	if (config.r2.length !== 1) problems.push(`the config binds ${config.r2.length} R2 buckets, not exactly ${a.client}'s one`);
	for (const r of config.r2) (expect('r2 binding', r.binding, target.r2.binding), expect('r2 bucket', r.bucket, target.r2.bucket));
	const secrets = Array.isArray(config.secrets) ? [...config.secrets].sort() : config.secrets;
	if (JSON.stringify(secrets) !== JSON.stringify([...target.secrets].sort())) problems.push(`secret names are ${show(config.secrets)}, not ${a.client}'s ${show(target.secrets)}`);
	if (!isObject(config.vars) || JSON.stringify(Object.entries(config.vars).sort()) !== JSON.stringify(Object.entries(target.vars).sort())) problems.push(`vars are ${show(config.vars)}, not ${a.client}'s ${show(target.vars)}`);
	// Another client's identifier as any string value in the config, a field the comparisons above do not read included. The match is exact: an identifier inside a longer string is not found.
	const walk = (v: unknown): void => {
		if (typeof v === 'string' && owners.has(v) && owners.get(v) !== a.client && !foreign.has(v)) (foreign.add(v), problems.push(`${v} belongs to ${owners.get(v)}, not ${a.client}`));
		else if (Array.isArray(v)) v.forEach(walk);
		else if (isObject(v)) Object.values(v).forEach(walk);
	};
	walk(config.raw);
	return problems;
}

/** Every reason the Build Output a credential-free `cf build` wrote in `stage` must not be uploaded for `client` with `cf deploy --prebuilt`. */
export function checkPrebuilt(a: { client: string; stage: string; targets?: Target[] }): string[] {
	const out = path.join(a.stage, BUILD_OUTPUT);
	const workers = existsSync(path.join(out, 'workers')) ? readdirSync(path.join(out, 'workers')) : [];
	if (workers.length !== 1) return [`the Build Output holds ${workers.length} Workers, not exactly one`];
	// cf reads more than the two configs: containers/*, assets/ and every file in the bundle. Only these may exist.
	const worker = workers[0]!;
	const allowed = new Set(['config.json', `workers/${worker}/worker.config.json`, ...Object.keys(PREBUILT_MODULES).map((m) => `workers/${worker}/bundle/${m}`)]);
	const dirs = new Set(['workers', `workers/${worker}`, `workers/${worker}/bundle`]);
	let entries: { rel: string; dir: boolean }[];
	try {
		entries = walk(out);
	} catch (e) {
		return [`the Build Output holds an entry that is not a regular file or directory: ${(e as Error).message}`];
	}
	const stray = entries.filter((e) => !(e.dir ? dirs : allowed).has(e.rel));
	if (stray.length) return stray.map((e) => `${e.rel} is not part of a prebuilt Worker's Build Output (config.json, the Worker's worker.config.json and its manifest's modules): cf would read it, and the target check does not`);
	let text: string;
	try {
		const top = JSON.parse(readFileSync(path.join(out, 'config.json'), 'utf8')) as unknown;
		const config = JSON.parse(readFileSync(path.join(out, 'workers', worker, 'worker.config.json'), 'utf8')) as unknown;
		if (!isObject(top) || 'worker' in top) return ['the Build Output config.json is not an object without a worker key'];
		text = JSON.stringify({ ...top, worker: config });
	} catch (e) {
		return [`the Build Output cannot be read: ${(e as Error).message}`];
	}
	return checkTarget({ client: a.client, targets: a.targets ?? loadTargets(), format: 'prebuilt', text });
}

/** Every entry under `dir` as a path relative to it, sorted, directories included. Refuses any entry that is not a regular file or a directory, symlinks included: the digest binds what a stage holds, and an upload follows a link. */
function walk(dir: string, rel = ''): { rel: string; dir: boolean }[] {
	return readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
		const at = path.join(rel, e.name);
		if (e.isDirectory()) return [{ rel: at, dir: true }, ...walk(dir, at)];
		if (!e.isFile()) throw new Error(`${path.join(dir, at)} is not a regular file or directory (a symlink, device, socket or FIFO is refused)`);
		return [{ rel: at, dir: false }];
	});
}

/**
 * sha256 over every entry under `dir`, in path order, each framed by its kind, the byte length of its path, the path,
 * and for a file its byte length and bytes, so no two different trees share a digest by moving a separator. Throws on
 * anything that is not a regular file or directory, and on a tree with no files.
 */
export function digestDir(dir: string): string {
	const h = createHash('sha256');
	const entries = walk(dir).sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0));
	if (!entries.some((e) => !e.dir)) throw new Error(`${dir} holds no files`);
	for (const e of entries) {
		const name = Buffer.from(e.rel);
		h.update(`${e.dir ? 'd' : 'f'} ${name.length} `).update(name);
		if (e.dir) h.update('\n');
		else {
			const bytes = readFileSync(path.join(dir, e.rel));
			h.update(` ${bytes.length} `).update(bytes).update('\n');
		}
	}
	return `sha256:${h.digest('hex')}`;
}

/** Refuses `dir` unless it is itself a real directory: `readdir` and `cp` follow a link at the root, so the walk below it would judge the link's target and a later swap of the link would change what is uploaded. */
function realDirectory(dir: string, what: string): string | null {
	try {
		const st = lstatSync(dir);
		if (st.isSymbolicLink()) return `${what} ${dir} is a symlink, not a directory (a symlink is refused)`;
		return st.isDirectory() ? null : `${what} ${dir} is not a directory`;
	} catch {
		return `${what} ${dir} is missing`;
	}
}

/**
 * Copies the configs, the target manifest, the artifact and the client's migrations into `out` (which must not exist), then
 * checks both configs, digests the artifact and the migrations, and writes a stage record. Every check and every hash reads
 * the staged copy, once, so `stage.json` describes the bytes that were checked. A refusal removes `out`.
 */
export function stage(a: { client: string; artifact: string; digest: string; out: string; clients?: string }): string[] {
	const dir = path.join(a.clients ?? CLIENTS_DIR, a.client);
	const sourceTargets = loadTargets(a.clients); // the other clients' manifests, for the wrong-client comparison; this client's own is read from the staged copy below
	const files = ['target.json', ...Object.values(CONFIG_FILES)];
	const migrationsDir = path.join(dir, STAGED.migrations);
	const problems = [realDirectory(a.artifact, 'artifact'), realDirectory(migrationsDir, STAGED.migrations), existsSync(a.out) ? `${a.out} exists; a stage starts empty` : null].filter((p): p is string => p !== null);
	for (const f of files) if (!existsSync(path.join(dir, f))) problems.push(`${f} is missing`);
	if (problems.length) return problems;
	mkdirSync(a.out, { recursive: true });
	const refuse = (m: string[]) => (rmSync(a.out, { recursive: true, force: true }), m);
	try {
		// refuse before copying anything a copy would follow or block on; the staged copy is checked again below
		for (const f of files) if (!lstatSync(path.join(dir, f)).isFile()) throw new Error(`${path.join(dir, f)} is not a regular file`);
		walk(a.artifact);
		walk(migrationsDir);
		for (const f of files) cpSync(path.join(dir, f), path.join(a.out, f));
		cpSync(a.artifact, path.join(a.out, 'artifact'), { recursive: true });
		cpSync(migrationsDir, path.join(a.out, STAGED.migrations), { recursive: true });
	} catch (e) {
		return refuse([(e as Error).message]);
	}
	const staged = Object.fromEntries(files.map((f) => [f, readFileSync(path.join(a.out, f))]));
	let targets: Target[];
	try {
		const own = parseTarget(JSON.parse(staged['target.json']!.toString('utf8')), 'target.json (staged)');
		if (own.client !== a.client) throw new Error(`target.json (staged): client ${own.client} is not ${a.client}`);
		targets = distinct(sourceTargets.map((t) => (t.client === a.client ? own : t)));
	} catch (e) {
		return refuse([(e as Error).message]);
	}
	const configProblems = (Object.keys(CONFIG_FILES) as Format[]).flatMap((format) =>
		checkTarget({ client: a.client, targets, format, text: staged[CONFIG_FILES[format]]!.toString('utf8') }).map((p) => `${CONFIG_FILES[format]}: ${p}`),
	);
	if (configProblems.length) return refuse(configProblems);
	let digest: string, migrations: string;
	try {
		digest = digestDir(path.join(a.out, 'artifact'));
		migrations = digestDir(path.join(a.out, STAGED.migrations));
	} catch (e) {
		return refuse([(e as Error).message]);
	}
	if (digest !== a.digest) return refuse([`artifact ${a.artifact} is ${digest}, not the reviewed ${a.digest}`]);
	const sha = (f: string) => `sha256:${createHash('sha256').update(staged[f]!).digest('hex')}`;
	writeFileSync(path.join(a.out, 'stage.json'), `${JSON.stringify({ schema: 'clearcase.deploy-stage/1', client: a.client, files: Object.fromEntries(files.map((f) => [f, sha(f)])), artifact: digest, migrations }, null, 2)}\n`);
	return [];
}

/**
 * Native file access (fix r1, L3). Every native read goes through here: it never follows a link, never blocks on a FIFO
 * and refuses a file with a second hard link, because another name for the same inode could change the bytes after they
 * were checked. The file is lstat-ed, opened with O_NOFOLLOW|O_NONBLOCK, fstat-ed on the descriptor (same device and
 * inode as the lstat, a regular file, one link), read from that descriptor, and lstat/fstat-ed again: a change in size,
 * times or identity while reading refuses it. With `root`, the real path must still be `root` plus the same relative path,
 * so a directory swapped for a symlink between a walk and the read is refused. This is a best-effort detection of a
 * concurrent swap by a same-user attacker, not an atomic guarantee (Node has no openat); the prebuilt-to-upload gap stays.
 */
const NATIVE_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const NATIVE_MAX_FILE = 64 * 1024 * 1024;
export function readRegular(file: string, root?: string): Buffer {
	const before = lstatSync(file);
	if (before.isSymbolicLink()) throw new Error(`${file} is not a regular file (it is a symlink; a symlink is refused)`);
	if (!before.isFile()) throw new Error(`${file} is not a regular file (a device, socket or FIFO is refused)`);
	if (before.nlink > 1) throw new Error(`${file} has ${before.nlink} hard links: a hard link is refused, because another name could change its bytes after the check`);
	if (root !== undefined) {
		const realRoot = realpathSync(root);
		const real = realpathSync(file);
		const want = path.join(realRoot, path.relative(path.resolve(root), path.resolve(file)));
		if (real !== want) throw new Error(`${file} resolves to ${real}, outside ${root} or through a symlinked directory (refused)`);
	}
	let fd: number;
	try {
		fd = openSync(file, NATIVE_READ_FLAGS);
	} catch (e) {
		throw new Error(`${file} cannot be opened as a regular file without following a link (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) throw new Error(`${file} is not a regular file (it changed between the check and the read)`);
		if (st.dev !== before.dev || st.ino !== before.ino) throw new Error(`${file} was replaced between the check and the read`);
		if (st.nlink > 1) throw new Error(`${file} has ${st.nlink} hard links: a hard link is refused`);
		if (st.size > NATIVE_MAX_FILE) throw new Error(`${file} is ${st.size} bytes, over the ${NATIVE_MAX_FILE} byte limit`);
		const bytes = readFileSync(fd);
		const after = fstatSync(fd);
		const post = lstatSync(file);
		if (bytes.length !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs || post.dev !== st.dev || post.ino !== st.ino) throw new Error(`${file} changed while it was read`);
		return bytes;
	} finally {
		closeSync(fd);
	}
}

/** Every entry under `dir`, sorted per directory, from lstat only: a regular file or a directory, nothing else, and no file with a second hard link. A directory swapped while it is listed is refused. Exported for the native bundle contract (scripts/hosted-native-bundle). */
export function nativeWalk(dir: string, rel = ''): { rel: string; dir: boolean }[] {
	const at = path.join(dir, rel);
	const before = lstatSync(at);
	if (!before.isDirectory()) throw new Error(`${at} is not a directory (a symlink is refused)`);
	const out: { rel: string; dir: boolean }[] = [];
	for (const name of readdirSync(at).sort()) {
		const r = path.join(rel, name);
		const full = path.join(dir, r);
		const st = lstatSync(full);
		if (st.isDirectory()) out.push({ rel: r, dir: true }, ...nativeWalk(dir, r));
		else if (st.isFile()) {
			if (st.nlink > 1) throw new Error(`${full} has ${st.nlink} hard links: a hard link is refused, because another name could change its bytes after the check`);
			out.push({ rel: r, dir: false });
		} else throw new Error(`${full} is not a regular file or directory (a symlink, device, socket or FIFO is refused)`);
	}
	const after = lstatSync(at);
	if (after.dev !== before.dev || after.ino !== before.ino) throw new Error(`${at} was replaced while it was listed`);
	return out;
}

/** The same digest framing as `digestDir` (so reviewed digests carry over), computed from descriptor reads, with every file's own size and hash. `onFile` sees each file's bytes once. */
function nativeTree(dir: string, onFile?: (rel: string, bytes: Buffer) => void): { digest: string; files: { rel: string; bytes: number; sha256: string }[] } {
	const h = createHash('sha256');
	const entries = nativeWalk(dir).sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0));
	if (!entries.some((e) => !e.dir)) throw new Error(`${dir} holds no files`);
	const files: { rel: string; bytes: number; sha256: string }[] = [];
	for (const e of entries) {
		const name = Buffer.from(e.rel);
		h.update(`${e.dir ? 'd' : 'f'} ${name.length} `).update(name);
		if (e.dir) h.update('\n');
		else {
			const bytes = readRegular(path.join(dir, e.rel), dir);
			h.update(` ${bytes.length} `).update(bytes).update('\n');
			files.push({ rel: e.rel, bytes: bytes.length, sha256: sha256Of(bytes) });
			onFile?.(e.rel, bytes);
		}
	}
	return { digest: `sha256:${h.digest('hex')}`, files };
}
const sha256Of = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Copies exactly the entries `nativeWalk` listed, file by file from descriptor reads (no recursive copy that a stale lstat could redirect), then lists the copy again and requires the same entries. */
function copyNativeTree(src: string, dst: string) {
	const entries = nativeWalk(src);
	mkdirSync(dst);
	for (const e of entries) {
		if (e.dir) mkdirSync(path.join(dst, e.rel));
		else writeFileSync(path.join(dst, e.rel), readRegular(path.join(src, e.rel), src), { flag: 'wx', mode: 0o644 });
	}
	const copied = nativeWalk(dst);
	if (JSON.stringify(copied) !== JSON.stringify(entries)) throw new Error(`${src} changed while it was copied`);
}

/** Every clients/<client>/target.json under the explicit native `dir`, each a strict-JSON native target bound to the approved scope. `dir` and every client directory must be real directories and every target.json a regular, single-link file. */
export function loadNativeTargets(dir: string): NativeTarget[] {
	const root = realDirectory(dir, 'native clients directory');
	if (root) throw new Error(root);
	const targets = readdirSync(dir, { withFileTypes: true }).map((e) => {
		if (e.isSymbolicLink()) throw new Error(`${path.join(dir, e.name)} is a symlink, not a client directory (a symlink is refused)`);
		return e;
	})
		.filter((e) => e.isDirectory())
		.map((e) => {
			const file = path.join(dir, e.name, 'target.json');
			const t = parseNativeTarget(parseNativeJson(readRegular(file, dir).toString('utf8')), path.relative(process.cwd(), file));
			if (t.client !== e.name) throw new Error(`${file}: client ${t.client} is not its directory's name ${e.name}`);
			return t;
		});
	if (!targets.length) throw new Error(`${dir}: no native client targets`);
	return distinctNative(targets);
}

/** Problems with a native client directory: only target.json, wrangler.jsonc (regular files) and migrations/ (a real directory). */
function nativeClientDirProblems(dir: string): string[] {
	const root = realDirectory(dir, 'native client directory');
	if (root) return [root];
	const problems: string[] = [];
	const names = readdirSync(dir).sort();
	for (const n of names) {
		if (n === CONFIG_FILES.cf) problems.push(`${path.join(dir, n)}: ${CF_NATIVE_GAP}`);
		else if (!(NATIVE_CLIENT_FILES as readonly string[]).includes(n) && n !== STAGED.migrations) problems.push(`${path.join(dir, n)} is not part of a native client directory (target.json, ${NATIVE_CONFIG_FILE}, ${STAGED.migrations}/)`);
	}
	for (const f of NATIVE_CLIENT_FILES) {
		const st = existsSync(path.join(dir, f)) ? lstatSync(path.join(dir, f)) : null;
		if (!st) problems.push(`${f} is missing`);
		else if (!st.isFile()) problems.push(`${path.join(dir, f)} is not a regular file (a symlink or special file is refused)`);
	}
	return problems;
}

/** Every reason the native config `text` must not deploy `client`; `format` other than wrangler is the measured cf gap. */
export function checkNative(a: { client: string; targets: NativeTarget[]; format?: Format | 'prebuilt'; text: string }): string[] {
	if (a.format !== undefined && a.format !== 'wrangler') return [CF_NATIVE_GAP];
	return checkNativeWrangler({ client: a.client, targets: a.targets, text: a.text });
}

/**
 * The entry module's syntax as facts: its static import and export-from specifiers, whether any is computed, dynamic
 * `import()` and `require()` calls, and parse errors. It parses with TypeScript's parser (a root devDependency, loaded on
 * first use) and runs nothing; the walk is iterative so a deeply nested bundle cannot exhaust the stack. A comment or a
 * string that mentions an import is not an import.
 *
 * NATIVE24: every `import()` call is also classified (`dynamic`). A string-literal specifier is `literal`. An identifier
 * specifier is `forwarder` only under this whole proof, else `unproven` with the reason:
 *  - the call is the entire concise body of an arrow function with exactly one plain parameter, that identifier, and
 *    one argument (no import options), so the parameter cannot be rewritten and `arguments` does not exist;
 *  - the arrow is bound to a name W directly, or through esbuild's keep-names helper `__name(arrow, "W")`, by the
 *    initializer of W's declaration or by one plain `W = ...` statement;
 *  - W is declared exactly once, at module scope, unexported, and every other occurrence of the identifier W anywhere
 *    in the module is a direct, non-optional call with exactly one string-literal argument (no alias, export, property
 *    read, typeof, argument passing, reassignment or shadowing declaration): those literals are W's only specifiers;
 *  - a keep-names helper is proven to be esbuild's `(target, value) => D(target, "name", { value, configurable: true })`
 *    with D declared once as `Object.defineProperty`, neither reassigned nor used except as direct calls, and `Object`
 *    neither declared nor written, and no static write to any `.defineProperty` or `.Object` property except proven
 *    local numeric-enum mappings (a non-escaping IIFE parameter receiving only a fresh, unaliased local object);
 *  - the module contains no `eval` identifier (direct eval could read W; Workers refuse code generation anyway).
 * Whether a proven specifier is allowed is pipeline.ts `uploadModuleProblems`' decision, from the target's flags.
 */
export function scanModule(source: string): ModuleFacts {
	const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
	const sf = ts.createSourceFile('_worker.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const dynamic: DynamicImportFact[] = [];
	const facts: ModuleFacts = { syntaxErrors: [], specifiers: [], computedSpecifiers: 0, dynamicImports: 0, requireCalls: 0, dynamic };
	for (const d of (sf as unknown as { parseDiagnostics: import('typescript').Diagnostic[] }).parseDiagnostics) facts.syntaxErrors.push(ts.flattenDiagnosticMessageText(d.messageText, ' '));
	type Node = import('typescript').Node;
	type Identifier = import('typescript').Identifier;
	const ids = new Map<string, Identifier[]>();
	const imports: import('typescript').CallExpression[] = [];
	const defineWrites: Node[] = [];
	const INTRINSIC_NAMES = new Set(['defineProperty', 'Object']);
	const stack: Node[] = [sf];
	for (let n = stack.pop(); n; n = stack.pop()) {
		if (ts.isIdentifier(n)) {
			const list = ids.get(n.text);
			list ? list.push(n) : ids.set(n.text, [n]);
		} else if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
			if (n.moduleSpecifier) ts.isStringLiteral(n.moduleSpecifier) ? facts.specifiers.push(n.moduleSpecifier.text) : facts.computedSpecifiers++;
		} else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
			ts.isStringLiteral(n.moduleReference.expression) ? facts.specifiers.push(n.moduleReference.expression.text) : facts.computedSpecifiers++;
		} else if (ts.isCallExpression(n)) {
			const callee = n.expression;
			if (callee.kind === ts.SyntaxKind.ImportKeyword) (facts.dynamicImports++, imports.push(n));
			else if ((ts.isIdentifier(callee) && callee.text === 'require') || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'require')) facts.requireCalls++;
		} else if (((ts.isPropertyAccessExpression(n) && INTRINSIC_NAMES.has(n.name.text)) || (ts.isElementAccessExpression(n) && ts.isStringLiteral(n.argumentExpression) && INTRINSIC_NAMES.has(n.argumentExpression.text))) && isWriteTarget(n)) defineWrites.push(n);
		n.forEachChild((c) => void stack.push(c));
	}
	const line = (n: Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
	function isWriteTarget(n: Node): boolean {
		let at = n;
		while (at.parent && (ts.isParenthesizedExpression(at.parent) || ts.isArrayLiteralExpression(at.parent) || ts.isObjectLiteralExpression(at.parent) || ts.isSpreadElement(at.parent) || ts.isSpreadAssignment(at.parent) || ts.isShorthandPropertyAssignment(at.parent) || (ts.isPropertyAssignment(at.parent) && at.parent.initializer === at))) at = at.parent;
		const p = at.parent;
		if (!p) return false;
		if (ts.isBinaryExpression(p) && p.left === at && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return true;
		if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) return true;
		if ((ts.isForInStatement(p) || ts.isForOfStatement(p)) && p.initializer === at) return true;
		return ts.isDeleteExpression(p);
	}
	const isDeclarationName = (i: Identifier) => {
		const p = i.parent as Node & { name?: Node };
		return p.name === i && (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p) || ts.isImportClause(p) || ts.isImportSpecifier(p) || ts.isNamespaceImport(p) || ts.isImportEqualsDeclaration(p));
	};
	const directCall = (i: Identifier) => ts.isCallExpression(i.parent) && i.parent.expression === i && !i.parent.questionDotToken;
	/** The one module-scope, unexported `var|let|const` declaration of `name`, or why there is not exactly one. */
	const moduleDeclaration = (name: string): { decl?: import('typescript').VariableDeclaration; problem?: string } => {
		const decls = (ids.get(name) ?? []).filter(isDeclarationName);
		if (decls.length !== 1) return { problem: `${name} is declared ${decls.length} times (a second declaration could shadow it)` };
		const d = decls[0]!.parent;
		if (!ts.isVariableDeclaration(d) || !ts.isVariableDeclarationList(d.parent) || !ts.isVariableStatement(d.parent.parent) || d.parent.parent.parent !== sf) return { problem: `${name} is not declared by a module-scope variable statement` };
		if (d.parent.parent.modifiers?.length) return { problem: `${name} is exported or modified` };
		return { decl: d };
	};
	/** Every occurrence of `name` but `skip` must be a direct non-optional call (`check` adds a condition); else the line of the first other use. */
	const onlyCalls = (name: string, skip: Node[], check: (c: import('typescript').CallExpression) => boolean = () => true) => {
		for (const i of ids.get(name) ?? []) if (!skip.includes(i) && !(directCall(i) && check(i.parent as import('typescript').CallExpression))) return line(i);
		return undefined;
	};
	const plainParam = (p: import('typescript').ParameterDeclaration | undefined) => !!p && ts.isIdentifier(p.name) && !p.initializer && !p.dotDotDotToken;
	/**
	 * TypeScript's numeric-enum IIFE is not an intrinsic write just because a member is named Object/defineProperty.
	 * Prove the receiver, not its spelling: the entire unnamed IIFE only writes literal forward/reverse mappings to
	 * its sole parameter, and its argument is E || (E = {}), where E is an uninitialised, unexported module binding.
	 * Every other E occurrence must be a static member read: no alias, escape, shadow, export or other assignment.
	 * Anything outside this small grammar stays in defineWrites, including enum-shaped calls with global receivers.
	 */
	const localEnumWrite = (write: Node): boolean => {
		const inner = write.parent, access = inner?.parent, outer = access?.parent, statement = outer?.parent;
		if (!statement || !ts.isExpressionStatement(statement) || !ts.isBlock(statement.parent) || !ts.isFunctionExpression(statement.parent.parent)) return false;
		const fn = statement.parent.parent;
		if (fn.name || fn.modifiers?.length || fn.asteriskToken || fn.parameters.length !== 1 || !plainParam(fn.parameters[0])) return false;
		const param = (fn.parameters[0]!.name as Identifier).text;
		const receiver = (n: Node) => ts.isIdentifier(n) && n.text === param;
		// No extra statements, calls, rebindings, nested scopes or parameter escapes are admitted in the body.
		if (!fn.body.statements.every((s) => {
			if (!ts.isExpressionStatement(s) || !ts.isBinaryExpression(s.expression)) return false;
			const reverse = s.expression;
			if (reverse.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isStringLiteral(reverse.right) || !ts.isElementAccessExpression(reverse.left) || !receiver(reverse.left.expression)) return false;
			const forward = reverse.left.argumentExpression;
			if (!ts.isBinaryExpression(forward) || forward.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isNumericLiteral(forward.right) || !ts.isElementAccessExpression(forward.left) || !receiver(forward.left.expression)) return false;
			return ts.isStringLiteral(forward.left.argumentExpression) && forward.left.argumentExpression.text === reverse.right.text;
		})) return false;
		let holder: Node = fn;
		while (ts.isParenthesizedExpression(holder.parent)) holder = holder.parent;
		const call = holder.parent;
		if (!ts.isCallExpression(call) || call.expression !== holder || call.questionDotToken || call.arguments.length !== 1 || !ts.isExpressionStatement(call.parent)) return false;
		// A with environment could resolve the argument's identifier to something other than the module binding.
		for (let p: Node | undefined = call.parent; p; p = p.parent) if (ts.isWithStatement(p)) return false;
		const arg = call.arguments[0]!;
		if (!ts.isBinaryExpression(arg) || arg.operatorToken.kind !== ts.SyntaxKind.BarBarToken || !ts.isIdentifier(arg.left)) return false;
		let fallback = arg.right;
		while (ts.isParenthesizedExpression(fallback)) fallback = fallback.expression;
		if (!ts.isBinaryExpression(fallback) || fallback.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isIdentifier(fallback.left) || fallback.left.text !== arg.left.text || !ts.isObjectLiteralExpression(fallback.right) || fallback.right.properties.length) return false;
		const { decl } = moduleDeclaration(arg.left.text);
		if (!decl || decl.initializer) return false;
		return (ids.get(arg.left.text) ?? []).every((i) => {
			if (i === decl.name || i === arg.left || i === fallback.left) return true;
			const p = i.parent;
			const member = (ts.isPropertyAccessExpression(p) || (ts.isElementAccessExpression(p) && (ts.isStringLiteral(p.argumentExpression) || ts.isNumericLiteral(p.argumentExpression)))) && p.expression === i;
			return member && !isWriteTarget(p);
		});
	};
	const helperProblems = new Map<string, string | null>();
	/** Null when `name` is proven to be esbuild's keep-names helper (returns its first argument, retains nothing); else why not. */
	const keepNamesHelper = (name: string): string | null => {
		if (helperProblems.has(name)) return helperProblems.get(name)!;
		const prove = (): string | null => {
			const { decl, problem } = moduleDeclaration(name);
			if (!decl) return problem!;
			const init = decl.initializer;
			if (!init || !ts.isArrowFunction(init) || init.modifiers?.length || init.parameters.length !== 2 || !init.parameters.every(plainParam)) return `${name} is not esbuild's keep-names helper (target, value) => ...`;
			const [t, v] = init.parameters.map((p) => (p.name as Identifier).text);
			const body = init.body;
			if (!ts.isCallExpression(body) || body.questionDotToken || !ts.isIdentifier(body.expression) || body.arguments.length !== 3) return `${name} does not only call a defineProperty alias`;
			const [a0, a1, a2] = body.arguments;
			const props = a2 && ts.isObjectLiteralExpression(a2) ? a2.properties : undefined;
			const value = props?.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === 'value');
			const conf = props?.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === 'configurable');
			const valueOk = !!value && ((ts.isShorthandPropertyAssignment(value) && v === 'value' && !value.objectAssignmentInitializer) || (ts.isPropertyAssignment(value) && ts.isIdentifier(value.initializer) && value.initializer.text === v));
			const confOk = !!conf && ts.isPropertyAssignment(conf) && conf.initializer.kind === ts.SyntaxKind.TrueKeyword;
			if (!a0 || !ts.isIdentifier(a0) || a0.text !== t || !a1 || !ts.isStringLiteral(a1) || a1.text !== 'name' || props?.length !== 2 || !valueOk || !confOk) return `${name} is not esbuild's keep-names helper D(target, "name", { value, configurable: true })`;
			const alias = body.expression.text;
			const d = moduleDeclaration(alias);
			if (!d.decl) return d.problem!;
			const di = d.decl.initializer;
			if (!di || !ts.isPropertyAccessExpression(di) || di.questionDotToken || !ts.isIdentifier(di.expression) || di.expression.text !== 'Object' || di.name.text !== 'defineProperty') return `${alias} is not Object.defineProperty`;
			const aliasUse = onlyCalls(alias, [d.decl.name]);
			if (aliasUse !== undefined) return `${alias} is used at line ${aliasUse} other than as a direct call (it could be replaced)`;
			const helperUse = onlyCalls(name, [decl.name]);
			if (helperUse !== undefined) return `${name} is used at line ${helperUse} other than as a direct call (it could be replaced)`;
			const object = (ids.get('Object') ?? []).find((i) => isDeclarationName(i) || isWriteTarget(i) || ts.isShorthandPropertyAssignment(i.parent));
			if (object) return `Object is declared or written at line ${line(object)}`;
			const intrinsicWrite = defineWrites.find((n) => !localEnumWrite(n));
			if (intrinsicWrite) return `a defineProperty or Object property is written at line ${line(intrinsicWrite)}`;
			return null;
		};
		const r = prove();
		helperProblems.set(name, r);
		return r;
	};
	const forwarder = (call: import('typescript').CallExpression, param: Identifier): { name: string; calls: { specifier: string; line: number }[] } | string => {
		const fn = call.parent;
		if (!ts.isArrowFunction(fn) || fn.body !== call) return 'its specifier is a variable, and the import is not the entire body of an arrow function';
		if (fn.modifiers?.length || fn.parameters.length !== 1 || !plainParam(fn.parameters[0]) || (fn.parameters[0]!.name as Identifier).text !== param.text) return 'its forwarding arrow does not take exactly one plain parameter that is the specifier';
		if (ids.has('eval')) return `the module names eval (line ${line(ids.get('eval')![0]!)}), which could reach the forwarder`;
		let holder: Node = fn;
		const wrap = fn.parent;
		if (ts.isCallExpression(wrap) && wrap.arguments[0] === fn) {
			if (wrap.questionDotToken || !ts.isIdentifier(wrap.expression) || wrap.arguments.length !== 2 || !ts.isStringLiteral(wrap.arguments[1]!)) return 'its forwarding arrow is passed to a call that is not a keep-names helper call';
			const helper = keepNamesHelper(wrap.expression.text);
			if (helper) return `its forwarding arrow passes through ${wrap.expression.text}, which is not proven to return it unchanged: ${helper}`;
			holder = wrap;
		}
		const bind = holder.parent;
		let name: string, assigned: Identifier | undefined;
		if (ts.isVariableDeclaration(bind) && bind.initializer === holder && ts.isIdentifier(bind.name)) name = bind.name.text;
		else if (ts.isBinaryExpression(bind) && bind.operatorToken.kind === ts.SyntaxKind.EqualsToken && bind.right === holder && ts.isIdentifier(bind.left) && ts.isExpressionStatement(bind.parent)) (name = bind.left.text), (assigned = bind.left);
		else return 'its forwarding arrow is not bound to a name by a declaration or one plain assignment statement';
		const { decl, problem } = moduleDeclaration(name);
		if (!decl) return `forwarder ${name}: ${problem}`;
		if (assigned ? decl.initializer !== undefined : decl !== bind) return `forwarder ${name} is both initialised and assigned, or bound twice`;
		const calls: { specifier: string; line: number }[] = [];
		const other = onlyCalls(name, assigned ? [decl.name, assigned] : [decl.name], (c) => {
			const arg = c.arguments[0];
			if (c.arguments.length !== 1 || !arg || !ts.isStringLiteral(arg)) return false;
			calls.push({ specifier: arg.text, line: line(c) });
			return true;
		});
		if (other !== undefined) return `forwarder ${name} is used at line ${other} other than as a direct call with one string literal (it could escape or receive a computed specifier)`;
		return { name, calls };
	};
	for (const call of imports.sort((x, y) => x.pos - y.pos)) {
		const at = line(call);
		const arg = call.arguments[0];
		if (call.arguments.length !== 1 || !arg) dynamic.push({ via: 'unproven', reason: 'import() has import options or no single argument', line: at });
		else if (ts.isStringLiteral(arg)) dynamic.push({ via: 'literal', specifier: arg.text, line: at });
		else if (!ts.isIdentifier(arg)) dynamic.push({ via: 'unproven', reason: 'its specifier is computed (neither a string literal nor a proven forwarding parameter)', line: at });
		else {
			const proof = forwarder(call, arg);
			dynamic.push(typeof proof === 'string' ? { via: 'unproven', reason: proof, line: at } : { via: 'forwarder', forwarder: proof.name, line: at, calls: proof.calls });
		}
	}
	return facts;
}

/** Every artifact file as `artifact/<posix path>`, with its own size and hash. */
const artifactFiles = (files: { rel: string; bytes: number; sha256: string }[]) => files.map((f) => ({ path: path.posix.join('artifact', f.rel.split(path.sep).join('/')), bytes: f.bytes, sha256: f.sha256 }));

/**
 * The artifact tree at `artifactDir` judged as the final upload, read once through descriptors: the layout and public-asset
 * policy, the entry module's imports under `flags`, and the upload record built from those bytes. `onFile` sees each
 * file's `artifact/...` path and bytes. Shared by the stage, prebuilt and the bundle contract (scripts/hosted-native-bundle).
 */
function nativeArtifactUpload(artifactDir: string, flags: readonly string[], onFile?: (rel: string, bytes: Buffer) => void): { problems: string[]; digest?: string; upload?: NativeUpload; entrySha?: string } {
	const problems: string[] = [];
	let entry: Buffer | undefined, headers: Buffer | undefined;
	let tree: ReturnType<typeof nativeTree>;
	try {
		tree = nativeTree(artifactDir, (rel, bytes) => {
			const at = path.posix.join('artifact', rel.split(path.sep).join('/'));
			if (bytes.includes(HOSTED_GATE_MARKER)) problems.push(`${at} holds the hosted-gate test-double marker: not a production artifact`);
			if (at === NATIVE_STAGED.entry) entry = bytes;
			if (at === `${NATIVE_STAGED.assets}/_headers`) headers = bytes;
			onFile?.(at, bytes);
		});
	} catch (e) {
		return { problems: [(e as Error).message] };
	}
	if (entry === undefined) return { problems: [...problems, `${NATIVE_STAGED.entry} is not a regular file in the staged artifact`], digest: tree.digest };
	const entrySha = sha256Of(entry);
	const files = artifactFiles(tree.files);
	const layout = nativeArtifactLayout({ files, entrySha256: entrySha, headersText: headers === undefined ? null : headers.toString('utf8') });
	problems.push(...layout.problems);
	let facts: ModuleFacts;
	try {
		facts = scanModule(new TextDecoder('utf-8', { fatal: true }).decode(entry));
	} catch (e) {
		return { problems: [...problems, `${NATIVE_STAGED.entry} cannot be read as UTF-8 JavaScript, so it is not valid JavaScript to judge: ${(e as Error).message}`], digest: tree.digest };
	}
	problems.push(...uploadModuleProblems(facts, NATIVE_STAGED.entry, flags));
	const upload = nativeUpload({ entry: { sha256: entrySha, bytes: entry.length }, hostImports: hostImportsOf(facts), dynamicHostImports: dynamicHostImportsOf(facts), assets: layout.assets, files });
	return { problems, digest: tree.digest, upload, entrySha };
}

/** NATIVE24: every reason the artifact directory (cloudflare/_worker.js beside public/) is not a final native upload under `compatibilityFlags`, and its upload record. Reads only; the bundle contract calls it before anything is staged. */
export function checkNativeArtifact(a: { artifact: string; compatibilityFlags: readonly string[] }): { problems: string[]; digest?: string; upload?: NativeUpload } {
	const root = realDirectory(a.artifact, 'artifact');
	if (root) return { problems: [root] };
	const r = nativeArtifactUpload(a.artifact, a.compatibilityFlags);
	return { problems: r.problems, digest: r.digest, upload: r.upload };
}

/** What the staged artifact says about the final upload: its problems, and the upload record built from the bytes read once from the stage. */
function nativeArtifactFacts(stageDir: string, t: NativeTarget): { problems: string[]; digest?: string; upload?: NativeUpload; entrySha?: string } {
	let version: Buffer | undefined;
	const r = nativeArtifactUpload(path.join(stageDir, 'artifact'), t.runtime.compatibilityFlags, (at, bytes) => {
		if (at === NATIVE_STAGED.version) version = bytes;
	});
	if (r.digest === undefined) return r;
	return { ...r, problems: [...versionProblems(version === undefined ? null : version.toString('utf8'), t), ...r.problems] };
}

/** The staged files' hashes, digests and identity checks shared by `stageNative` and `checkNativeStage`, read from the stage only; with `reviewed`, also the reviewed bytes and the external pins. Problems accumulate, so one refusal does not hide another. */
function nativeStageFacts(out: string, client: string, sourceTargets: NativeTarget[], pinning?: { pins: NativePins; reviewedClients: string }): { problems: string[]; reviewProblems: string[]; target?: NativeTarget; record?: ReturnType<typeof nativeStageRecord> } {
	let staged: Record<string, Buffer>;
	try {
		staged = Object.fromEntries(NATIVE_CLIENT_FILES.map((f) => [f, readRegular(path.join(out, f), out)]));
	} catch (e) {
		return { problems: [(e as Error).message], reviewProblems: [] };
	}
	let own: NativeTarget, targets: NativeTarget[];
	try {
		own = parseNativeTarget(parseNativeJson(staged['target.json']!.toString('utf8')), 'target.json (staged)');
		if (own.client !== client) throw new Error(`target.json (staged): client ${own.client} is not ${client}`);
		targets = distinctNative([...sourceTargets.filter((t) => t.client !== client), own]);
	} catch (e) {
		return { problems: [(e as Error).message], reviewProblems: [] };
	}
	const problems = checkNative({ client, targets, text: staged[NATIVE_CONFIG_FILE]!.toString('utf8') }).map((p) => `${NATIVE_CONFIG_FILE}: ${p}`);
	const art = nativeArtifactFacts(out, own);
	let migrations: string | undefined;
	try {
		migrations = nativeTree(path.join(out, STAGED.migrations)).digest;
	} catch (e) {
		problems.push((e as Error).message);
	}
	if (art.digest !== undefined && art.digest !== own.runtime.artifactSha256) problems.push(`the staged artifact is ${art.digest}, not the target's ${own.runtime.artifactSha256}`);
	if (migrations !== undefined && migrations !== own.runtime.migrationsSha256) problems.push(`the staged migrations are ${migrations}, not the target's ${own.runtime.migrationsSha256}`);
	problems.push(...art.problems);
	// Review problems (the reviewed bytes and the external pins) are kept apart so a record or integrity refusal does not hide them, and they do not hide it.
	const reviewProblems: string[] = [];
	if (pinning) {
		const reviewed = (f: string) => {
			try {
				return readRegular(path.join(pinning.reviewedClients, client, f), pinning.reviewedClients);
			} catch (e) {
				reviewProblems.push(`the reviewed ${f} cannot be read: ${(e as Error).message}`);
				return undefined;
			}
		};
		for (const f of NATIVE_CLIENT_FILES) {
			const r = reviewed(f);
			if (r !== undefined && !r.equals(staged[f]!)) reviewProblems.push(`the staged ${f} differs from the reviewed ${path.join(pinning.reviewedClients, client, f)}: the stage is not built from the reviewed source`);
		}
		reviewProblems.push(...pinProblems(pinning.pins, { target: sha256Of(staged['target.json']!), config: sha256Of(staged[NATIVE_CONFIG_FILE]!), artifact: art.digest, migrations, entry: art.entrySha, source: own.runtime.sourceSha }, own));
	}
	if (problems.length || !art.upload || art.digest === undefined || migrations === undefined) return { problems, reviewProblems, target: own };
	return { problems, reviewProblems, target: own, record: nativeStageRecord(own, { files: Object.fromEntries(NATIVE_CLIENT_FILES.map((f) => [f, sha256Of(staged[f]!)])), artifact: art.digest, migrations, upload: art.upload }) };
}

const recordText = (r: object) => `${JSON.stringify(r, null, 2)}\n`;

/** Problems with the reviewed clients directory and the stage as locations: the reviewed source must be real, outside the stage, and not hold the stage. Stage-self agreement is not review. */
function reviewedSourceProblems(clients: string, stage: string): string[] {
	const root = realDirectory(clients, 'reviewed clients directory');
	if (root) return [root];
	let realClients: string, realStage: string;
	try {
		realClients = realpathSync(clients);
		const parent = realpathSync(path.dirname(path.resolve(stage)));
		realStage = path.join(parent, path.basename(path.resolve(stage)));
	} catch (e) {
		return [`cannot resolve the reviewed clients directory or the stage: ${(e as Error).message}`];
	}
	const inside = (outer: string, inner: string) => inner === outer || inner.startsWith(outer + path.sep);
	const problems: string[] = [];
	if (inside(realStage, realClients)) problems.push(`the reviewed clients directory ${clients} is inside the stage ${stage}: a reviewed source the stage can rewrite is not review`);
	if (inside(realClients, realStage)) problems.push(`the stage ${stage} is inside the reviewed clients directory ${clients}: a stage that can rewrite its reviewed source is not review`);
	return problems;
}

/**
 * The native stage: copies the client's target.json, wrangler.jsonc and migrations/ and the artifact into `out` (which
 * must not exist) file by file from descriptor reads, then checks and digests the staged copy only and writes a native
 * stage record. A refusal removes `out`. The stage's own agreement with itself is not review: `prebuilt` needs pins.
 */
export function stageNative(a: { client: string; artifact: string; digest: string; out: string; clients: string }): string[] {
	const dir = path.join(a.clients, a.client);
	let sourceTargets: NativeTarget[];
	try {
		sourceTargets = loadNativeTargets(a.clients);
	} catch (e) {
		return [(e as Error).message];
	}
	const migrationsDir = path.join(dir, STAGED.migrations);
	const problems = [
		...nativeClientDirProblems(dir),
		realDirectory(a.artifact, 'artifact'),
		realDirectory(migrationsDir, STAGED.migrations),
		existsSync(a.out) ? `${a.out} exists; a stage starts empty` : null,
		...reviewedSourceProblems(a.clients, a.out),
	].filter((p): p is string => p !== null);
	if (problems.length) return problems;
	mkdirSync(a.out, { recursive: true });
	const refuse = (m: string[]) => (rmSync(a.out, { recursive: true, force: true }), m);
	try {
		for (const f of NATIVE_CLIENT_FILES) writeFileSync(path.join(a.out, f), readRegular(path.join(dir, f), dir), { flag: 'wx', mode: 0o644 });
		copyNativeTree(a.artifact, path.join(a.out, 'artifact'));
		copyNativeTree(migrationsDir, path.join(a.out, STAGED.migrations));
		nativeWalk(a.out);
	} catch (e) {
		return refuse([(e as Error).message]);
	}
	const facts = nativeStageFacts(a.out, a.client, sourceTargets);
	if (facts.problems.length || !facts.record) return refuse(facts.problems);
	if (facts.record.artifact !== a.digest) return refuse([`artifact ${a.artifact} is ${facts.record.artifact}, not the reviewed ${a.digest}`]);
	writeFileSync(path.join(a.out, 'stage.json'), recordText(facts.record));
	return [];
}

/**
 * Every reason the native stage `stage` must not be uploaded for `client`. It needs the EXTERNAL reviewed pins (never read
 * from the stage) and a reviewed `clients` directory outside the stage whose target.json and wrangler.jsonc are
 * byte-identical to the staged ones; absent pins refuse. Everything else is re-verified from the stage: every hash, the
 * artifact's final upload bytes (a closed prebundled module) and the stage record byte for byte. The pins and the reviewed
 * directory are the root of trust: they must come from the credentialed caller's reviewed record, and this function cannot
 * tell a reviewed pin from a forged one a caller chose.
 */
export function checkNativeStage(a: { client: string; stage: string; clients: string; pins?: NativePins }): string[] {
	return [...readNativeStage(a).problems];
}

/**
 * NATIVE24 evidence API for a separate native-stage binder (which owns its own module and is not edited here): the same
 * verification as `checkNativeStage`, run once, returned as an immutable reading. `record` is the stage record
 * RECOMPUTED from the stage bytes (equal to stage.json byte for byte) and `files` the sha256 of the exact stage.json,
 * target.json and wrangler.jsonc bytes judged; both are null unless `problems` is empty. A reading is structural
 * evidence of one local check: every claim flag in it stays false, and it is not provider, controls or funding proof.
 */
export type NativeStageReading = {
	readonly checker: 'checkNativeStage';
	readonly client: string;
	readonly pins: Readonly<NativePins> | null;
	readonly problems: readonly string[];
	readonly files: Readonly<{ stageJson: string; targetJson: string; configJsonc: string }> | null;
	readonly record: NativeStageRecord | null;
};
const deepFreeze = <T>(v: T): T => {
	if (v && typeof v === 'object' && !Object.isFrozen(v)) {
		Object.freeze(v);
		for (const x of Object.values(v)) deepFreeze(x);
	}
	return v;
};
export function readNativeStage(a: { client: string; stage: string; clients: string; pins?: NativePins }): NativeStageReading {
	const given = parseNativePins(a.pins).pins;
	const done = (problems: string[], record?: NativeStageRecord, stageJson?: string): NativeStageReading =>
		deepFreeze({
			checker: 'checkNativeStage',
			client: a.client,
			pins: given ? { ...given } : null,
			problems: [...problems],
			files: !problems.length && record && stageJson ? { stageJson, targetJson: record.files['target.json']!, configJsonc: record.files['wrangler.jsonc']! } : null,
			record: !problems.length && record && stageJson ? structuredClone(record) : null,
		});
	const root = realDirectory(a.stage, 'stage');
	if (root) return done([root]);
	const parsed = parseNativePins(a.pins);
	if (!parsed.pins) return done(parsed.problems);
	const problems = reviewedSourceProblems(a.clients, a.stage);
	let entries: { rel: string; dir: boolean }[];
	try {
		entries = nativeWalk(a.stage);
	} catch (e) {
		return done([...problems, `the stage holds an entry that is not a regular file or directory, or has a hard link: ${(e as Error).message}`]);
	}
	const top = new Map(entries.filter((e) => !e.rel.includes(path.sep)).map((e) => [e.rel, e.dir]));
	const expected = new Map<string, boolean>([...NATIVE_CLIENT_FILES.map((f) => [f, false] as const), ['stage.json', false], ['artifact', true], [STAGED.migrations, true]]);
	for (const [n, isDir] of top) if (expected.get(n) !== isDir) problems.push(`${n} is not part of a native stage (${[...expected.keys()].join(', ')}): ${n === CONFIG_FILES.cf || n === '.cloudflare' ? CF_NATIVE_GAP : 'the upload would read it and the check does not'}`);
	for (const [n, isDir] of expected) if (top.get(n) !== isDir) problems.push(`${n} is missing from the stage`);
	if (problems.length) return done(problems);
	let sourceTargets: NativeTarget[];
	try {
		sourceTargets = loadNativeTargets(a.clients);
	} catch (e) {
		return done([(e as Error).message]);
	}
	const facts = nativeStageFacts(a.stage, a.client, sourceTargets, { pins: parsed.pins, reviewedClients: a.clients });
	if (facts.problems.length || !facts.record) return done([...facts.problems, ...facts.reviewProblems]);
	let written: string;
	let writtenSha: string;
	let parsedRecord: unknown;
	try {
		const bytes = readRegular(path.join(a.stage, 'stage.json'), a.stage);
		writtenSha = sha256Of(bytes);
		written = bytes.toString('utf8');
		parsedRecord = parseNativeJson(written);
	} catch (e) {
		return done([...facts.reviewProblems, `stage.json cannot be read as JSON: ${(e as Error).message}`]);
	}
	const recordProblems: string[] = [];
	if (typeof parsedRecord !== 'object' || parsedRecord === null || (parsedRecord as { schema?: unknown }).schema !== NATIVE_STAGE_SCHEMA) recordProblems.push(`stage.json is not a ${NATIVE_STAGE_SCHEMA} record (a legacy stage is not a native one)`);
	else if (written !== recordText(facts.record)) recordProblems.push('stage.json is not the record of these staged bytes: a file, digest, identity, upload or claim flag differs from what the stage holds');
	return done([...facts.reviewProblems, ...recordProblems], facts.record, writtenSha);
}

/** Every reason `argv`, run with working directory `cwd`, is not the one native upload command for the stage `stage` of `client`. It runs nothing and reads no credential or environment; an ambient WRANGLER_* or CLOUDFLARE_* variable is the caller's to scrub and is not checked here. */
export function checkNativeUploadInvocation(a: { client: string; stage: string; cwd: string; argv: readonly string[] }): string[] {
	const problems = nativeUploadInvocationProblems(a.argv);
	const root = realDirectory(a.stage, 'stage');
	if (root) return [...problems, root];
	try {
		if (realpathSync(a.cwd) !== realpathSync(a.stage)) problems.push(`the upload working directory ${a.cwd} is not the stage ${a.stage}: wrangler.jsonc and its relative paths are resolved from there`);
		const record = parseNativeJson(readRegular(path.join(a.stage, 'stage.json'), a.stage).toString('utf8'));
		if (!isObject(record) || record.schema !== NATIVE_STAGE_SCHEMA || record.client !== a.client) problems.push(`the stage is not a ${NATIVE_STAGE_SCHEMA} record for ${a.client}`);
	} catch (e) {
		problems.push((e as Error).message);
	}
	return problems;
}

const NATIVE_PIN_FLAGS = NATIVE_PIN_KEYS.map((k) => `--pin-${k}`);
/** The flags each native command reads; every other argument is a usage error, so no flag is silently ignored or able to override a check. */
const NATIVE_COMMAND_FLAGS: Record<string, string[]> = {
	check: ['--profile', '--clients', '--format', '--config'],
	stage: ['--profile', '--clients', '--artifact', '--digest', '--out'],
	prebuilt: ['--profile', '--clients', '--stage', ...NATIVE_PIN_FLAGS],
	invocation: ['--profile', '--stage', '--cwd'],
};

/** `rest` as flag/value pairs, or null: an unknown, repeated, valueless or positional argument, or a value that looks like a flag, refuses the whole command line. */
export function parseNativeArgs(command: string, rest: string[]): Map<string, string> | null {
	const allowed = NATIVE_COMMAND_FLAGS[command];
	if (!allowed || rest.length % 2) return null;
	const out = new Map<string, string>();
	for (let i = 0; i < rest.length; i += 2) {
		const [k, v] = [rest[i]!, rest[i + 1]!];
		if (!allowed.includes(k) || out.has(k) || v === '' || v.startsWith('--')) return null;
		out.set(k, v);
	}
	return out.get('--profile') === 'native' ? out : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [command, client, ...rest] = process.argv.slice(2);
	const arg = (name: string) => {
		const i = rest.indexOf(name);
		return i < 0 ? undefined : rest[i + 1];
	};
	const usage = (): never => (console.error('usage: target.ts check <client> [--format wrangler|cf --config FILE] | stage <client> --artifact DIR --digest sha256:<hex> --out DIR | prebuilt <client> --stage DIR; native (exact flags only, none repeated): check|stage|prebuilt|invocation <client> --profile native ...; prebuilt needs --clients DIR --stage DIR and --pin-target --pin-config --pin-artifact --pin-migrations --pin-entry --pin-source; invocation --stage DIR --cwd DIR -- wrangler deploy --config wrangler.jsonc'), process.exit(2));
	if (!client) usage();
	// `--profile=...` and any `--profile` value other than native are usage errors, never the legacy path.
	if (rest.some((x) => x.startsWith('--profile=')) || (rest.includes('--profile') && arg('--profile') !== 'native')) usage();
	const profile = arg('--profile');
	let problems: string[];
	try {
		if (profile === 'native') {
			const split = command === 'invocation' ? rest.indexOf('--') : -1;
			const flags = parseNativeArgs(command!, split < 0 ? rest : rest.slice(0, split));
			if (!flags || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(client!) || (command === 'invocation') !== (split >= 0)) usage();
			const need = (name: string) => flags!.get(name) ?? usage();
			if (command === 'check') {
				const clients = need('--clients');
				const dir = path.resolve(clients);
				const format = flags!.get('--format'), config = flags!.get('--config');
				if ((format !== undefined && config === undefined) || (format !== undefined && !(format in CONFIG_FILES))) usage();
				const file = config ?? path.join(dir, client!, NATIVE_CONFIG_FILE);
				const dirProblems = config === undefined ? nativeClientDirProblems(path.join(dir, client!)) : [];
				problems = dirProblems.length ? dirProblems : checkNative({ client: client!, targets: loadNativeTargets(dir), format: format as Format | undefined, text: readRegular(file, config === undefined ? dir : undefined).toString('utf8') }).map((p) => `${path.basename(file)}: ${p}`);
			} else if (command === 'stage') {
				problems = stageNative({ client: client!, artifact: path.resolve(need('--artifact')), digest: need('--digest'), out: path.resolve(need('--out')), clients: path.resolve(need('--clients')) });
			} else if (command === 'prebuilt') {
				const pins = Object.fromEntries(NATIVE_PIN_KEYS.map((k) => [k, flags!.get(`--pin-${k}`)])) as Record<keyof NativePins, string | undefined>;
				// every pin is required and well formed: a missing or malformed pin is a usage error before anything is read
				if (NATIVE_PIN_KEYS.some((k) => pins[k] === undefined) || !parseNativePins(pins).pins) usage();
				problems = checkNativeStage({ client: client!, stage: path.resolve(need('--stage')), clients: path.resolve(need('--clients')), pins: pins as NativePins });
			} else problems = checkNativeUploadInvocation({ client: client!, stage: path.resolve(need('--stage')), cwd: path.resolve(need('--cwd')), argv: rest.slice(split + 1) });
		} else if (command === 'check') {
			const format = arg('--format'), config = arg('--config');
			if ((format === undefined) !== (config === undefined) || (format !== undefined && !(format in CONFIG_FILES))) usage();
			const targets = loadTargets();
			const files: [Format, string][] = format ? [[format as Format, config!]] : (Object.keys(CONFIG_FILES) as Format[]).map((f) => [f, path.join(CLIENTS_DIR, client!, CONFIG_FILES[f])]);
			problems = files.flatMap(([f, file]) => checkTarget({ client: client!, targets, format: f, text: readFileSync(file, 'utf8') }).map((p) => `${path.basename(file)}: ${p}`));
		} else if (command === 'prebuilt') {
			const dir = arg('--stage');
			if (!dir) usage();
			problems = checkPrebuilt({ client: client!, stage: path.resolve(dir!) });
		} else if (command === 'stage') {
			const artifact = arg('--artifact'), digest = arg('--digest'), out = arg('--out');
			if (!artifact || !digest || !out) usage();
			problems = stage({ client: client!, artifact: path.resolve(artifact!), digest: digest!, out: path.resolve(out!) });
		} else problems = usage();
	} catch (e) {
		problems = [(e as Error).message];
	}
	for (const p of problems) console.error(`refused: ${p}`);
	console.log(`TARGET ${problems.length ? 'REFUSED' : 'PASS'} ${command} ${client}${profile === 'native' ? ' profile=native' : ''}`);
	process.exit(problems.length ? 1 : 0);
}
