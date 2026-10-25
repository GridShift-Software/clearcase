import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanArtifact } from '../../../scripts/ci/hosted-artifact.ts';
import { PINNED_BROWSER_MODULES } from '../../../scripts/ci/hosted-artifact-scope.ts';
import { adaptKitDiagnostics, KIT_DIAGNOSTIC_MODULES } from '../../../scripts/hosted-kit-diagnostics-build.ts';
import { HOSTED_PDF_PACKAGE_DIGEST, prepareHostedPdfAssets, type PdfAssetInventory } from '../../../scripts/hosted-pdf-assets.ts';

const REPO = path.resolve(import.meta.dirname, '../../..');
const PDF = '.svelte-kit/cloudflare/pdfjs/pdf.min.mjs', WORKER = '.svelte-kit/cloudflare/pdfjs/pdf.worker.min.mjs';
const MANIFEST = '.svelte-kit/output/server/manifest.js', CHUNK = '.svelte-kit/output/server/chunks/app.js';
const listed = (assets: string[]) => `export const manifest = (() => ({ appDir: "_app", assets: new Set(${JSON.stringify(assets)}), _: { client: {} } }))();`;
const temp: string[] = [];
let inventory: PdfAssetInventory, pdf: Buffer, worker: Buffer;

beforeAll(() => {
	const out = mkdtempSync(path.join(os.tmpdir(), 'cc-artifact-scope-pdf-')); temp.push(out);
	inventory = prepareHostedPdfAssets({ root: REPO, publicRoot: out });
	pdf = readFileSync(path.join(out, 'pdfjs/pdf.min.mjs')); worker = readFileSync(path.join(out, 'pdfjs/pdf.worker.min.mjs'));
});
afterAll(() => { for (const d of temp.splice(0)) rmSync(d, { recursive: true, force: true }); });

function artifact(files: Record<string, string | Buffer>): string {
	const root = mkdtempSync(path.join(os.tmpdir(), 'cc-artifact-scope-')); temp.push(root);
	for (const [name, body] of Object.entries({ '.svelte-kit/cloudflare/_worker.js': 'export default { fetch() {} };', [CHUNK]: 'export const x = 1;', ...files })) {
		mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), body);
	}
	return root;
}
const errors = (files: Record<string, string | Buffer>) => scanArtifact({ root: artifact(files), profile: 'production' }).errors;
const pinned = (extra: Record<string, string | Buffer> = {}) => ({ [PDF]: pdf, [WORKER]: worker, [MANIFEST]: listed(['favicon.svg', 'pdfjs/pdf.min.mjs', 'pdfjs/pdf.worker.min.mjs']), ...extra });

