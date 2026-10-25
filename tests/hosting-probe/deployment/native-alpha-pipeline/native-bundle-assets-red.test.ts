// NATIVE24 bundle/assets finish: RED first, written against f8d2b7b3 through the EXISTING exported functions and CLI
// (stageNative, checkNativeStage, scanModule, uploadModuleProblems), so every RED failure is an assertion about behaviour
// and never a missing export. Two findings:
//
//  1. The real framework final bundle (measured: Wrangler 4.151.1 bundle d1a6ce…, read-only diagnosis 223934Z) holds
//     two literal `import("node:async_hooks")` (SvelteKit event.js, Svelte render-context.js) and one computed
//     `import(module_name)` inside Svelte's `obfuscated_import`, called only as `obfuscated_import("node:crypto")` in a
//     WebCrypto fallback. The checker refuses every dynamic import, so the real bundle can never pass; it must accept
//     ONLY host-runtime modules the target's compatibility flags enable, proven literal directly or through a strict
//     dataflow proof of the forwarding wrapper, and still refuse every unknown, escaping or user-derived specifier.
//  2. Public assets (L1): the native config uploads `artifact/cloudflare` as the public assets directory, which also
//     holds the server entry; an empty .assetsignore, a `_redirects`, an arbitrary `_headers`, a source map or a renamed
//     copy of the server bundle is uploaded or applied unchecked.
//
// The bundles here are synthetic: a hand reproduction of the measured esbuild shape (framework code only, no case
// content) and real Svelte/SvelteKit framework sources compiled by Wrangler's own pinned esbuild with Wrangler's
// keepNames. Unit level: no Wrangler run, no workerd, no build, no provider, no credential and no network.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { uploadModuleProblems } from '../../../../deploy/native-alpha/pipeline.ts';
import { checkNativeStage, digestDir, scanModule, stageNative } from '../../../../deploy/probes/target.ts';

import { KIT_CLIENT_FILES, KIT_SERVER, KIT_WORKER } from './fixtures/kit.ts';

const ROOT = path.join(import.meta.dirname, '../../../..');
const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const CLIENTS = path.join(FIXTURES, 'clients');
const SCRATCH = path.join(ROOT, '.local/hosting-probe/deployment', `native-bundle-assets-red-${process.pid}`);
mkdirSync(SCRATCH, { recursive: true });
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

let n = 0;
const scratch = (name: string) => path.join(SCRATCH, `${name}-${++n}`);
const sha = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const refusedWith = (problems: string[], reason: RegExp | string) => expect(problems.some((p) => (typeof reason === 'string' ? p.includes(reason) : reason.test(p))), problems.join('\n') || '(no problems)').toBe(true);
const editJson = (file: string, edit: (v: Record<string, any>) => void) => {
	const v = JSON.parse(readFileSync(file, 'utf8'));
	edit(v);
	writeFileSync(file, JSON.stringify(v, null, 2));
};
const SOURCE = JSON.parse(readFileSync(path.join(CLIENTS, 'client-a/target.json'), 'utf8')).runtime.sourceSha as string;
const VERSION = `{"version":"${SOURCE}"}\n`;
const ALS = ['nodejs_als'];
const COMPAT = ['nodejs_als', 'nodejs_compat'];

