// The bundle list's saved builder bundles (v5 `ess_dcs_custom_bundles_v1`) in a real work.sqlite: keyed by the builder
// output, not a list position; numbered C<i> past every saved and shipped number; saving again keeps the number and
// place; deleting one leaves the others' numbers alone; and each case keeps its own list.
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { cleanup, service, tempRoot } from '../../src/lib/local-case/test-support.ts';
import type { LocalCase } from '../../src/lib/local-case/service.server.ts';
import type { Custom } from '../../src/lib/bundles/builder.ts';

const g = globalThis as { __clearcase?: unknown };
const roots: string[] = [];
const open: LocalCase[] = [];
afterAll(async () => { for (const l of open) try { l.shutdown(); } catch { /* closed */ } for (const r of roots) await cleanup(r); });
async function fresh(tag: string) {
	const root = await tempRoot(tag); roots.push(root);
	const lc = service(path.join(root, 'data')); open.push(lc);
	g.__clearcase = { app: lc, originals: null, id: tag, startedAt: '', build: null };
	vi.resetModules();
	return import('../../src/lib/views/bundles/store.server.ts');
}
const entry = (name: string): Omit<Custom, 'no'> => ({
	name, pages: 5, indexPages: 1, filePages: 6, note: 'n',
	rows: [{ n: 1, key: '', desc: 'ALPHA', pages: 5, from: 1, to: 5, parts: [{ rel: 'a.pdf', url: '', name: 'a.pdf', from: 1, to: 5 }] }],
});

describe('saved builder bundles', () => {
	it('numbers past shipped and saved numbers, keeps number and place on a resave, and survives a delete of another', async () => {
		const s = await fresh('cc09-custom');
		const shipped = [{ no: 'C1' }, { no: '2' }];
		expect(await s.saveCustom('case-1', 'oa', entry('ONE'), shipped)).toBe('C2');
		expect(await s.saveCustom('case-1', 'ob', entry('TWO'), shipped)).toBe('C3');
		expect(await s.saveCustom('case-1', 'oa', entry('ONE AGAIN'), shipped)).toBe('C2');
		expect((await s.readCustom('case-1')).map((c) => [c.id, c.no, c.name])).toEqual([['oa', 'C2', 'ONE AGAIN'], ['ob', 'C3', 'TWO']]);
		await s.deleteCustom('case-1', 'oa');
		await s.deleteCustom('case-1', 'oa');
		const left = await s.readCustom('case-1');
		expect(left.map((c) => [c.id, c.no])).toEqual([['ob', 'C3']]);
		expect(left[0]!.rows[0]!.parts[0]).toEqual({ rel: 'a.pdf', url: '', name: 'a.pdf', from: 1, to: 5 });
		expect(await s.saveCustom('case-1', 'oc', entry('THREE'), shipped)).toBe('C2');
		expect(await s.readCustom('case-2')).toEqual([]);
	}, 60_000);
	it('two saves at once get distinct numbers', async () => {
		const s = await fresh('cc09-custom-race');
		const nos = await Promise.all(['o1', 'o2', 'o3'].map((id) => s.saveCustom('case-1', id, entry(id), [])));
		expect(new Set(nos).size).toBe(3);
	}, 60_000);
});