describe('pinned PDF.js browser modules', () => {
	it('derive each pin from the trusted full-package inventory', () => {
		expect(inventory.packageDigest).toBe(HOSTED_PDF_PACKAGE_DIGEST);
		expect(Object.keys(PINNED_BROWSER_MODULES)).toEqual([PDF, WORKER]);
		for (const [name, pin] of Object.entries(PINNED_BROWSER_MODULES)) {
			expect(name).toBe(`.svelte-kit/cloudflare/${pin.asset}`);
			expect(inventory.files).toContainEqual({ path: pin.asset, bytes: pin.bytes, sha256: pin.sha256 });
		}
	});
	it('pass at their exact path, bytes and manifest role, with a browser reader importing them', () => {
		expect(errors(pinned({ '.svelte-kit/cloudflare/pdfjs/pdf-reader.mjs': 'import * as pdfjs from "./pdf.min.mjs"; export { pdfjs };' }))).toEqual([]);
	});
	it.each([
		['server output', '.svelte-kit/output/server/chunks/pdf.min.mjs', () => pdf],
		['a debug copy', '.svelte-kit/cloudflare/pdfjs/debug/pdf.min.mjs', () => pdf],
		['an unknown client path', '.svelte-kit/cloudflare/_app/immutable/chunks/pdf.min.mjs', () => pdf],
		['the worker path', WORKER, () => pdf],
		['the Worker entry', '.svelte-kit/cloudflare/_worker.js', () => worker],
	])('refuse the same bytes in %s', (_, name, bytes) => {
		const found = errors(pinned({ [name]: bytes() }));
		expect(found).toContain(`hosted-artifact: ${name}: uses process.type`);
		expect(found).toContain(`hosted-artifact: ${name}: uses process`);
	});
	it.each([
		['a trailing newline', (b: Buffer) => Buffer.concat([b, Buffer.from('\n')])],
		['CRLF line endings', (b: Buffer) => Buffer.from(b.toString('utf8').replaceAll('\n', '\r\n'))],
		['one same-length byte changed', (b: Buffer) => Buffer.from(b.toString('utf8').replace('[object process]', '[object process!'))],
		['an extra import', (b: Buffer) => Buffer.concat([Buffer.from('import "node:fs";\n'), b])],
		['grafted server content', (b: Buffer) => Buffer.concat([b, Buffer.from(';globalThis.process.exit(1);')])],
	])('refuse the pinned path holding %s', (what, change) => {
		const bytes = change(pdf), found = errors(pinned({ [PDF]: bytes }));
		expect(bytes.equals(pdf)).toBe(false);
		expect(found.join('\n')).toMatch(/pdf\.min\.mjs: bytes are not the pinned PDF\.js pdfjs\/pdf\.min\.mjs \(sha256:[0-9a-f]{64}\)/);
		expect(found).toContain(`hosted-artifact: ${PDF}: uses process.getBuiltinModule`);
		if (what === 'an extra import') expect(found).toContain(`hosted-artifact: ${PDF}: imports node:fs`);
		if (what === 'grafted server content') expect(found).toContain(`hosted-artifact: ${PDF}: uses process.exit`);
	});
	it('refuse a lookalike with no Node branch at a pinned path', () => {
		expect(errors(pinned({ [WORKER]: 'export const version = "6.4.299"; // pdf.worker.min.mjs' })).join('\n')).toMatch(/pdf\.worker\.min\.mjs: bytes are not the pinned PDF\.js pdfjs\/pdf\.worker\.min\.mjs/);
	});
	it.each([
		['no Kit manifest', undefined],
		['a manifest that does not list it', listed(['favicon.svg', 'pdfjs/pdf.worker.min.mjs'])],
		['a manifest naming it outside assets', `export const manifest = { assets: new Set(["pdfjs/pdf.worker.min.mjs"]), prerendered: new Set(["pdfjs/pdf.min.mjs"]) }; // "pdfjs/pdf.min.mjs"`],
	])('refuse the exact bytes with %s', (_, manifest) => {
		const files: Record<string, string | Buffer> = pinned();
		if (manifest === undefined) delete files[MANIFEST]; else files[MANIFEST] = manifest;
		const found = errors(files);
		expect(found).toContain(`hosted-artifact: ${PDF}: pdfjs/pdf.min.mjs is not a static asset in Kit's server manifest`);
		expect(found).toContain(`hosted-artifact: ${PDF}: uses process.getBuiltinModule`);
	});
	it.each([
		['.svelte-kit/cloudflare/_worker.js', 'import "./pdfjs/pdf.min.mjs"; export default {};', './pdfjs/pdf.min.mjs'],
		[CHUNK, 'export const load = () => import("../../../cloudflare/pdfjs/pdf.worker.min.mjs");', '../../../cloudflare/pdfjs/pdf.worker.min.mjs'],
		[CHUNK, 'export * from "../../../cloudflare/pdfjs/pdf.min.mjs";', '../../../cloudflare/pdfjs/pdf.min.mjs'],
	])('refuse a Worker-side import of a pinned module (%s)', (name, source, specifier) => {
		expect(errors(pinned({ [name]: source }))).toContain(`hosted-artifact: ${name}: imports the browser-only PDF.js module ${specifier}`);
	});
});