/** An artifact tree from `files` (relative path -> bytes). */
const makeArtifact = (files: Record<string, string | Buffer>) => {
	const dir = scratch('artifact');
	for (const [rel, bytes] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		writeFileSync(path.join(dir, rel), bytes);
	}
	return dir;
};
/** The separated native layout: the server entry alone in artifact/cloudflare, the public assets alone in artifact/public. */
const separated = (worker: string, publicFiles: Record<string, string | Buffer> = {}) => makeArtifact({ 'cloudflare/_worker.js': worker, 'public/_app/version.json': VERSION, ...Object.fromEntries(Object.entries(KIT_CLIENT_FILES).map(([k, v]) => [`public/${k}`, v])), ...Object.fromEntries(Object.entries(publicFiles).map(([k, v]) => [`public/${k}`, v])) });
/** The old layout the fixtures used: entry and public assets in one directory that is uploaded as assets. */
const combined = (worker: string, extra: Record<string, string | Buffer> = {}) => makeArtifact({ 'cloudflare/_worker.js': worker, 'cloudflare/_app/version.json': VERSION, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`cloudflare/${k}`, v])) });
/** Reviewed clients whose client-a target names `artifact`'s digest and `flags`, and whose config names `assetsDir` and `flags`. */
const clientsFor = (artifact: string, a: { flags?: string[]; assetsDir?: string } = {}) => {
	const dir = scratch('clients');
	cpSync(CLIENTS, dir, { recursive: true });
	const flags = a.flags ?? ALS;
	editJson(path.join(dir, 'client-a/target.json'), (t) => ((t.runtime.artifactSha256 = digestDir(artifact)), (t.runtime.compatibilityFlags = flags)));
	const cfg = path.join(dir, 'client-a/wrangler.jsonc');
	writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/"compatibility_flags": \[[^\]]*\]/, `"compatibility_flags": ${JSON.stringify(flags)}`).replace(/"directory": "[^"]*"/, `"directory": "${a.assetsDir ?? 'artifact/public'}"`));
	return dir;
};
const stageWith = (artifact: string, clients: string) => {
	const out = scratch('stage');
	return { out, problems: stageNative({ client: 'client-a', artifact, digest: digestDir(artifact), out, clients }) };
};
const pinsFor = (clients: string, artifact: string, entry: string) => {
	const t = JSON.parse(readFileSync(path.join(clients, 'client-a/target.json'), 'utf8'));
	return { target: sha(readFileSync(path.join(clients, 'client-a/target.json'))), config: sha(readFileSync(path.join(clients, 'client-a/wrangler.jsonc'))), artifact: digestDir(artifact), migrations: t.runtime.migrationsSha256, entry: sha(readFileSync(path.join(artifact, entry))), source: t.runtime.sourceSha };
};
const facts = (worker: string) => scanModule(worker);
/** uploadModuleProblems with the target's compatibility flags (a third argument the base ignores). */
const moduleProblems = (worker: string, flags?: string[]) => (uploadModuleProblems as (...a: unknown[]) => string[])(facts(worker), 'artifact/cloudflare/_worker.js', flags);

// The measured final-bundle shape, reproduced by hand from the read-only AST diagnosis of d1a6ce… (esbuild helpers,
// lazy __esm initialisers, a module-scope `var` assigned inside an initialiser through keepNames' __name). Framework
// code only.
const MEASURED = (extra = '') => `${KIT_SERVER}var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var sync_store, als;
var init_event = __esm({
  "../../node_modules/@sveltejs/kit/src/exports/internal/server/event.js"() {
    sync_store = null;
    import("node:async_hooks").then((hooks2) => als = new hooks2.AsyncLocalStorage()).catch(() => {
    });
  }
});
function noop2() {}
function init_render_context() {
  als_import ??= import("node:async_hooks").then((hooks2) => {
    als2 = new hooks2.AsyncLocalStorage();
  }).then(noop2, noop2);
  return als_import;
}
async function sha256(data) {
  text_encoder3 ??= new TextEncoder();
  crypto2 ??= globalThis.crypto?.subtle?.digest ? globalThis.crypto : (await obfuscated_import("node:crypto")).webcrypto;
  return String(await crypto2.subtle.digest("SHA-256", text_encoder3.encode(data)));
}
var als2, als_import, text_encoder3, crypto2, obfuscated_import;
var init_crypto = __esm({
  "../../node_modules/svelte/src/internal/server/crypto.js"() {
    als2 = null;
    als_import = null;
    __name(init_render_context, "init_render_context");
    obfuscated_import = /* @__PURE__ */ __name((module_name) => import(
      /* @vite-ignore */
      module_name
    ), "obfuscated_import");
    __name(sha256, "sha256");
  }
});
${extra}
import { env } from "cloudflare:workers";
var worker_default = { async fetch(request) { init_event(); init_crypto(); await init_render_context(); await sha256(String(env)); return server.respond(request); } };
export {
  worker_default as default
};
`;

