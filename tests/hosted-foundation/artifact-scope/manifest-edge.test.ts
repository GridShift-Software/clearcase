import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanArtifact } from '../../../scripts/ci/hosted-artifact.ts';
import { manifestAssets } from '../../../scripts/ci/hosted-artifact-scope.ts';

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