describe('process and Bun: global use against local bindings', () => {
	it('passes the real SDK JSDoc that names nodejs.org/api/process.html', () => {
		const chooser = readFileSync(path.join(REPO, 'node_modules/@cloudflare/puppeteer/lib/esm/puppeteer/common/FileChooser.js'), 'utf8');
		expect(chooser).toContain('https://nodejs.org/api/process.html#process_process_cwd');
		expect(errors({ [CHUNK]: chooser })).toEqual([]);
	});
	it.each([
		['a module-scoped SSR object', 'const process = { html: "<p>" }; export const h = process.html;'],
		['a parameter', 'export function f(process) { return process.html + process.env; }'],
		['a destructured parameter', 'export function f({ process }) { return process.type; }'],
		['a hoisted var', 'export function f() { const r = process.cwd(); var process = { cwd: () => "/" }; return r; }'],
		['a catch binding', 'try { f(); } catch (process) { console.log(process.message); }'],
		['an import binding', 'import { process } from "./work.js"; export const s = process.html;'],
		['a class field and member', 'export class C { process = { html: "" }; m() { return this.process.html; } }'],
		['an object key and label', 'export const o = { process: 1, Bun: 2 }; process: for (;;) break process;'],
		['comments and strings', '/** see process.env and Bun.file */ export const s = "process.exit(1)" + `Bun.spawn`;'],
		['an export alias', 'const work = {}; export { work as process, work as Bun };'],
		['a named function expression', 'export const f = function process() { return process.name; };'],
		['a block-scoped local', 'export function f() { { const Bun = { file: () => 1 }; return Bun.file(); } }'],
	])('allows %s', (_, source) => {
		expect(errors({ [CHUNK]: source })).toEqual([]);
	});
	it.each([
		['an alias', 'const p = process; p.exit(0);', 'process'],
		['a destructure of the global', 'export const { env } = process;', 'process'],
		['a shorthand property', 'export const o = { process };', 'process'],
		['a parenthesised access', 'export const e = (process).env;', 'process'],
		['an element access', 'export const h = process["env"].HOME;', 'process.env'],
		['globalThis element access', 'export const h = globalThis["process"].env;', 'process.env'],
		['self.process', 'self.process.exit(1);', 'process.exit'],
		['an optional chain on globalThis only', 'globalThis?.process.exit(1);', 'process.exit'],
		['a re-export of the global', 'export { process };', 'process'],
		['an unguarded getBuiltinModule', 'export const fs = globalThis.process.getBuiltinModule("node:fs");', 'process.getBuiltinModule'],
		['a use outside the shadowing block', 'export function f() { { const process = {}; } return process.env; }', 'process.env'],
		['a shadow in another function', 'function g(process) { return process; } export const e = process.env;', 'process.env'],
		['globalThis.process after a globalThis expando', 'globalThis.app = {}; globalThis.process.exit(1);', 'process.exit'],
		['a Bun alias', 'export const B = Bun;', 'Bun'],
		['globalThis.Bun', 'export const f = globalThis.Bun.file("x");', 'Bun.file'],
		['Bun.spawn', 'Bun.spawn(["sh"]);', 'Bun.spawn'],
	])('refuses %s', (_, source, use) => {
		expect(errors({ [CHUNK]: source })).toContain(`hosted-artifact: ${CHUNK}: uses ${use}`);
	});
	it('refuses a module it cannot parse rather than skipping it', () => {
		expect(errors({ [CHUNK]: 'export const = process.env;' }).join('\n')).toContain(`${CHUNK}: not parseable as an ES module`);
	});
});

