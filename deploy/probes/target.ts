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
// checks both configs and digests the artifact there: the check and `stage.json` read the staged copy, not the source.
// The digest covers regular files and directories only: a symlink, device, socket or FIFO anywhere in the artifact or
// the migrations, or as either root, is refused. `prebuilt` checks the Build Output a credential-free `cf build` wrote in
// that stage, because `cf deploy --prebuilt` uploads its bindings, not the cf config's, and refuses any file in it that the check does not read. Exit 0 PASS, 1 refused, 2 usage.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
	const owner = new Map<string, string>();
	for (const t of targets)
		for (const [kind, values] of Object.entries(identifiers(t)))
			for (const v of values) {
				const prior = owner.get(v);
				if (prior && prior !== t.client) throw new Error(`${kind} ${v} is in both ${prior}'s and ${t.client}'s targets`);
				owner.set(v, t.client);
			}
	if (!targets.length) throw new Error(`${dir}: no client targets`);
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
	const targets = loadTargets(a.clients);
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [command, client, ...rest] = process.argv.slice(2);
	const arg = (name: string) => {
		const i = rest.indexOf(name);
		return i < 0 ? undefined : rest[i + 1];
	};
	const usage = (): never => (console.error('usage: target.ts check <client> [--format wrangler|cf --config FILE] | stage <client> --artifact DIR --digest sha256:<hex> --out DIR | prebuilt <client> --stage DIR'), process.exit(2));
	if (!client) usage();
	let problems: string[];
	try {
		if (command === 'check') {
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
	console.log(`TARGET ${problems.length ? 'REFUSED' : 'PASS'} ${command} ${client}`);
	process.exit(problems.length ? 1 : 0);
}
