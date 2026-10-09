// Per-view v5 specs: scripts/parity/adapters/v5/specs/<view-id>.mjs is discovered by dynamic import over the folder,
// in file-name order, next to the chronology and overview specs that stay in specs.mjs. Synthetic spec modules in a
// temp folder; nothing is committed to the real folder.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { loadSpecs, SPEC_DIR, SPECS } from '../../scripts/parity/adapters/v5/specs.mjs';
import { viewIds } from '../../scripts/parity/lib/register.mjs';

const root = mkdtempSync(join(tmpdir(), 'parity-specs-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function folder(files: Record<string, string>) {
	const dir = join(root, `s${n++}`);
	mkdirSync(dir);
	for (const [name, src] of Object.entries(files)) writeFileSync(join(dir, name), src);
	return dir;
}
const sweep = (id: string) => `{ id: '${id}', v5: async () => ({ 'a0': '1' }) }`;

describe('per-view spec discovery', () => {
	test('a module per view is loaded next to the specs kept in specs.mjs', async () => {
		const dir = folder({
			'people.mjs': `export default { key: 'name', sweeps: [${sweep('people_sort')}] };`,
			'documents.mjs': `import { registerSweep } from ${JSON.stringify(join(SPEC_DIR, '..', 'specs.mjs'))};\nexport default { sweeps: [${sweep('documents_filter')}], storage: { k: 'v' } };\nexport const helper = registerSweep.id;`,
			'_shared.mjs': 'throw new Error("helpers are not specs");',
			'notes.txt': 'not a module',
		});
		const specs = await loadSpecs(dir, { views: viewIds() });
		expect(Object.keys(specs)).toEqual(['overview', 'chronology', 'documents', 'people']);
		expect(specs.chronology).toBe(SPECS.chronology);
		expect(specs.overview).toBe(SPECS.overview);
		expect(specs.people.key).toBe('name');
		expect(specs.documents!.sweeps!.map((s) => s.id)).toEqual(['documents_filter']);
		expect(await specs.people!.sweeps![0]!.v5(null, {})).toEqual({ a0: '1' });
		expect(await loadSpecs(dir)).toBe(specs);
	});
	test('an absent folder gives the specs in specs.mjs alone', async () => {
		expect(await loadSpecs(join(root, 'absent'))).toEqual(SPECS);
	});
	test.each([
		['an unknown view id', { 'nope.mjs': 'export default {};' }, /nope is not a v5 navigation id/],
		['a view whose spec stays in specs.mjs', { 'chronology.mjs': 'export default {};' }, /chronology's spec is defined in specs.mjs/],
		['no default export', { 'people.mjs': 'export const x = 1;' }, /default export must be one SPECS entry/],
		['an unknown key', { 'people.mjs': 'export default { sweep: [] };' }, /unknown key sweep/],
		['a sweep without a v5 driver', { 'people.mjs': "export default { sweeps: [{ id: 'x' }] };" }, /each sweep needs an id and a v5 driver/],
	])('%s is refused', async (_, files, why) => {
		await expect(loadSpecs(folder(files))).rejects.toThrow(why);
	});
	test('the real folder holds only valid per-view specs, and the v5 adapter reads them', async () => {
		const specs = await loadSpecs();
		for (const v of Object.keys(specs)) expect(viewIds()).toContain(v);
		const { readFileSync } = await import('node:fs');
		expect(readFileSync(join(SPEC_DIR, '..', 'index.mjs'), 'utf8')).toMatch(/const spec = \(await loadSpecs\(\)\)\[view\] \?\? \{\};/);
	});
});
