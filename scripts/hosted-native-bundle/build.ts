// The native final-bundle build (NATIVE24), run by the parent only, after a credential-free production `build:hosted`
// at an exact clean SHA. See contract.ts for the measured protocol and docs/acceptance/hosting/native-alpha-pipeline.md.
//
//   bun scripts/hosted-native-bundle/build.ts plan     --root DIR --target FILE --work DIR   (prints the exact plan; runs nothing)
//   bun scripts/hosted-native-bundle/build.ts bundle   --root DIR --target FILE --work DIR   (PARENT ONLY: Wrangler --dry-run, then assemble)
//   bun scripts/hosted-native-bundle/build.ts assemble --adapter DIR --bundle DIR --out DIR --target FILE
//   bun scripts/hosted-native-bundle/build.ts verify   --artifact DIR --target FILE
//
// `--target` is the reviewed native target.json; only its compatibility date and flags are read here. `assemble` copies
// the bundle's _worker.js unchanged to artifact/cloudflare/ and only proven browser/static files to artifact/public/, then runs
// target.ts `checkNativeArtifact` on the result and removes it on any refusal. Exit 0 PASS, 1 refused, 2 usage.
// Evidence: a PASS is a local build/structure check of one artifact, never a stage, upload, provider or deploy proof.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_STAGED, nativeArtifactLayout, parseNativeJson, parseNativeTarget, type NativeTarget, type NativeUpload, type UploadFile } from '../../deploy/native-alpha/pipeline.ts';
import { checkNativeArtifact, nativeWalk, readRegular } from '../../deploy/probes/target.ts';
import {
	ADAPTER_ASSETSIGNORE,
	ADAPTER_ASSETSIGNORE_FILE,
	ADAPTER_REFUSED,
	ADAPTER_WORKER,
	NATIVE_BUNDLE_OUTDIR,
	NATIVE_BUNDLE_PACKAGES,
	NATIVE_BUNDLE_PINS,
	NATIVE_BUNDLE_SCHEMA,
	nativeBundleArgv,
	nativeBundleConfig,
	nativeBundleEnv,
	nativeBundleLayout,
	nativeBundleVersionProblems,
} from './contract.ts';

