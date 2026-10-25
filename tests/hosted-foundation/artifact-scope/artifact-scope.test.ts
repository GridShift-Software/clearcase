import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanArtifact } from '../../../scripts/ci/hosted-artifact.ts';
import { PINNED_BROWSER_MODULES } from '../../../scripts/ci/hosted-artifact-scope.ts';
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