/** Real Svelte 5.57.2 crypto.js and SvelteKit 3.1.0 event.js, compiled by Wrangler 4.151.1's own esbuild with Wrangler's keepNames. */
const compiledFramework = (() => {
	let text: string | undefined;
	return async () => {
		if (text) return text;
		const require = createRequire(import.meta.url);
		const esbuild = createRequire(require.resolve('wrangler/package.json'))('esbuild') as typeof import('esbuild');
		const svelte = path.dirname(require.resolve('svelte/package.json'));
		const kit = path.dirname(require.resolve('@sveltejs/kit/package.json'));
		const dir = scratch('framework');
		mkdirSync(dir);
		writeFileSync(path.join(dir, 'entry.js'), `import { sha256 } from ${JSON.stringify(path.join(svelte, 'src/internal/server/crypto.js'))};\nimport { getRequestEvent } from ${JSON.stringify(path.join(kit, 'src/exports/internal/server/event.js'))};\nimport { env } from 'cloudflare:workers';\nexport default { async fetch() { return new Response(await sha256(String(env) + typeof getRequestEvent)); } };\n`);
		const r = await esbuild.build({ entryPoints: [path.join(dir, 'entry.js')], bundle: true, format: 'esm', keepNames: true, write: false, platform: 'neutral', conditions: ['workerd', 'worker', 'browser'], external: ['cloudflare:workers', 'node:async_hooks'], target: 'es2024', logLevel: 'silent' });
		text = r.outputFiles[0]!.text;
		return text;
	};
})();

describe('RED 1: real framework dynamic imports are host-runtime modules the target flags enable, proven literal', () => {
	test('the measured shape passes the module check when the target enables nodejs_als and nodejs_compat', () => {
		expect(facts(MEASURED()).dynamicImports).toBe(3);
		expect(moduleProblems(MEASURED(), COMPAT)).toEqual([]);
	});
	test('the measured shape under nodejs_als only is refused for node:crypto alone, naming the flag it needs', () => {
		const p = moduleProblems(MEASURED(), ALS);
		expect(p.length, p.join('\n')).toBe(1);
		refusedWith(p, /node:crypto.*nodejs_compat/);
	});
	test('real Svelte/SvelteKit sources compiled by Wrangler\'s esbuild pass under nodejs_als + nodejs_compat', async () => {
		const worker = await compiledFramework();
		expect(worker).toContain('obfuscated_import("node:crypto")');
		expect(moduleProblems(worker, COMPAT)).toEqual([]);
	});
	test('the measured shape stages, prebuilt passes, and the record names each dynamic host import and how it was proven', () => {
		const artifact = separated(MEASURED());
		const clients = clientsFor(artifact, { flags: COMPAT });
		const s = stageWith(artifact, clients);
		expect(s.problems).toEqual([]);
		const record = JSON.parse(readFileSync(path.join(s.out, 'stage.json'), 'utf8'));
		expect(record.upload.hostImports).toEqual(['cloudflare:workers']);
		expect(record.upload.dynamicHostImports).toEqual([
			{ specifier: 'node:async_hooks', via: 'literal', sites: 2 },
			{ specifier: 'node:crypto', via: 'forwarder obfuscated_import', sites: 1 },
		]);
		expect(checkNativeStage({ client: 'client-a', stage: s.out, clients, pins: pinsFor(clients, artifact, 'cloudflare/_worker.js') })).toEqual([]);
	});
	test('a literal node:async_hooks dynamic import with no compatibility flag is refused, naming nodejs_als', () =>
		refusedWith(moduleProblems('export default { async fetch() { await import("node:async_hooks"); return new Response("x"); } };\n', []), /node:async_hooks.*nodejs_als/));
});