describe('getBuiltinModule and optional chains on the process global', () => {
	const KIT_SERVER = '.svelte-kit/output/server/chunks/internal.js';
	// Kit 3's server runtime: sourcemaps.js (fs, url, path, module, cwd) and internal.js (util), as Rolldown emits them.
	const kit = ['fs', 'url', 'path', 'module'].map((m) => `var ${m} = globalThis.process?.getBuiltinModule?.("node:${m}");`)
		.concat('var cwd = globalThis.process?.cwd?.();', 'var styleText = globalThis.process?.getBuiltinModule?.("node:util")?.styleText ?? ((_format, text) => text);');
	// The hosted build adapts these two modules (scripts/hosted-kit-diagnostics-build.ts); the scan exempts no Kit text.
	const KIT_PROBES = new Set(Object.values(KIT_DIAGNOSTIC_MODULES).flatMap((m) => m.probes));
	it('pins each probe to the installed Kit source and nothing more', () => {
		const source = ['sourcemaps.js', 'internal.js'].map((f) => readFileSync(path.join(REPO, 'node_modules/@sveltejs/kit/src/runtime/server', f), 'utf8')).join('\n');
		const found = [...source.matchAll(/globalThis\.process\?\.[^;]*?\)/g)].map((m) => m[0]);
		expect(new Set(found)).toEqual(KIT_PROBES);
		expect(found).toHaveLength(KIT_PROBES.size);
	});
	it('passes the exact Kit server probes in Kit\'s server output', () => {
		const adapted = Object.keys(KIT_DIAGNOSTIC_MODULES).map((m) => adaptKitDiagnostics(m, readFileSync(path.join(REPO, 'node_modules/@sveltejs/kit', m), 'utf8')));
		expect(errors({ [KIT_SERVER]: adapted.join('\n') })).toEqual([]);
		expect(errors({ [KIT_SERVER]: kit.join('\n') })).toContain(`hosted-artifact: ${KIT_SERVER}: uses process.cwd`);
	});
	it.each([
		['node:child_process', 'globalThis.process?.getBuiltinModule?.("node:child_process");', 'process.getBuiltinModule'],
		['node:fs/promises', 'globalThis.process?.getBuiltinModule?.("node:fs/promises");', 'process.getBuiltinModule'],
		['bare fs', 'globalThis.process?.getBuiltinModule?.("fs");', 'process.getBuiltinModule'],
		['an unreviewed literal module', 'globalThis.process?.getBuiltinModule?.("node:os");', 'process.getBuiltinModule'],
		['a computed target', 'export const load = (m) => globalThis.process?.getBuiltinModule?.(m);', 'process.getBuiltinModule'],
		['a concatenated target', 'globalThis.process?.getBuiltinModule?.("node:" + "fs");', 'process.getBuiltinModule'],
		['an escaped target', 'globalThis.process?.getBuiltinModule?.("node:\\u0066s");', 'process.getBuiltinModule'],
		['a single-quoted target', "globalThis.process?.getBuiltinModule?.('node:fs');", 'process.getBuiltinModule'],
		['an extra argument', 'globalThis.process?.getBuiltinModule?.("node:fs", 1);', 'process.getBuiltinModule'],
		['a bare process', 'process?.getBuiltinModule?.("node:fs");', 'process.getBuiltinModule'],
		['self', 'self.process?.getBuiltinModule?.("node:fs");', 'process.getBuiltinModule'],
		['global', 'global.process?.getBuiltinModule?.("node:fs");', 'process.getBuiltinModule'],
		['globalThis element notation', 'globalThis["process"]?.getBuiltinModule?.("node:fs");', 'process.getBuiltinModule'],
		['member element notation', 'globalThis.process?.["getBuiltinModule"]?.("node:fs");', 'process.getBuiltinModule'],
		['an escaped member name', 'globalThis.process?.getBuiltin\\u004dodule?.("node:fs");', 'process.getBuiltinModule'],
		['a comment inside the probe', 'globalThis.process?./* */getBuiltinModule?.("node:fs");', 'process.getBuiltinModule'],
		['an aliased acquisition', 'const g = globalThis.process?.getBuiltinModule; export const fs = g?.("node:fs");', 'process.getBuiltinModule'],
		['an optional member read', 'export const g = globalThis.process?.getBuiltinModule;', 'process.getBuiltinModule'],
		['a typeof of the member', 'export const t = typeof globalThis.process?.getBuiltinModule;', 'process.getBuiltinModule'],
		['a computed member', 'export const f = (k) => globalThis.process?.[k]?.("node:fs");', 'process'],
		['an optional process.exit', 'globalThis.process?.exit?.(1);', 'process.exit'],
		['an optional process.env', 'export const h = process?.env?.HOME;', 'process.env'],
		['an optional process.binding', 'globalThis.process?.binding?.("fs");', 'process.binding'],
		['an optional cwd off the bare global', 'export const c = process?.cwd?.();', 'process.cwd'],
		['an optional Bun.spawn', 'globalThis.Bun?.spawn?.(["sh"]);', 'Bun.spawn'],
	])('refuses %s in Kit\'s server output', (_, source, use) => {
		expect(errors({ [KIT_SERVER]: source })).toContain(`hosted-artifact: ${KIT_SERVER}: uses ${use}`);
	});
	it.each([
		['the Worker entry', '.svelte-kit/cloudflare/_worker.js'],
		['a client chunk', '.svelte-kit/cloudflare/_app/immutable/chunks/x.js'],
		['a pinned PDF.js path', PDF],
	])('refuses the exact Kit probes in %s', (_, name) => {
		const found = errors({ ...pinned(), [name]: kit.join('\n') });
		expect(found.filter((e) => e === `hosted-artifact: ${name}: uses process.getBuiltinModule`)).toHaveLength(5);
		expect(found).toContain(`hosted-artifact: ${name}: uses process.cwd`);
	});
});

