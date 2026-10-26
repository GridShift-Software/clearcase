import { afterAll, describe, expect, it } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { scanArtifact } from '../../../scripts/ci/hosted-artifact.ts';
import { manifestAssets, scanModule, workerReach } from '../../../scripts/ci/hosted-artifact-scope.ts';

const REPO = path.resolve(import.meta.dirname, '../../..');
const ENTRY = '.svelte-kit/cloudflare/_worker.js', MANIFEST = '.svelte-kit/output/server/manifest.js';
const PDF = '.svelte-kit/cloudflare/pdfjs/pdf.min.mjs', PDF_WORKER = '.svelte-kit/cloudflare/pdfjs/pdf.worker.min.mjs';
const CLIENT = '.svelte-kit/cloudflare/_app/immutable/client.js';
const ASSETS = '["pdfjs/pdf.min.mjs", "pdfjs/pdf.worker.min.mjs"]';
const GOOD = `export const manifest = { assets: new Set(${ASSETS}) };`;
const MUTANT = `export const manifest = { setup: (Set = class extends Set { constructor(xs) { super(); } }), assets: new Set(${ASSETS}) };`;
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function artifact(files: Record<string, string | Buffer>) {
	const root = mkdtempSync(path.join(os.tmpdir(), 'cc-manifest-edge-')); dirs.push(root);
	for (const [name, bytes] of Object.entries({ [ENTRY]: 'export default {};', [MANIFEST]: GOOD, ...files })) {
		const file = path.join(root, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes);
	}
	return root;
}
const errors = (files: Record<string, string | Buffer>) => scanArtifact({ root: artifact(files), profile: 'production' }).errors;
const pinned = () => ({
	[PDF]: readFileSync(path.join(REPO, 'node_modules/pdfjs-dist/build/pdf.min.mjs')),
	[PDF_WORKER]: readFileSync(path.join(REPO, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs')),
});

describe('five surviving artifact false acceptances', () => {
	it('M3 refuses effective assets emptied by an earlier initializer, with the exact pinned pair', () => {
		const found = errors({ ...pinned(), [MANIFEST]: MUTANT });
		expect(found.join('\n')).toMatch(/manifest\.js: Kit's server manifest/);
		expect(found).toContain(`hosted-artifact: ${PDF}: pdfjs/pdf.min.mjs is not a static asset in Kit's server manifest`);
		expect(found).toContain(`hosted-artifact: ${PDF}: uses process.getBuiltinModule`);
	}, 20000);
	it.each([
		['missing relative module', './missing.mjs'],
		['query edge to a public global alias', './_app/immutable/client.js?rev=1'],
		['encoded edge to a public global alias', './_app/immutable/%63lient.js'],
	])('M4 refuses %s', (_, specifier) => {
		const found = errors({ [ENTRY]: `import ${JSON.stringify(specifier)};`, [CLIENT]: 'const g = globalThis; export const p = g.process.env;' });
		expect(found.join('\n')).toMatch(/_worker\.js: imports .* (?:unresolved|unsupported)/);
	});
	it('M4 refuses a query edge to exact pinned PDF bytes', () => {
		expect(errors({ ...pinned(), [ENTRY]: 'import "./pdfjs/pdf.min.mjs?rev=1";' }).join('\n')).toMatch(/_worker\.js: imports .* unsupported/);
	}, 20000);
});

const MEMO = 'function __memo(fn) { let value; return () => value ??= (value = fn()); }';
describe('inert effective manifest construction', () => {
	it.each([
		['the direct literal', GOOD],
		['a concise arrow', `export const manifest = (() => ({ assets: new Set(${ASSETS}), client: { imports: [], enabled: false } }))();`],
		['the Kit memo and deferred loaders', `export const manifest = (() => { ${MEMO} return { nodes: [__memo(() => import('./nodes/0.js'))], assets: new Set(${ASSETS}), routes: [{pattern: /^\\/x$/, params: [], page: {layouts: [0,,], leaf: 1}}], prerendered_routes: new Set([]), matchers: async () => ({}) }; })();`],
		['trivia around the proven helper', `export const manifest = (() => { /* Set = ignored */ function __memo(fn) { let value; return () => value /* inert */ ??= (value = fn()); } return { nodes: [__memo(() => import('./nodes/0.js'))], assets: new Set(${ASSETS}) }; })();`],
		['a deferred local shadow, not the constructor origin', `export const manifest = { later: (Set) => Set, assets: new Set(${ASSETS}) };`],
	])('proves %s without executing the candidate', (_, source) => {
		expect(manifestAssets(source)).toEqual({ assets: new Set(JSON.parse(ASSETS)), problem: null });
	});
	it.each([
		['the surviving rewrite', MUTANT],
		['a later rewrite', `export const manifest = { assets: new Set(${ASSETS}), reset: (Set.prototype.clear = () => {}) };`],
		['a nested earlier rewrite', `export const manifest = { setup: { value: (Set.prototype.add = () => {}) }, assets: new Set(${ASSETS}) };`],
		['a global intrinsic rewrite', `export const manifest = { setup: (globalThis.Set = class {}), assets: new Set(${ASSETS}) };`],
		['an input iterator rewrite', `export const manifest = { setup: (Array.prototype[Symbol.iterator] = function* () {}), assets: new Set(${ASSETS}) };`],
		['an unknown eager call', `export const manifest = { setup: reset(), assets: new Set(${ASSETS}) };`],
		['an eager IIFE', `export const manifest = { setup: (() => { Set = class {}; })(), assets: new Set(${ASSETS}) };`],
		['class static initialization', `export const manifest = { setup: class { static { Set = class {}; } }, assets: new Set(${ASSETS}) };`],
		['an intrinsic alias exposed to an initializer', `export const manifest = { constructor: Set, assets: new Set(${ASSETS}) };`],
		['an aliased constructor', `export const manifest = { assets: new S(${ASSETS}) };`],
		['a constructor through the global object', `export const manifest = { assets: new globalThis.Set(${ASSETS}) };`],
		['a supplied iterable', 'export const manifest = { assets: new Set(input) };'],
		['an aliased input', `export const manifest = (() => { const input = ${ASSETS}; return { assets: new Set(input) }; })();`],
		['a constructed input', `export const manifest = { assets: new Set(Array.from(${ASSETS})) };`],
		['a hoisted Set shadow', `export const manifest = (() => { function Set() {} return { assets: new Set(${ASSETS}) }; })();`],
		['a parameter shadow', `export const manifest = ((Set) => ({ assets: new Set(${ASSETS}) }))(class {});`],
		['ASI changing the memo body', `export const manifest = (() => { function __memo(fn) { let value; return\n () => value ??= (value = fn()); } return { nodes: [__memo(() => import('./nodes/0.js'))], assets: new Set(${ASSETS}) }; })();`],
		['a rewritten memo', `export const manifest = (() => { function __memo(fn) { Set = class {}; return fn; } return { nodes: [__memo(() => import('./nodes/0.js'))], assets: new Set(${ASSETS}) }; })();`],
		['a memo callback with eager defaults', `export const manifest = (() => { ${MEMO} return { nodes: [__memo((x = reset()) => import('./nodes/0.js'))], assets: new Set(${ASSETS}) }; })();`],
		['a memo callback running a mutation', `export const manifest = (() => { ${MEMO} return { nodes: [__memo(() => (Set = class {}))], assets: new Set(${ASSETS}) }; })();`],
		['an unbound memo helper', `export const manifest = { nodes: [__memo(() => import('./nodes/0.js'))], assets: new Set(${ASSETS}) };`],
		['a duplicate property', `export const manifest = { assets: new Set(${ASSETS}), assets: new Set([]) };`],
		['a prototype override', `export const manifest = { __proto__: input, assets: new Set(${ASSETS}) };`],
		['a computed property initializer', `export const manifest = { [reset()]: 0, assets: new Set(${ASSETS}) };`],
		['an accessor beside assets', `export const manifest = { get setup() { return reset(); }, assets: new Set(${ASSETS}) };`],
	])('refuses %s with no asset authorization', (_, source) => {
		const result = manifestAssets(source);
		expect(result.problem).toMatch(/Kit's server manifest/);
		expect([...result.assets]).toEqual([]);
	});
	it('proves the installed Kit generator output and resolves its real adapter dependency shape', async () => {
		// Trusted generator on synthetic inputs, never evaluation of the emitted candidate manifest.
		const { generate_manifest } = await import(pathToFileURL(path.join(REPO, 'node_modules/@sveltejs/kit/src/core/generate_manifest/index.js')).href);
		const input = { build_data: {
			app_dir: '_app', app_path: '_app', client: { imports: [], stylesheets: [], fonts: [] }, server_manifest: {},
			manifest_data: { assets: JSON.parse(ASSETS).map((file: string) => ({ file, type: 'text/javascript' })), nodes: [{}, {}], routes: [], hooks: {} },
		}, prerendered: [], routes: [], remotes: [], root: REPO };
		const generated = generate_manifest({ ...input, relative_path: '.' });
		const adapterManifest = generate_manifest({ ...input, relative_path: '../output/server' });
		expect(manifestAssets(`export const manifest = ${generated};`)).toEqual({ assets: new Set(JSON.parse(ASSETS)), problem: null });
		const root = artifact({
			[MANIFEST]: `export const manifest = ${generated};`,
			[ENTRY]: 'import { server } from "../cloudflare-tmp/server.js"; export { server };',
			'.svelte-kit/cloudflare-tmp/server.js': `import { create_server } from '../output/server/index.js'; const manifest = ${adapterManifest}; export const server = create_server(manifest);`,
			'.svelte-kit/output/server/index.js': 'export const create_server = manifest => ({ manifest });',
			'.svelte-kit/output/server/nodes/0.js': 'export const index = 0;',
			'.svelte-kit/output/server/nodes/1.js': 'export const index = 1;',
		});
		expect(scanArtifact({ root, profile: 'production' })).toEqual({ errors: [], files: 6 });
	});
});

describe('closed reachable artifact edges', () => {
	it.each([
		'./_app/immutable/client.js#part', './_app/immutable/%2563lient.js', './_app/immutable/client.js?x#y',
		'./_app/immutable/client.js%3Frev=1', './%2e%2e/outside.js', './_app\\immutable\\client.js', './_app/immutable/client.js\u0000',
	])('refuses unsupported relative URL form %s', (specifier) => {
		expect(errors({ [ENTRY]: `export const load = () => import(${JSON.stringify(specifier)});`, [CLIENT]: 'const g = globalThis; export { g };' }).join('\n')).toContain('unsupported module specifier');
	});
	it.each([
		'export * from "./missing.mjs";', 'export const load = () => import("./missing.mjs");',
		'const load = m => import(m); export const value = () => load("./missing.mjs");',
	])('refuses a missing target for %s', (source) => {
		expect(errors({ [ENTRY]: source }).join('\n')).toMatch(/imports \.\/missing\.mjs, unresolved relative module/);
	});
	it('does not silently accept a missing target when no disk loader is supplied', () => {
		const text = 'import "./missing.mjs";';
		expect(workerReach(new Map([[ENTRY, { text, scan: scanModule(text) }]])).problems).toEqual([[ENTRY, 'imports ./missing.mjs, unresolved relative module: no artifact bytes']]);
	});
	it('allows a public-only module but enforces its role through a multihop re-export cycle', () => {
		const files = { [CLIENT]: 'const g = globalThis; export const p = g.process.env;' };
		expect(errors(files)).toEqual([]);
		const reached = errors({ ...files, [ENTRY]: 'import "../cloudflare-tmp/server.js";',
			'.svelte-kit/cloudflare-tmp/server.js': 'export * from "../extra/bridge.mjs";',
			'.svelte-kit/extra/bridge.mjs': 'export * from "../cloudflare/_app/immutable/client.js"; export * from "../cloudflare-tmp/server.js";',
		});
		expect(reached).toContain(`hosted-artifact: ${CLIENT}: unresolved global object access (const g = globalThis)`);
	});
	it('a resolved outside-inventory dependency cannot hide a forbidden use or an unproven import', () => {
		for (const source of ['process.exit(1);', 'export const go = x => import(x);', 'export const = 1;', 'import "./missing.mjs";']) {
			expect(errors({ [ENTRY]: 'import "../extra/helper.mjs";', '.svelte-kit/extra/helper.mjs': source }).join('\n')).toMatch(/extra\/helper\.mjs: (?:uses process.exit|import\(\) target is not proven|not parseable|imports .*unresolved relative module)/);
		}
	});
	it('a resolved adapter dependency loses the pinned PDF exception through a proven forwarder', () => {
		const found = errors({ ...pinned(), [ENTRY]: 'import "../cloudflare-tmp/server.js";',
			'.svelte-kit/cloudflare-tmp/server.js': 'const load = m => import(m); export const pdf = () => load("../cloudflare/pdfjs/pdf.min.mjs");',
		});
		expect(found).toContain(`hosted-artifact: ${PDF}: reachable from the Worker (${ENTRY} -> .svelte-kit/cloudflare-tmp/server.js -> ${PDF})`);
		expect(found).toContain(`hosted-artifact: ${PDF}: uses process.getBuiltinModule`);
	}, 20000);
	it('refuses a reachable query/encoded bridge rather than retaining browser-only authority', () => {
		for (const target of ['./bridge.mjs?rev=1', './%62ridge.mjs', './bridge.mjs#part']) {
			expect(errors({ [ENTRY]: 'import "../extra/helper.mjs";', '.svelte-kit/extra/helper.mjs': `export * from ${JSON.stringify(target)};`,
				'.svelte-kit/extra/bridge.mjs': 'const g = globalThis; export { g };',
			}).join('\n')).toMatch(/extra\/helper\.mjs: imports .*unsupported module specifier/);
		}
	});
	it('refuses an escape even when the target exists outside the build root', () => {
		const found = errors({ [ENTRY]: 'import "../../outside.js";', 'outside.js': 'process.exit(1);' });
		expect(found).toContain(`hosted-artifact: ${ENTRY}: imports ../../outside.js, outside the bounded JS artifact graph`);
		expect(found.some(e => e.includes('outside.js: uses'))).toBe(false);
	});
	it.each(['a file symlink', 'a directory symlink', 'a hard link'])('refuses %s in a discovered dependency', (kind) => {
		const root = artifact({ [ENTRY]: 'import "../extra/helper.mjs";', 'outside/helper.mjs': 'export const x = 1;' });
		if (kind === 'a directory symlink') symlinkSync(path.join(root, 'outside'), path.join(root, '.svelte-kit/extra'));
		else {
			mkdirSync(path.join(root, '.svelte-kit/extra'));
			const from = path.join(root, 'outside/helper.mjs'), to = path.join(root, '.svelte-kit/extra/helper.mjs');
			if (kind === 'a hard link') linkSync(from, to); else symlinkSync(from, to);
		}
		expect(scanArtifact({ root, profile: 'production' }).errors.join('\n')).toMatch(/unresolved relative module: .*?(?:symlink|hard link)/);
	});
	it.each(['.svelte-kit/cloudflare', '.svelte-kit'])('refuses a symlinked inventory root %s before walking it', (name) => {
		const root = artifact({}), from = path.join(root, name), relocated = path.join(root, 'relocated');
		renameSync(from, relocated); symlinkSync(relocated, from);
		expect(scanArtifact({ root, profile: 'production' }).errors.join('\n')).toMatch(/cannot read artifact directory: .*symlink refused/);
	});
	it('refuses a descriptor dependency over the byte bound without reading its contents', () => {
		const root = artifact({ [ENTRY]: 'import "../extra/helper.mjs";', '.svelte-kit/extra/helper.mjs': '' });
		truncateSync(path.join(root, '.svelte-kit/extra/helper.mjs'), 64 * 1024 * 1024 + 1);
		expect(scanArtifact({ root, profile: 'production' }).errors.join('\n')).toContain('over the 67108864 byte limit');
	});
	it('resolves canonical relative paths to one bounded module snapshot', () => {
		const root = artifact({ [ENTRY]: 'import "../extra/../extra/helper.mjs"; import "../extra/helper.mjs";', '.svelte-kit/extra/helper.mjs': 'export const value = 1;' });
		expect(scanArtifact({ root, profile: 'production' })).toEqual({ errors: [], files: 3 });
	});
});