// Adversarial helpers: each must stay refused (they are refused at the base too; these guard the new proof). Every
// refusal keeps the words "dynamic import" so the old negative assertions still hold.
const forwarding = (body: string) => `var __defProp = Object.defineProperty;\nvar __name = (target, value) => __defProp(target, "name", { value, configurable: true });\n${body}\nexport default { fetch() { return new Response("x"); } };\n`;
const OK_FWD = 'var fwd = /* @__PURE__ */ __name((m) => import(m), "fwd");\n';
const adversarial: [string, string, RegExp][] = [
	['a forwarder called with a computed argument', forwarding(`${OK_FWD}export async function f(r) { return fwd(new URL(r.url).searchParams.get("m")); }`), /dynamic import/],
	['a forwarder called with a template literal', forwarding(`${OK_FWD}export async function f() { return fwd(\`node:crypto\`); }`), /dynamic import/],
	['a forwarder that escapes to a global', forwarding(`${OK_FWD}globalThis.leak = fwd;`), /dynamic import/],
	['a forwarder that is exported', forwarding(`${OK_FWD}export { fwd };`), /dynamic import/],
	['a forwarder aliased to another name', forwarding(`${OK_FWD}var g = fwd; export async function f(x) { return g(x); }`), /dynamic import/],
	['a forwarder passed as an argument', forwarding(`${OK_FWD}[1].map(fwd);`), /dynamic import/],
	['a forwarder read by typeof', forwarding(`${OK_FWD}export const t = typeof fwd;`), /dynamic import/],
	['a forwarder called through .call', forwarding(`${OK_FWD}fwd.call(null, "node:crypto");`), /dynamic import/],
	['a forwarder called optionally', forwarding(`${OK_FWD}fwd?.("node:crypto");`), /dynamic import/],
	['a forwarder reassigned', forwarding(`${OK_FWD}fwd = (m) => import(m);`), /dynamic import/],
	['a forwarder shadowed by a parameter', forwarding(`${OK_FWD}export function f(fwd) { return fwd("node:crypto"); }`), /dynamic import/],
	['a forwarder declared inside a function', forwarding('export function f() { var fwd = (m) => import(m); return fwd("node:crypto"); }'), /dynamic import/],
	['a forwarder with two parameters', forwarding('var fwd = (m, o) => import(m); fwd("node:crypto", 1);'), /dynamic import/],
	['a forwarder with import options', forwarding('var fwd = (m) => import(m, { with: { type: "json" } }); fwd("node:crypto");'), /dynamic import/],
	['a forwarder with a block body that rewrites its parameter', forwarding('var fwd = (m) => { m = "node:" + m; return import(m); }; fwd("crypto");'), /dynamic import/],
	['a forwarder with a default parameter', forwarding('var fwd = (m = location.hash) => import(m); fwd("node:crypto");'), /dynamic import/],
	['a function-expression forwarder that can read arguments', forwarding('var fwd = function (m) { return import(arguments[1]); }; fwd("node:crypto", "x");'), /dynamic import/],
	['a forwarder called with a relative module', forwarding(`${OK_FWD}fwd("./chunk.js");`), /dynamic import/],
	['a forwarder called with a host module outside the set', forwarding(`${OK_FWD}fwd("node:fs");`), /dynamic import/],
	['a keep-names helper that leaks its target', `var __name = (target, value) => (globalThis.leak = target, target);\nvar fwd = __name((m) => import(m), "fwd");\nfwd("node:crypto");\nexport default {};\n`, /dynamic import/],
	['a defineProperty alias that is not Object.defineProperty', `var __defProp = (t) => (globalThis.leak = t, t);\nvar __name = (target, value) => __defProp(target, "name", { value, configurable: true });\nvar fwd = __name((m) => import(m), "fwd");\nfwd("node:crypto");\nexport default {};\n`, /dynamic import/],
	['a defineProperty alias reassigned later', forwarding(`${OK_FWD}__defProp = (t) => (globalThis.leak = t, t);`), /dynamic import/],
	['a shadowed Object', `var Object = { defineProperty: (t) => (globalThis.leak = t, t) };\n${forwarding(`${OK_FWD}fwd("node:crypto");`)}`, /dynamic import/],
	['a keep-names helper reassigned later', forwarding(`${OK_FWD}__name = (t) => (globalThis.leak = t, t);`), /dynamic import/],
	['a literal dynamic import of a package', 'export default { async fetch() { await import("devalue"); return new Response("x"); } };\n', /dynamic import/],
	['a literal dynamic import of a relative chunk', 'export default { async fetch() { await import("./chunk.js"); return new Response("x"); } };\n', /dynamic import/],
	['a literal dynamic import of node:fs', 'export default { async fetch() { await import("node:fs"); return new Response("x"); } };\n', /dynamic import/],
	['a literal dynamic import of cloudflare:sockets', 'export default { async fetch() { await import("cloudflare:sockets"); return new Response("x"); } };\n', /dynamic import/],
	['a template-literal dynamic import of a host module', 'export default { async fetch() { await import(`node:async_hooks`); return new Response("x"); } };\n', /dynamic import/],
	['a dynamic import with options', 'export default { async fetch() { await import("node:async_hooks", { with: {} }); return new Response("x"); } };\n', /dynamic import/],
	['a dynamic import with a concatenated specifier', 'export default { async fetch() { await import("node:" + "crypto"); return new Response("x"); } };\n', /dynamic import/],
];
describe('adversarial dynamic-import helpers stay refused under the most permissive flags', () => {
	test.each(adversarial)('%s is refused', (_what, worker, reason) => refusedWith(moduleProblems(worker, COMPAT), reason));
	test('the old two-argument call (no flags) still refuses every dynamic import, even the measured shape', () => refusedWith((uploadModuleProblems as (...a: unknown[]) => string[])(facts(MEASURED()), 'artifact/cloudflare/_worker.js'), /3 dynamic import/));
	test('module facts without the dataflow classification still refuse every dynamic import', () => {
		const f = facts(MEASURED());
		refusedWith((uploadModuleProblems as (...a: unknown[]) => string[])({ syntaxErrors: f.syntaxErrors, specifiers: f.specifiers, computedSpecifiers: f.computedSpecifiers, dynamicImports: f.dynamicImports, requireCalls: f.requireCalls }, 'artifact/cloudflare/_worker.js', COMPAT), /dynamic import/);
	});
	// 25 October: static node:crypto is now a reviewed host import (crypto-host.test.ts); it still needs an enabled nodejs_compat.
	test('a static import of node:crypto stays refused without an enabled nodejs_compat (nodejs_als alone does not provide it)', () => refusedWith(moduleProblems("import c from 'node:crypto';\nexport default { fetch() { return new Response(String(c)); } };\n", ['nodejs_als']), /node:crypto.*nodejs_compat/));
});

