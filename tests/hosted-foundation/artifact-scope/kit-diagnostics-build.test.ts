import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { scanArtifact } from '../../../scripts/ci/hosted-artifact.ts';
import { adaptKitDiagnostics, hostedKitDiagnosticsBuild, KIT_DIAGNOSTIC_MODULES } from '../../../scripts/hosted-kit-diagnostics-build.ts';
import { scopeFixtureDependencies } from './fixture-dependencies.ts';

const REPO = path.resolve(import.meta.dirname, '../../..');
const KIT = path.join(REPO, 'node_modules/@sveltejs/kit');
const installed = (module: string) => readFileSync(path.join(KIT, module), 'utf8');
const temp: string[] = [];
afterAll(() => { for (const d of temp.splice(0)) rmSync(d, { recursive: true, force: true }); });
function serverArtifact(files: Record<string, string>) {
	const root = mkdtempSync(path.join(os.tmpdir(), 'cc-kit-diagnostics-')); temp.push(root);
	for (const [name, body] of Object.entries({ ...scopeFixtureDependencies, '.svelte-kit/cloudflare/_worker.js': 'export default { fetch() {} };', ...files })) {
		mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), body);
	}
	return scanArtifact({ root, profile: 'production' }).errors;
}

describe('hosted Kit diagnostics build adaptation', () => {
	it('adapts each installed module to its pinned output with no process reach left', () => {
		for (const module of Object.keys(KIT_DIAGNOSTIC_MODULES)) {
			const code = adaptKitDiagnostics(module, installed(module));
			expect(code).not.toMatch(/process\?\.(?:getBuiltinModule|cwd)/);
			expect(serverArtifact({ [`.svelte-kit/output/server/chunks/${path.basename(module)}`]: code })).toEqual([]);
		}
	});
	it('keeps Kit\'s own non-Node fallbacks, not a successful fs, SourceMap or styleText', () => {
		const sourcemaps = adaptKitDiagnostics('src/runtime/server/sourcemaps.js', installed('src/runtime/server/sourcemaps.js'));
		for (const m of ['fs', 'url', 'path', 'module']) expect(sourcemaps).toContain(`const ${m} = undefined;`);
		expect(sourcemaps).toContain('const cwd = undefined;');
		expect(sourcemaps).toContain('if (!error.stack || !fs) return;');
		const internal = adaptKitDiagnostics('src/runtime/server/internal.js', installed('src/runtime/server/internal.js'));
		expect(internal).toContain('undefined?.styleText ??\n\t/** @type {(format: unknown, text: string) => string} */ ((_format, text) => text);');
	});
	it.each([
		['one changed byte', (s: string) => s.replace('best-effort', 'best effort')],
		['a probe already removed', (s: string) => s.replace("globalThis.process?.getBuiltinModule?.('node:fs')", 'undefined')],
		['an extra probe', (s: string) => s + "\nconst fs2 = globalThis.process?.getBuiltinModule?.('node:fs');"],
	])('refuses a sourcemaps.js input with %s', (_, change) => {
		expect(() => adaptKitDiagnostics('src/runtime/server/sourcemaps.js', change(installed('src/runtime/server/sourcemaps.js')))).toThrow(/not the reviewed Kit 3\.1\.0 input/);
	});
	it('refuses any other module', () => {
		expect(() => adaptKitDiagnostics('src/runtime/server/index.js', installed('src/runtime/server/index.js'))).toThrow(/not a Kit diagnostic module/);
	});
	it('is absent from the local target', () => {
		expect(hostedKitDiagnosticsBuild({ root: REPO, target: 'local' })).toBeUndefined();
	});
	// A two-module server bundle: the entry re-exports the Kit modules, and every other import stays external.
	async function bundle(ids: string[]) {
		const out = mkdtempSync(path.join(os.tmpdir(), 'cc-kit-diagnostics-bundle-')); temp.push(out);
		const entry = path.join(out, 'entry.js');
		writeFileSync(entry, ids.map((id, i) => `export * as m${i} from ${JSON.stringify(id)};`).join('\n'));
		await build({
			configFile: false, root: out, logLevel: 'silent', define: { __SVELTEKIT_DEV__: 'false' },
			plugins: [hostedKitDiagnosticsBuild({ root: REPO, target: 'hosted' }), { name: 'externals', resolveId: (id, importer) => importer && importer !== entry && !ids.includes(path.resolve(path.dirname(importer), id)) ? { id, external: true } : undefined }],
			build: { ssr: entry, outDir: path.join(out, '.svelte-kit/output/server'), emptyOutDir: true, minify: false, rollupOptions: { output: { entryFileNames: 'index.js' } } },
		});
		return out;
	}
	it('adapts both modules in a real Vite server bundle, which the artifact scan then passes', async () => {
		const out = await bundle(Object.keys(KIT_DIAGNOSTIC_MODULES).map((m) => path.join(KIT, m)));
		const emitted = readFileSync(path.join(out, '.svelte-kit/output/server/index.js'), 'utf8');
		expect(emitted).toContain('fix_stack_trace');
		expect(emitted).not.toMatch(/process\?\.(?:getBuiltinModule|cwd)/);
		mkdirSync(path.join(out, '.svelte-kit/cloudflare'), { recursive: true }); writeFileSync(path.join(out, '.svelte-kit/cloudflare/_worker.js'), 'export default {};');
		expect(scanArtifact({ root: out, profile: 'production' }).errors).toEqual([]);
	});
	it('refuses a server build that holds one Kit diagnostic module without the other', async () => {
		await expect(bundle([path.join(KIT, 'src/runtime/server/sourcemaps.js')])).rejects.toThrow(/src\/runtime\/server\/internal\.js is not in the server graph/);
	});
});
