// NATIVE24, written WITH the implementation (not part of the RED set; a missing module is not a semantic RED): the
// native final-bundle build contract (scripts/hosted-native-bundle), the immutable stage-evidence API for a separate
// binder (target.ts readNativeStage), and adversarial proof cases found while reviewing the scanner. Synthetic adapter
// output and Wrangler out directories only; Wrangler, workerd, the build, providers and credentials are never run.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { NATIVE_ADAPTER_HEADERS, uploadModuleProblems } from '../../../../deploy/native-alpha/pipeline.ts';
import { checkNativeStage, digestDir, readNativeStage, scanModule, stageNative } from '../../../../deploy/probes/target.ts';
import { assembleNativeArtifact, installedBundleVersions, nativeBundlePlan, parseBundleArgs, readNativeTargetFile } from '../../../../scripts/hosted-native-bundle/build.ts';
import { ADAPTER_ASSETSIGNORE, NATIVE_BUNDLE_ENV_KEYS, NATIVE_BUNDLE_PINS, nativeBundleVersionProblems } from '../../../../scripts/hosted-native-bundle/contract.ts';

const ROOT = path.join(import.meta.dirname, '../../../..');
const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const CLIENTS = path.join(FIXTURES, 'clients');
const ARTIFACT = path.join(FIXTURES, 'artifact');
const BUILD = path.join(ROOT, 'scripts/hosted-native-bundle/build.ts');
const SCRATCH = path.join(ROOT, '.local/hosting-probe/deployment', `native-bundle-contract-${process.pid}`);
mkdirSync(SCRATCH, { recursive: true });
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
let n = 0;
const scratch = (name: string) => path.join(SCRATCH, `${name}-${++n}`);
const sha = (b: Buffer | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const refusedWith = (problems: readonly string[], reason: RegExp | string) => expect(problems.some((p) => (typeof reason === 'string' ? p.includes(reason) : reason.test(p))), problems.join('\n') || '(no problems)').toBe(true);
const editJson = (file: string, edit: (v: Record<string, any>) => void) => {
	const v = JSON.parse(readFileSync(file, 'utf8'));
	edit(v);
	writeFileSync(file, JSON.stringify(v, null, 2));
};
const tree = (files: Record<string, string | Buffer>) => {
	const dir = scratch('tree');
	mkdirSync(dir, { recursive: true });
	for (const [rel, bytes] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		writeFileSync(path.join(dir, rel), bytes);
	}
	return dir;
};
const TARGET_FILE = path.join(CLIENTS, 'client-a/target.json');
const target = readNativeTargetFile(TARGET_FILE);
const withFlags = (flags: string[]) => ({ ...target, runtime: { ...target.runtime, compatibilityFlags: flags } });
const VERSION = `{"version":"${target.runtime.sourceSha}"}\n`;
const BUNDLE = 'var __defProp = Object.defineProperty;\nvar __name = (target, value) => __defProp(target, "name", { value, configurable: true });\nvar obfuscated_import = /* @__PURE__ */ __name((module_name) => import(module_name), "obfuscated_import");\nimport("node:async_hooks").catch(() => {});\nimport { env } from "cloudflare:workers";\nexport default { async fetch() { const c = globalThis.crypto?.subtle?.digest ? globalThis.crypto : (await obfuscated_import("node:crypto")).webcrypto; return new Response(String(env) + typeof c); } };\n';
/** A synthetic adapter-cloudflare 8.0.1 Workers output (the measured file set, synthetic bytes). */
const adapterOut = (extra: Record<string, string | Buffer> = {}) =>
	tree({ '_worker.js': "import { Server } from './../output/server/index.js';\nexport default {};\n", '.assetsignore': ADAPTER_ASSETSIGNORE, _headers: NATIVE_ADAPTER_HEADERS, '_app/version.json': VERSION, '_app/immutable/entry/start.js': 'export const start = 1;\n', 'favicon.svg': '<svg/>\n', ...extra });
const wranglerOut = (worker = BUNDLE, extra: Record<string, string> = {}) => tree({ 'README.md': 'This folder contains the built output assets for the worker.', '_worker.js': worker, '_worker.js.map': '{"version":3}', ...extra });
const COMPAT = withFlags(['nodejs_als', 'nodejs_compat']);

describe('the native bundle contract pins its toolchain and runs Wrangler build-only with an explicit environment', () => {
	test('the installed toolchain in this checkout is exactly the pinned one', () => expect(nativeBundleVersionProblems(installedBundleVersions(ROOT))).toEqual([]));
	test.each(Object.keys(NATIVE_BUNDLE_PINS))('a different %s version is refused', (k) => refusedWith(nativeBundleVersionProblems({ ...NATIVE_BUNDLE_PINS, [k]: '0.0.0' }), `${k} is "0.0.0"`));
	test('a missing pinned package is refused', () => refusedWith(nativeBundleVersionProblems({ ...NATIVE_BUNDLE_PINS, wrangler: undefined }), 'wrangler is not installed'));
	test('the plan is build-only, isolated and credential-free, whatever the caller environment holds', () => {
		const before = process.env.CLOUDFLARE_API_TOKEN;
		process.env.CLOUDFLARE_API_TOKEN = 'must-not-pass';
		try {
			const plan = nativeBundlePlan({ root: '/r', target, work: '/w' });
			expect(Object.keys(plan.env)).toEqual([...NATIVE_BUNDLE_ENV_KEYS]);
			expect(JSON.stringify(plan)).not.toContain('must-not-pass');
			expect(plan.env).toMatchObject({ HOME: '/w/home', PATH: '/usr/bin:/bin', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', WRANGLER_SEND_METRICS: 'false' });
			expect(plan.argv).toEqual(['/usr/bin/unshare', '-rn', '/bin/sh', '-c', '/usr/bin/ip link set lo up && exec "$0" "$@"', '/usr/bin/node', '/r/node_modules/wrangler/bin/wrangler.js', 'deploy', '--dry-run', '--config', '/w/bundle-only.jsonc', '--outdir', '/w/bundle']);
			expect(JSON.parse(plan.config)).toEqual({ name: 'clearcase-native-bundle-build', main: '/r/.svelte-kit/cloudflare/_worker.js', compatibility_date: target.runtime.compatibilityDate, compatibility_flags: target.runtime.compatibilityFlags, send_metrics: false, minify: false });
		} finally {
			if (before === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
			else process.env.CLOUDFLARE_API_TOKEN = before;
		}
	});
	test('the CLI takes exact flags only', () => {
		expect(parseBundleArgs(['plan', '--root', '/r', '--target', '/t', '--work', '/w'])).not.toBeNull();
		for (const argv of [['plan', '--root', '/r', '--target', '/t'], ['plan', '--root', '/r', '--target', '/t', '--work', '/w', '--env', 'x'], ['plan', '--root', '/r', '--root', '/r', '--work', '/w'], ['deploy', '--root', '/r'], ['plan', '--root', '--target', '--work', '/w', '/x', '/y']]) expect(parseBundleArgs(argv), argv.join(' ')).toBeNull();
		const r = spawnSync(process.execPath, [BUILD, 'plan', '--root', ROOT, '--target', TARGET_FILE, '--work', '/w', '--dry-run', 'no'], { encoding: 'utf8' });
		expect(r.status).toBe(2);
	});
});

describe('assemble copies the bundle unchanged beside the public assets, then checks the artifact', () => {
	test('a measured-shape bundle under nodejs_compat assembles, stages and passes prebuilt', () => {
		const out = scratch('artifact');
		const bundle = wranglerOut();
		const r = assembleNativeArtifact({ adapter: adapterOut(), bundle, out, target: COMPAT });
		expect(r.problems).toEqual([]);
		expect(readFileSync(path.join(out, 'cloudflare/_worker.js'))).toEqual(readFileSync(path.join(bundle, '_worker.js')));
		expect(existsSync(path.join(out, 'public/_worker.js')) || existsSync(path.join(out, 'public/.assetsignore')) || existsSync(path.join(out, 'cloudflare/_worker.js.map'))).toBe(false);
		expect(r.record).toMatchObject({ schema: 'clearcase.native-bundle/1', artifact: digestDir(out), state: 'BUILT-UNVERIFIED', staged: false, providerProof: false, deployed: false, inputs: { bundle: sha(BUNDLE), bundleMap: sha('{"version":3}') } });
		expect(r.record!.upload.assets.headers).toMatchObject({ path: 'artifact/public/_headers', sha256: sha(NATIVE_ADAPTER_HEADERS) });
		expect(r.record!.upload.dynamicHostImports).toEqual([
			{ specifier: 'node:async_hooks', via: 'literal', sites: 1 },
			{ specifier: 'node:crypto', via: 'forwarder obfuscated_import', sites: 1 },
		]);
		const clients = scratch('clients');
		cpSync(CLIENTS, clients, { recursive: true });
		editJson(path.join(clients, 'client-a/target.json'), (t) => ((t.runtime.artifactSha256 = digestDir(out)), (t.runtime.compatibilityFlags = ['nodejs_als', 'nodejs_compat'])));
		const cfg = path.join(clients, 'client-a/wrangler.jsonc');
		writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('"compatibility_flags": ["nodejs_als"]', '"compatibility_flags": ["nodejs_als", "nodejs_compat"]'));
		const stage = scratch('stage');
		expect(stageNative({ client: 'client-a', artifact: out, digest: digestDir(out), out: stage, clients })).toEqual([]);
		const t = JSON.parse(readFileSync(path.join(clients, 'client-a/target.json'), 'utf8'));
		const pins = { target: sha(readFileSync(path.join(clients, 'client-a/target.json'))), config: sha(readFileSync(cfg)), artifact: digestDir(out), migrations: t.runtime.migrationsSha256, entry: sha(BUNDLE), source: t.runtime.sourceSha };
		expect(checkNativeStage({ client: 'client-a', stage, clients, pins })).toEqual([]);
	});
	const refusedAssemble = (a: { adapter?: string; bundle?: string; flags?: string[] }, reason: RegExp | string) => {
		const out = scratch('artifact');
		refusedWith(assembleNativeArtifact({ adapter: a.adapter ?? adapterOut(), bundle: a.bundle ?? wranglerOut(), out, target: a.flags ? withFlags(a.flags) : COMPAT }).problems, reason);
		expect(existsSync(out)).toBe(false);
	};
	test('the same bundle under nodejs_als only is refused for node:crypto and nothing is left behind', () => refusedAssemble({ flags: ['nodejs_als'] }, /node:crypto.*nodejs_compat/));
	test('an empty adapter .assetsignore is refused', () => refusedAssemble({ adapter: adapterOut({ '.assetsignore': '' }) }, /\.assetsignore is not exactly adapter-cloudflare 8\.0\.1's/));
	test('an adapter .assetsignore with another pattern is refused', () => refusedAssemble({ adapter: adapterOut({ '.assetsignore': `${ADAPTER_ASSETSIGNORE}\nsecret.txt` }) }, /\.assetsignore is not exactly/));
	test('an adapter output without its .assetsignore is refused', () => {
		const adapter = adapterOut();
		rmSync(path.join(adapter, '.assetsignore'));
		refusedAssemble({ adapter }, /has no \.assetsignore/);
	});
	test.each(['_redirects', '_routes.json'])('an adapter %s is refused, never dropped', (f) => refusedAssemble({ adapter: adapterOut({ [f]: 'x' }) }, `holds ${f}`));
	test('an adapter _headers with an extra rule is refused by the public-asset policy', () => refusedAssemble({ adapter: adapterOut({ _headers: `${NATIVE_ADAPTER_HEADERS}\n/*\n  Access-Control-Allow-Origin: *` }) }, /_headers is not the exact adapter-cloudflare 8\.0\.1 header rules/));
	test('an adapter source map is refused as a public asset', () => refusedAssemble({ adapter: adapterOut({ '_app/immutable/entry/start.js.map': '{}' }) }, /source map/));
	test('a Wrangler out directory with a second module is refused', () => refusedAssemble({ bundle: wranglerOut(BUNDLE, { 'chunk-1.js': 'export {}' }) }, /not exactly \["README\.md","_worker\.js","_worker\.js\.map"\]/));
	test('a Wrangler out directory without the source map is refused', () => {
		const bundle = wranglerOut();
		rmSync(path.join(bundle, '_worker.js.map'));
		refusedAssemble({ bundle }, /not exactly/);
	});
	test('a bundle with a dynamic import of node:fs is refused', () => refusedAssemble({ bundle: wranglerOut('export default { async fetch() { await import("node:fs"); return new Response("x"); } };\n') }, /dynamic import of "node:fs"/));
	test('a symlink in the adapter output is refused', () => {
		const adapter = adapterOut();
		symlinkSync('/etc/hostname', path.join(adapter, 'leak.txt'));
		refusedAssemble({ adapter }, /not a regular file or directory/);
	});
	test('an existing output directory is refused and left alone', () => {
		const out = scratch('exists');
		mkdirSync(out);
		writeFileSync(path.join(out, 'keep'), 'x');
		refusedWith(assembleNativeArtifact({ adapter: adapterOut(), bundle: wranglerOut(), out, target: COMPAT }).problems, /exists/);
		expect(readFileSync(path.join(out, 'keep'), 'utf8')).toBe('x');
	});
	test('verify through the CLI passes the separated fixture artifact', () => {
		const ok = spawnSync(process.execPath, [BUILD, 'verify', '--artifact', ARTIFACT, '--target', TARGET_FILE], { encoding: 'utf8' });
		expect({ status: ok.status, stderr: ok.stderr }).toEqual({ status: 0, stderr: 'NATIVE BUNDLE PASS verify\n' });
	});
});

describe('readNativeStage: an immutable reading for a separate binder', () => {
	const sha256 = (f: string) => sha(readFileSync(f));
	const PINS = { target: sha256(path.join(CLIENTS, 'client-a/target.json')), config: sha256(path.join(CLIENTS, 'client-a/wrangler.jsonc')), artifact: digestDir(ARTIFACT), migrations: target.runtime.migrationsSha256, entry: sha256(path.join(ARTIFACT, 'cloudflare/_worker.js')), source: target.runtime.sourceSha };
	const stage = () => {
		const out = scratch('stage');
		expect(stageNative({ client: 'client-a', artifact: ARTIFACT, digest: digestDir(ARTIFACT), out, clients: CLIENTS })).toEqual([]);
		return out;
	};
	test('a verified stage yields the recomputed record (equal to stage.json), the judged file hashes and the pins, all frozen', () => {
		const out = stage();
		const r = readNativeStage({ client: 'client-a', stage: out, clients: CLIENTS, pins: PINS });
		expect(r.problems).toEqual([]);
		expect(r.checker).toBe('checkNativeStage');
		expect(r.record).toEqual(JSON.parse(readFileSync(path.join(out, 'stage.json'), 'utf8')));
		expect(r.files).toEqual({ stageJson: sha256(path.join(out, 'stage.json')), targetJson: PINS.target, configJsonc: PINS.config });
		expect(r.pins).toEqual(PINS);
		expect(Object.isFrozen(r) && Object.isFrozen(r.record) && Object.isFrozen(r.record!.upload.assets.files) && Object.isFrozen(r.pins)).toBe(true);
		expect(r.record).toMatchObject({ state: 'STAGED-UNVERIFIED', fundedAdmission: false, controlsProof: false, providerProof: false, deployed: false });
	});
	test('a tampered stage yields problems and no record or hashes', () => {
		const out = stage();
		editJson(path.join(out, 'stage.json'), (s) => (s.providerProof = true));
		const r = readNativeStage({ client: 'client-a', stage: out, clients: CLIENTS, pins: PINS });
		refusedWith(r.problems, /stage\.json is not the record/);
		expect({ record: r.record, files: r.files }).toEqual({ record: null, files: null });
	});
	test('no pins yields problems, null pins and no record', () => {
		const r = readNativeStage({ client: 'client-a', stage: stage(), clients: CLIENTS });
		refusedWith(r.problems, /pins/);
		expect({ pins: r.pins, record: r.record }).toEqual({ pins: null, record: null });
	});
	test('a wrong pin yields no record', () => expect(readNativeStage({ client: 'client-a', stage: stage(), clients: CLIENTS, pins: { ...PINS, entry: sha('other') } }).record).toBeNull());
});

const fwd = (body: string) => `var __defProp = Object.defineProperty;\nvar __name = (target, value) => __defProp(target, "name", { value, configurable: true });\nvar fwd = /* @__PURE__ */ __name((m) => import(m), "fwd");\n${body}\nexport default {};\n`;
describe('the public .assetsignore refusal names its own reason (not only the dotfile rule)', () => {
	test('an empty public .assetsignore is refused because it silences Wrangler\'s own guard', async () => {
		const { nativeArtifactLayout } = await import('../../../../deploy/native-alpha/pipeline.ts');
		const f = (p: string) => ({ path: p, bytes: 1, sha256: sha(p) });
		refusedWith(nativeArtifactLayout({ files: [f('artifact/cloudflare/_worker.js'), f('artifact/public/a.txt'), f('artifact/public/.assetsignore')], entrySha256: sha('entry'), headersText: null }).problems, /silences Wrangler's own _worker\.js guard/);
	});
});

describe('more adversarial forwarder cases (found while reviewing the proof)', () => {
	const problems = (w: string) => uploadModuleProblems(scanModule(w), 'artifact/cloudflare/_worker.js', ['nodejs_als', 'nodejs_compat']);
	test('the honest forwarder passes', () => expect(problems(fwd('fwd("node:crypto");'))).toEqual([]));
	test.each([
		['a direct eval that could read the forwarder', fwd('eval("fwd");'), /names eval/],
		['a write to Object.defineProperty', fwd('Object.defineProperty = (t) => t;'), /defineProperty or Object property is written/],
		['an exported forwarder declaration', 'var __defProp = Object.defineProperty;\nvar __name = (target, value) => __defProp(target, "name", { value, configurable: true });\nexport var fwd = __name((m) => import(m), "fwd");\nfwd("node:crypto");\n', /exported/],
		['a function declaration with the forwarder name', fwd('function fwd2() {}\nfunction fwd() {}'), /declared 2 times/],
		['a catch binding with the forwarder name', fwd('try {} catch (fwd) { fwd("node:crypto"); }'), /declared 2 times/],
		['a tagged template call', fwd('fwd`node:crypto`;'), /other than as a direct call/],
		['a new expression', fwd('new fwd("node:crypto");'), /other than as a direct call/],
		['a sequence-expression call', fwd('(0, fwd)("node:crypto");'), /other than as a direct call/],
		['a spread argument', fwd('fwd(...["node:crypto"]);'), /other than as a direct call/],
		['a second string argument', fwd('fwd("node:crypto", "x");'), /other than as a direct call/],
		['a destructuring write to Object', fwd('[Object] = [{}];'), /Object is declared or written/],
		['a write to globalThis.Object', fwd('globalThis.Object = { defineProperty: (t) => t };'), /Object property is written/],
		['an element write to defineProperty', fwd('Object["defineProperty"] = (t) => t;'), /defineProperty or Object property is written/],
		['an async forwarder', 'var fwd = async (m) => import(m);\nfwd("node:crypto");\nexport default {};\n', /exactly one plain parameter/],
		['a keep-names helper with a third property', 'var __defProp = Object.defineProperty;\nvar __name = (target, value) => __defProp(target, "name", { value, configurable: true, get: () => target });\nvar fwd = __name((m) => import(m), "fwd");\nfwd("node:crypto");\n', /keep-names helper/],
		['a static node:async_hooks import with no flag', 'import { AsyncLocalStorage } from "node:async_hooks";\nexport default { fetch() { return new Response(String(AsyncLocalStorage)); } };\n', null],
	])('%s is refused', (_what, worker, reason) => {
		if (reason === null) refusedWith(uploadModuleProblems(scanModule(worker), 'artifact/cloudflare/_worker.js', []), /node:async_hooks.*needs one of nodejs_als, nodejs_compat/);
		else refusedWith(problems(worker), reason);
	});
	test('a no_nodejs_compat flag disables node:crypto even beside nodejs_compat', () => refusedWith(uploadModuleProblems(scanModule(fwd('fwd("node:crypto");')), 'e', ['nodejs_compat', 'no_nodejs_compat']), /node:crypto/));
});