describe('RED 2: the public assets are separated from the server entry and checked file by file', () => {
	const WORKER = KIT_WORKER;
	test('the old combined layout (the server entry inside the uploaded assets directory) is refused', () => {
		const artifact = combined(WORKER);
		refusedWith(stageWith(artifact, clientsFor(artifact, { assetsDir: 'artifact/cloudflare' })).problems, /artifact\/cloudflare.*(server|Worker entry)/);
	});
	test('the old combined layout with an empty .assetsignore (which silences Wrangler\'s own _worker.js guard) is refused', () => {
		const artifact = combined(WORKER, { '.assetsignore': '' });
		refusedWith(stageWith(artifact, clientsFor(artifact, { assetsDir: 'artifact/cloudflare' })).problems, /\.assetsignore|server|Worker entry/);
	});
	test('the separated layout stages, and the record classifies the uploaded module and every public asset by its own hash', () => {
		const artifact = separated(WORKER);
		const clients = clientsFor(artifact);
		const s = stageWith(artifact, clients);
		expect(s.problems).toEqual([]);
		const record = JSON.parse(readFileSync(path.join(s.out, 'stage.json'), 'utf8'));
		const file = (rel: string) => ({ path: `artifact/${rel}`, bytes: readFileSync(path.join(artifact, rel)).length, sha256: sha(readFileSync(path.join(artifact, rel))) });
		expect(record.upload.entry).toEqual({ path: 'artifact/cloudflare/_worker.js', sha256: sha(WORKER), bytes: Buffer.byteLength(WORKER) });
		expect(record.upload.assets).toEqual({ directory: 'artifact/public', files: [file('public/_app/immutable/entry/app.js'), file('public/_app/immutable/entry/start.js'), file('public/_app/version.json'), file('public/favicon.svg')], headers: null });
		expect(checkNativeStage({ client: 'client-a', stage: s.out, clients, pins: pinsFor(clients, artifact, 'cloudflare/_worker.js') })).toEqual([]);
	});
	const ADAPTER_HEADERS = '# === START AUTOGENERATED SVELTE IMMUTABLE HEADERS ===\n/_app/*\n  X-Robots-Tag: noindex\n  Cache-Control: no-cache\n# === END AUTOGENERATED SVELTE IMMUTABLE HEADERS ===\n# === START AUTOGENERATED SVELTE IMMUTABLE HEADERS ===\n/_app/immutable/*\n  ! Cache-Control\n  Cache-Control: public, immutable, max-age=31536000\n# === END AUTOGENERATED SVELTE IMMUTABLE HEADERS ===';
	test('the exact adapter-cloudflare 8.0.1 generated _headers is accepted and recorded as header rules, not as an asset', () => {
		const artifact = separated(WORKER, { _headers: ADAPTER_HEADERS });
		const s = stageWith(artifact, clientsFor(artifact));
		expect(s.problems).toEqual([]);
		const record = JSON.parse(readFileSync(path.join(s.out, 'stage.json'), 'utf8'));
		expect(record.upload.assets.headers).toEqual({ path: 'artifact/public/_headers', bytes: Buffer.byteLength(ADAPTER_HEADERS), sha256: sha(ADAPTER_HEADERS) });
		expect(record.upload.assets.files.map((f: { path: string }) => f.path)).not.toContain('artifact/public/_headers');
	});
	const refusedPublic: [string, Record<string, string | Buffer>, RegExp][] = [
		['a public copy of the server entry', { '_worker.js': WORKER }, /public\/_worker\.js/],
		['a public _worker.js directory', { '_worker.js/index.js': WORKER }, /_worker\.js/],
		['a renamed byte-identical copy of the server entry', { '_app/immutable/chunks/x.js': WORKER }, /byte-identical to the Worker entry/],
		['an empty .assetsignore', { '.assetsignore': '' }, /\.assetsignore/],
		['a non-empty .assetsignore', { '.assetsignore': 'secret.txt\n' }, /\.assetsignore/],
		['a _redirects file', { _redirects: '/* https://evil.example 302\n' }, /_redirects/],
		['an arbitrary _headers policy', { _headers: '/*\n  Access-Control-Allow-Origin: *\n' }, /_headers/],
		['an adapter _headers with one extra rule', { _headers: `${ADAPTER_HEADERS}\n/*\n  Access-Control-Allow-Origin: *` }, /_headers/],
		['a Pages _routes.json', { '_routes.json': '{"version":1,"include":["/*"],"exclude":[]}' }, /_routes\.json/],
		['a server source map', { '_worker.js.map': '{}' }, /source map|_worker\.js/],
		['a client source map', { '_app/immutable/chunks/x.js.map': '{}' }, /source map/],
		['a dotfile', { '.env': 'SECRET=1\n' }, /\.env/],
	];
	test.each(refusedPublic)('%s in the public assets is refused', (_what, extra, reason) => {
		const artifact = separated(WORKER, extra);
		refusedWith(stageWith(artifact, clientsFor(artifact)).problems, reason);
	});
	test('a file beside the server entry in artifact/cloudflare is refused (only the entry module is uploaded from there)', () => {
		const artifact = separated(WORKER);
		writeFileSync(path.join(artifact, 'cloudflare/_worker.js.map'), '{}');
		refusedWith(stageWith(artifact, clientsFor(artifact, {})).problems, /artifact\/cloudflare\/_worker\.js\.map/);
	});
	test('a directory beside cloudflare/ and public/ at the artifact root is refused', () => {
		const artifact = separated(WORKER);
		mkdirSync(path.join(artifact, 'server'));
		writeFileSync(path.join(artifact, 'server/index.js'), WORKER);
		refusedWith(stageWith(artifact, clientsFor(artifact)).problems, /artifact\/server.*not part of a native artifact/);
	});
	test('a public asset over the 25 MiB Workers asset limit is refused', () => {
		const artifact = separated(WORKER, { 'big.bin': Buffer.alloc(25 * 1024 * 1024 + 1) });
		refusedWith(stageWith(artifact, clientsFor(artifact)).problems, /25 MiB/);
	});
	test('a config whose assets directory is the whole artifact (entry included) is refused', () => {
		const artifact = separated(WORKER);
		refusedWith(stageWith(artifact, clientsFor(artifact, { assetsDir: 'artifact' })).problems, /assets directory/);
	});
});