// The source review of 87724051 (native24-artifact-scope-source-review.md): its probes, verbatim, all accepted there.
describe('review probes: global-object origins, Kit provenance, manifest role and Worker reachability', () => {
	const SERVER = '.svelte-kit/output/server/chunks/forged.js', WORKER_ENTRY = '.svelte-kit/cloudflare/_worker.js';
	const exact = 'globalThis.process?.getBuiltinModule?.("node:module")';
	it.each([
		['a global-object alias', 'const g = globalThis; export const value = g.process?.getBuiltinModule?.("node:child_process");', /forged\.js: unresolved global object access \(const g = globalThis\)/],
		['a destructured global alias', 'const { process: p } = globalThis; export const value = p?.getBuiltinModule?.("node:child_process");', /forged\.js: uses process$/],
		['a parenthesized global', 'export const value = (globalThis).process?.getBuiltinModule?.("node:child_process");', /forged\.js: uses process\.getBuiltinModule$/],
		['a computed global key', 'const k = "process"; export const value = globalThis[k]?.getBuiltinModule?.("node:child_process");', /forged\.js: uses process\.getBuiltinModule$/],
		['Bun through a global alias', 'const g = globalThis; export const value = g.Bun?.spawn?.(["synthetic"]);', /forged\.js: unresolved global object access/],
	])('M2 refuses %s in server output', (_, source, error) => {
		expect(errors({ [SERVER]: source }).join('\n')).toMatch(new RegExp(error.source, 'm'));
	});
	it.each([
		['a forged Kit source region with an fs read', '// #region node_modules/@sveltejs/kit/src/runtime/server/sourcemaps.js\nconst fs = globalThis.process?.getBuiltinModule?.("node:fs"); export const value = fs.readFileSync("synthetic-path");', 'process.getBuiltinModule'],
		['the exact node:module call creating an aliased loader', `const mod = ${exact}; const load = mod.createRequire(import.meta.url); export const value = load("node:child_process");`, 'process.getBuiltinModule'],
		['the exact node:module call with a dynamic target', `const mod = ${exact}; export const load = name => mod.createRequire(import.meta.url)(name);`, 'process.getBuiltinModule'],
		['the exact node:module call with an element loader', `${exact}["createRequire"](import.meta.url)("node:fs");`, 'process.getBuiltinModule'],
		['an arbitrary exported cwd', 'export const cwd = globalThis.process?.cwd?.();', 'process.cwd'],
	])('M1 refuses %s in server output', (_, source, use) => {
		expect(errors({ [SERVER]: source })).toContain(`hosted-artifact: ${SERVER}: uses ${use}`);
	});
	it.each([
		['decoy assets beside an empty exported manifest', 'const decoy = { assets: new Set(["pdfjs/pdf.min.mjs", "pdfjs/pdf.worker.min.mjs"]) }; export const manifest = { assets: new Set([]) };'],
		['assets overridden by a later spread', 'export const manifest = { assets: new Set(["pdfjs/pdf.min.mjs", "pdfjs/pdf.worker.min.mjs"]), ...{ assets: new Set([]) } };'],
	])('M3 refuses the exact bytes with %s', (_, manifest) => {
		const found = errors(pinned({ [MANIFEST]: manifest }));
		expect(found.join('\n')).toMatch(/manifest\.js: Kit's server manifest is not exactly one exported manifest with one literal assets set/);
		expect(found).toContain(`hosted-artifact: ${PDF}: pdfjs/pdf.min.mjs is not a static asset in Kit's server manifest`);
		expect(found).toContain(`hosted-artifact: ${PDF}: uses process.getBuiltinModule`);
	});
	it('M4 refuses a Worker import through a public wrapper', () => {
		const found = errors(pinned({ [WORKER_ENTRY]: 'import { pdfjs } from "./pdfjs/bridge.mjs"; export { pdfjs };', '.svelte-kit/cloudflare/pdfjs/bridge.mjs': 'import * as pdfjs from "./pdf.min.mjs"; export { pdfjs };' }));
		expect(found).toContain('hosted-artifact: .svelte-kit/cloudflare/pdfjs/bridge.mjs: imports the browser-only PDF.js module ./pdf.min.mjs');
		expect(found).toContain(`hosted-artifact: ${PDF}: reachable from the Worker (.svelte-kit/cloudflare/_worker.js -> .svelte-kit/cloudflare/pdfjs/bridge.mjs -> ${PDF})`);
		expect(found).toContain(`hosted-artifact: ${PDF}: uses process.getBuiltinModule`);
	});
	it('M4 refuses a computed Worker import of a pinned file', () => {
		const found = errors(pinned({ [WORKER_ENTRY]: 'const target = "./pdfjs/pdf.min.mjs"; export const load = () => import(target);' }));
		expect(found.join('\n')).toMatch(/_worker\.js: import\(\) target is not proven at line 1: /);
	});
});

describe('global-object origins, manifest binding and Worker reachability around the review probes', () => {
	const SERVER = '.svelte-kit/output/server/chunks/forged.js', CLIENT = '.svelte-kit/cloudflare/_app/immutable/chunks/c.js';
	// Kit's own global state key and Svelte's WebCrypto fallback, as Rolldown emits them.
	const KIT_STATE = 'var symbol = Symbol.for("sveltekit.global_state"); globalThis[symbol] ??= {}; export const s = globalThis[symbol];';
	const SVELTE_FORWARDER = 'var obfuscated_import = (module_name) => import(\n\t/* @vite-ignore */\n\tmodule_name\n);\nexport const c = async () => globalThis.crypto?.subtle?.digest ? globalThis.crypto : (await obfuscated_import("node:crypto")).webcrypto;';
	it.each([
		['Kit\'s symbol-keyed global state', KIT_STATE],
		['Svelte\'s proven import forwarder', SVELTE_FORWARDER],
		['static members, typeof and a destructure of the global object', 'export const f = globalThis.fetch, w = globalThis?.window?.trustedTypes, t = typeof self; const { crypto } = globalThis; globalThis.app = {}; export { crypto };'],
		['symbol reads and calls', 'export const i = Symbol.iterator, a = Symbol("x"), t = typeof Symbol, k = Symbol.for("k");'],
	])('passes %s in server output', (_, source) => {
		expect(errors({ [SERVER]: source })).toEqual([]);
	});
	it.each([
		['a reassigned symbol key', 'var symbol = Symbol.for("x"); symbol = "process"; globalThis[symbol].exit(1);', /unresolved global object access \(globalThis\[symbol\]\)/],
		['a key declared twice', 'var k = "x"; var k = "process"; globalThis[k].exit(1);', /unresolved global object access \(globalThis\[k\]\)/],
		['a rewritten Symbol.for', 'Symbol.for = () => "process"; const k = Symbol.for("x"); export const p = globalThis[k];', /unresolved global object access \(Symbol\.for\)/],
		['globalThis.Symbol', 'globalThis.Symbol = { for: () => "process" };', /unresolved global object access \(globalThis\.Symbol\)/],
		['the global object passed to a call', 'export const d = Reflect.get(globalThis, "process");', /unresolved global object access \(Reflect\.get\(globalThis, "process"\)\)/],
		['a rest destructure', 'const { ...all } = globalThis; export const p = all.process;', /unresolved global object access \(\.\.\.all\)/],
		['the global object through its own member', 'globalThis.self.process.exit(1);', /uses process\.exit$/],
		['a global key read through window', 'export const p = globalThis.window.process.env;', /uses process\.env$/],
		['node:process by import', 'import { getBuiltinModule } from "node:process"; export const m = getBuiltinModule("node:fs");', /imports node:process$/],
		['node:module by dynamic import', 'export const m = await import("node:module");', /imports node:module$/],
		['a forwarder called with a local-only module', 'var load = (m) => import(m); export const c = () => load("node:child_process");', /imports node:child_process$/],
		['an unproven import()', 'export const load = (m, o) => import(m, o);', /import\(\) target is not proven at line 1: /],
		['a data: import', 'export const m = () => import("data:text/javascript,export default 1");', /imports data:text\/javascript,export default 1, outside the artifact graph$/],
	])('refuses %s in server output', (_, source, error) => {
		expect(errors({ [SERVER]: source }).join('\n')).toMatch(new RegExp(error.source, 'm'));
	});
	it('scopes unresolved global access and unproven import() to modules the Worker runs', () => {
		const browser = 'export const v = (e, t) => new globalThis[e](t); export const go = (u) => import(u);';
		expect(errors({ [CLIENT]: browser })).toEqual([]);
		const reached = errors({ [CLIENT]: browser, '.svelte-kit/cloudflare/_worker.js': 'import { v } from "./_app/immutable/chunks/c.js"; export default { v };' });
		expect(reached).toContain(`hosted-artifact: ${CLIENT}: unresolved global object access (globalThis[e])`);
		expect(reached.join('\n')).toMatch(/c\.js: import\(\) target is not proven at line 1: /);
		expect(errors({ [CLIENT]: 'const g = globalThis; g.process.exit(1); process.exit(1);' })).toEqual([`hosted-artifact: ${CLIENT}: uses process.exit`]);
	});
	it('passes a manifest in the shape Kit 3 emits', () => {
		const kit = 'export const manifest = (() => {\nfunction __memo(fn) {\n\tlet value;\n\treturn () => value ??= (value = fn());\n}\n\nreturn {\n\tapp_dir: "_app",\n\tassets: new Set(["favicon.svg","pdfjs/pdf.min.mjs","pdfjs/pdf.worker.min.mjs"]),\n\tmime_types: {".svg":"image/svg+xml"},\n\tnodes: [\n\t\t__memo(() => import(\'./nodes/0.js\'))\n\t],\n\tmatchers: async () => {\n\t\treturn {  };\n\t}\n}\n})();\n';
		expect(errors(pinned({ [MANIFEST]: kit }))).toEqual([]);
	});
	it.each([
		['two assets properties', 'export const manifest = { assets: new Set(["pdfjs/pdf.min.mjs", "pdfjs/pdf.worker.min.mjs"]), assets: new Set([]) };'],
		['a computed key', 'export const manifest = { assets: new Set(["pdfjs/pdf.min.mjs", "pdfjs/pdf.worker.min.mjs"]), ["ass" + "ets"]: new Set([]) };'],
		['a mutable binding', 'export let manifest = { assets: new Set(["pdfjs/pdf.min.mjs", "pdfjs/pdf.worker.min.mjs"]) };'],
		['a later statement', 'export const manifest = { assets: new Set(["pdfjs/pdf.min.mjs", "pdfjs/pdf.worker.min.mjs"]) }; manifest.assets.clear();'],
		['a computed element', 'const p = "pdfjs/pdf.min.mjs"; export const manifest = { assets: new Set([p, "pdfjs/pdf.worker.min.mjs"]) };'],
		['an accessor', 'export const manifest = { get assets() { return new Set(["pdfjs/pdf.min.mjs", "pdfjs/pdf.worker.min.mjs"]); } };'],
		['an IIFE with other statements', 'export const manifest = (() => { const o = { assets: new Set(["pdfjs/pdf.min.mjs", "pdfjs/pdf.worker.min.mjs"]) }; return { assets: new Set(["pdfjs/pdf.min.mjs", "pdfjs/pdf.worker.min.mjs"]) }; })();'],
		['a shadowed Set', 'export const manifest = (() => { function Set() { return new globalThis.Set(); } return { assets: new Set(["pdfjs/pdf.min.mjs", "pdfjs/pdf.worker.min.mjs"]) }; })();'],
	])('refuses a manifest with %s', (_, manifest) => {
		const found = errors(pinned({ [MANIFEST]: manifest }));
		expect(found.join('\n')).toMatch(/manifest\.js: Kit's server manifest is not exactly one exported manifest with one literal assets set: /);
		expect(found).toContain(`hosted-artifact: ${PDF}: pdfjs/pdf.min.mjs is not a static asset in Kit's server manifest`);
	});
	it('refuses a server module that reaches a pinned file through a proven forwarder', () => {
		const found = errors(pinned({ [SERVER]: 'var load = (m) => import(m); export const p = () => load("../../../cloudflare/pdfjs/pdf.min.mjs");' }));
		expect(found).toContain(`hosted-artifact: ${SERVER}: imports the browser-only PDF.js module ../../../cloudflare/pdfjs/pdf.min.mjs`);
		expect(found).toContain(`hosted-artifact: ${PDF}: reachable from the Worker (${SERVER} -> ${PDF})`);
	});
});