const sha256Of = (b: Buffer | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const ENTRY_REL = path.posix.relative('artifact', NATIVE_STAGED.entry); // cloudflare/_worker.js
const PUBLIC_REL = path.posix.relative('artifact', NATIVE_STAGED.assets); // public

/** The reviewed native target at `file`, strictly parsed and bound to the approved native scope. */
export function readNativeTargetFile(file: string): NativeTarget {
	return parseNativeTarget(parseNativeJson(readRegular(file).toString('utf8')), file);
}

/** The installed versions of the pinned packages under `root` (esbuild as Wrangler resolves it). */
export function installedBundleVersions(root: string): Record<string, string | undefined> {
	const req = createRequire(path.join(root, 'package.json'));
	const version = (resolve: () => string) => {
		try {
			return (JSON.parse(readFileSync(resolve(), 'utf8')) as { version?: string }).version;
		} catch {
			return undefined;
		}
	};
	const found: Record<string, string | undefined> = {};
	for (const k of NATIVE_BUNDLE_PACKAGES) found[k] = k === 'esbuild' ? version(() => createRequire(req.resolve('wrangler/package.json')).resolve('esbuild/package.json')) : version(() => req.resolve(`${k}/package.json`));
	return found;
}

export type NativeBundleRecord = {
	schema: typeof NATIVE_BUNDLE_SCHEMA;
	pins: typeof NATIVE_BUNDLE_PINS;
	compatibility: { date: string; flags: string[] };
	inputs: { adapterWorker: string; adapterAssetsignore: string; bundle: string; bundleMap: string; bundleReadme: string; clientAssets: string };
	artifact: string;
	upload: NativeUpload;
	state: 'BUILT-UNVERIFIED';
	staged: false;
	providerProof: false;
	deployed: false;
};

/** Read-only positive provenance over a complete build tree, before creating any artifact.
 * output/client is Kit's browser/static build input to builder.writeClient, not the adapter output directory.
 * Every public adapter file must match its client input by path AND bytes; the final entry's used manifest/graph
 * must also account for it. Headers remain the exact pinned adapter policy. Nothing evaluates JavaScript.
 */
export function checkNativePublicBuild(a: { adapter: string; bundle: string }): { problems: string[]; clientAssets?: string } {
	try {
		const client = path.join(path.dirname(a.adapter), 'output/client');
		const clientFiles = new Map(nativeWalk(client).filter(e => !e.dir).map(e => [e.rel.split(path.sep).join('/'), readRegular(path.join(client, e.rel), client)]));
		const entry = readRegular(path.join(a.bundle, ADAPTER_WORKER), a.bundle);
		const bytes = new Map<string, Buffer>();
		const files: UploadFile[] = [{ path: NATIVE_STAGED.entry, bytes: entry.length, sha256: sha256Of(entry) }];
		const problems: string[] = [];
		for (const e of nativeWalk(a.adapter)) {
			const rel = e.rel.split(path.sep).join('/');
			if (e.dir || rel === ADAPTER_WORKER || rel === ADAPTER_ASSETSIGNORE_FILE) continue;
			const b = readRegular(path.join(a.adapter, e.rel), a.adapter);
			const at = `${NATIVE_STAGED.assets}/${rel}`;
			bytes.set(at, b); files.push({ path: at, bytes: b.length, sha256: sha256Of(b) });
			if (rel !== '_headers' && !clientFiles.get(rel)?.equals(b)) problems.push(`${at}: no byte-matching provenance in the trusted Kit output/client build input`);
		}
		problems.push(...nativeArtifactLayout({ files, entrySha256: sha256Of(entry), headersText: bytes.get(`${NATIVE_STAGED.assets}/_headers`)?.toString('utf8') ?? null, entryText: new TextDecoder('utf-8', {fatal:true}).decode(entry), publicFiles: bytes }).problems);
		const bindings = [...clientFiles].map(([rel,b]) => ({path:rel,bytes:b.length,sha256:sha256Of(b)})).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
		return { problems, clientAssets: sha256Of(JSON.stringify(bindings)) };
	} catch (e) { return { problems: [(e as Error).message] }; }
}

/**
 * Builds the native artifact at `out` (which must not exist) from the adapter output `adapter` and Wrangler's build-only
 * out directory `bundle`, then checks it with target.ts `checkNativeArtifact` under the target's flags. Nothing is
 * rewritten: the bundle's _worker.js bytes are copied as they are. Only files with positive manifest/browser-graph
 * provenance AND byte-matching trusted output/client inputs go to public/ unchanged (plus the exact adapter headers).
 * `_redirects`/`_routes.json` are refused rather than dropped. A refusal
 * removes `out`.
 */
export function assembleNativeArtifact(a: { adapter: string; bundle: string; out: string; target: NativeTarget }): { problems: string[]; record?: NativeBundleRecord } {
	if (existsSync(a.out)) return { problems: [`${a.out} exists; an artifact starts empty`] };
	let adapterEntries: { rel: string; dir: boolean }[], bundleEntries: { rel: string; dir: boolean }[];
	try {
		adapterEntries = nativeWalk(a.adapter);
		bundleEntries = nativeWalk(a.bundle);
	} catch (e) {
		return { problems: [(e as Error).message] };
	}
	const problems: string[] = [];
	const bundleNames = bundleEntries.map((e) => (e.dir ? `${e.rel}/` : e.rel));
	if (JSON.stringify(bundleNames) !== JSON.stringify([...NATIVE_BUNDLE_OUTDIR])) problems.push(`the Wrangler out directory holds ${JSON.stringify(bundleNames)}, not exactly ${JSON.stringify(NATIVE_BUNDLE_OUTDIR)}: no_bundle uploads one module, so a chunk, wasm or second module is refused`);
	const adapterFiles = new Set(adapterEntries.filter((e) => !e.dir).map((e) => e.rel.split(path.sep).join('/')));
	if (!adapterFiles.has(ADAPTER_WORKER)) problems.push(`the adapter output has no ${ADAPTER_WORKER}: it is not an adapter-cloudflare Workers build`);
	if (!adapterFiles.has(ADAPTER_ASSETSIGNORE_FILE)) problems.push(`the adapter output has no ${ADAPTER_ASSETSIGNORE_FILE}: it is not an adapter-cloudflare 8.0.1 Workers build`);
	for (const f of ADAPTER_REFUSED) if (adapterFiles.has(f)) problems.push(`the adapter output holds ${f}: the native profile does not carry it, and it is refused rather than dropped`);
	if (problems.length) return { problems };
	const read = (dir: string, rel: string) => readRegular(path.join(dir, rel), dir);
	let inputs: NativeBundleRecord['inputs'];
	try {
		const ignore = read(a.adapter, ADAPTER_ASSETSIGNORE_FILE);
		if (ignore.toString('utf8') !== ADAPTER_ASSETSIGNORE) return { problems: [`the adapter output's ${ADAPTER_ASSETSIGNORE_FILE} is not exactly adapter-cloudflare 8.0.1's (${JSON.stringify(ADAPTER_ASSETSIGNORE)}): it is not the measured adapter output`] };
		const provenance = checkNativePublicBuild(a);
		if (provenance.problems.length || !provenance.clientAssets) return { problems: provenance.problems };
		inputs = { adapterWorker: sha256Of(read(a.adapter, ADAPTER_WORKER)), adapterAssetsignore: sha256Of(ignore), bundle: sha256Of(read(a.bundle, '_worker.js')), bundleMap: sha256Of(read(a.bundle, '_worker.js.map')), bundleReadme: sha256Of(read(a.bundle, 'README.md')), clientAssets: provenance.clientAssets };
		mkdirSync(a.out);
		mkdirSync(path.join(a.out, path.posix.dirname(ENTRY_REL)));
		writeFileSync(path.join(a.out, ENTRY_REL), read(a.bundle, '_worker.js'), { flag: 'wx', mode: 0o644 });
		mkdirSync(path.join(a.out, PUBLIC_REL));
		for (const e of adapterEntries) {
			const rel = e.rel.split(path.sep).join('/');
			if (rel === ADAPTER_WORKER || rel === ADAPTER_ASSETSIGNORE_FILE) continue;
			const dst = path.join(a.out, PUBLIC_REL, e.rel);
			if (e.dir) mkdirSync(dst);
			else writeFileSync(dst, read(a.adapter, e.rel), { flag: 'wx', mode: 0o644 });
		}
	} catch (e) {
		rmSync(a.out, { recursive: true, force: true });
		return { problems: [(e as Error).message] };
	}
	const checked = checkNativeArtifact({ artifact: a.out, compatibilityFlags: a.target.runtime.compatibilityFlags });
	if (checked.problems.length || !checked.upload || !checked.digest) {
		rmSync(a.out, { recursive: true, force: true });
		return { problems: checked.problems.length ? checked.problems : ['the assembled artifact could not be judged'] };
	}
	return {
		problems: [],
		record: { schema: NATIVE_BUNDLE_SCHEMA, pins: NATIVE_BUNDLE_PINS, compatibility: { date: a.target.runtime.compatibilityDate, flags: [...a.target.runtime.compatibilityFlags] }, inputs, artifact: checked.digest, upload: checked.upload, state: 'BUILT-UNVERIFIED', staged: false, providerProof: false, deployed: false },
	};
}

/** The exact plan `bundle` runs: argv, environment and build-only config. Reads nothing but the target. */
export function nativeBundlePlan(a: { root: string; target: NativeTarget; work: string }) {
	const wrangler = path.join(a.root, 'node_modules/wrangler/bin/wrangler.js');
	return {
		argv: nativeBundleArgv({ wrangler, work: a.work }),
		env: nativeBundleEnv(a.work),
		config: nativeBundleConfig({ main: path.join(a.root, '.svelte-kit/cloudflare', ADAPTER_WORKER), compatibilityDate: a.target.runtime.compatibilityDate, compatibilityFlags: a.target.runtime.compatibilityFlags }),
		layout: nativeBundleLayout(a.work),
		adapter: path.join(a.root, '.svelte-kit/cloudflare'),
	};
}

const COMMANDS: Record<string, string[]> = { plan: ['--root', '--target', '--work'], bundle: ['--root', '--target', '--work'], assemble: ['--adapter', '--bundle', '--out', '--target'], verify: ['--artifact', '--target'] };
/** Exact flags only: every flag of the command once, nothing else. */
export function parseBundleArgs(argv: string[]): { command: string; flags: Map<string, string> } | null {
	const [command, ...rest] = argv;
	const allowed = command ? COMMANDS[command] : undefined;
	if (!allowed || rest.length !== allowed.length * 2) return null;
	const flags = new Map<string, string>();
	for (let i = 0; i < rest.length; i += 2) {
		const [k, v] = [rest[i]!, rest[i + 1]!];
		if (!allowed.includes(k) || flags.has(k) || v === '' || v.startsWith('--')) return null;
		flags.set(k, path.resolve(v));
	}
	return { command: command!, flags };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const parsed = parseBundleArgs(process.argv.slice(2));
	if (!parsed) {
		console.error('usage: build.ts plan|bundle --root DIR --target FILE --work DIR | assemble --adapter DIR --bundle DIR --out DIR --target FILE | verify --artifact DIR --target FILE');
		process.exit(2);
	}
	const f = (k: string) => parsed.flags.get(k)!;
	let problems: string[] = [];
	try {
		const target = readNativeTargetFile(f('--target'));
		if (parsed.command === 'plan') console.log(JSON.stringify(nativeBundlePlan({ root: f('--root'), target, work: f('--work') }), null, 2));
		else if (parsed.command === 'verify') problems = checkNativeArtifact({ artifact: f('--artifact'), compatibilityFlags: target.runtime.compatibilityFlags }).problems;
		else if (parsed.command === 'assemble') {
			const r = assembleNativeArtifact({ adapter: f('--adapter'), bundle: f('--bundle'), out: f('--out'), target });
			problems = r.problems;
			if (r.record) console.log(JSON.stringify(r.record, null, 2));
		} else {
			// PARENT ONLY. Credential-free and build-only: --dry-run, explicit environment, no network namespace.
			const plan = nativeBundlePlan({ root: f('--root'), target, work: f('--work') });
			problems = nativeBundleVersionProblems(installedBundleVersions(f('--root')));
			if (existsSync(f('--work'))) problems.push(`${f('--work')} exists; a bundle work directory starts empty`);
			if (!problems.length) {
				for (const d of [plan.layout.home, plan.layout.cache, plan.layout.config, plan.layout.tmp]) mkdirSync(d, { recursive: true });
				writeFileSync(plan.layout.configFile, plan.config, { flag: 'wx' });
				const run = spawnSync(plan.argv[0]!, plan.argv.slice(1), { env: plan.env, cwd: f('--work'), stdio: 'inherit' });
				if (run.status !== 0) problems.push(`the build-only Wrangler run exited ${run.status ?? run.signal}`);
				else {
					const r = assembleNativeArtifact({ adapter: plan.adapter, bundle: plan.layout.outdir, out: plan.layout.artifact, target });
					problems = r.problems;
					if (r.record) writeFileSync(plan.layout.record, `${JSON.stringify(r.record, null, 2)}\n`, { flag: 'wx' });
				}
			}
		}
	} catch (e) {
		problems = [(e as Error).message];
	}
	for (const p of problems) console.error(`refused: ${p}`);
	console.error(`NATIVE BUNDLE ${problems.length ? 'REFUSED' : 'PASS'} ${parsed.command}`);
	process.exit(problems.length ? 1 : 0);
}
