// A register entry's document anchor across two results versions (GRS-17, PR #18 review): driven through two synthetic
// converted packages and the real import, activation, store, load and save code. (a) An edit of another field keeps
// the entry on the original it was made on, though the new version reuses its ref for a different original; (b) an
// entry made when its original was missing is never linked to whatever the new version calls by the same ref.
process.env.TZ = 'UTC';
process.env.CLEARCASE_FIXED_NOW = '2026-10-08T09:00:00Z';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCase } from '../e2e/pilot/lib/fixtures';
import type { SynthRoots } from '../case-package/fixtures/synth';
import type { LocalCase } from '../../src/lib/local-case/service.server';
import { ackFor, cleanup, tempRoot } from '../../src/lib/local-case/test-support';

let root: string, lc: LocalCase;
let P: typeof import('../../src/lib/views/registers/page.server');
const env = { ...process.env };
const AGREEMENT = 'DISCOVERY A/OD-001 Supply agreement.pdf';
beforeAll(async () => {
	root = await tempRoot('registers-anchors');
	Object.assign(process.env, { CLEARCASE_DATA_DIR: path.join(root, 'data'), PORT: '1', CLEARCASE_USERWORK_BACKUP_DELAY_MS: '60000' });
	const { app } = await import('../../src/lib/local-case/app.server');
	P = await import('../../src/lib/views/registers/page.server');
	lc = app();
	const lock = lc.storage.acquireInstanceLock();
	if (!lock.ok) throw new Error(lock.reason);
	await lc.startup();
}, 120_000);
afterAll(async () => {
	const g = globalThis as { __clearcase?: { app: LocalCase } };
	g.__clearcase?.app.shutdown();
	delete g.__clearcase;
	process.env = env;
	if (root) await cleanup(root);
});

/** Import and activate one synthetic package; returns its results version and case id. */
async function importAndActivate(c: Awaited<ReturnType<typeof buildCase>>) {
	const imp = await lc.importPackage(c.caseDir, c.pkgDir);
	expect(await lc.activate(c.resultsVersion, ackFor(lc, imp.importId))).toBeNull();
	return { rv: c.resultsVersion, caseId: lc.store.getVersion(c.resultsVersion)!.case_id };
}

type View = Parameters<typeof P.registerActions>[0];
async function post(rv: string, view: View, fields: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.set(k, v);
	const request = new Request(`http://127.0.0.1/v/${rv}/registers/${view}?/save`, { method: 'POST', body: fd });
	const r = (await (P.registerActions(view).save as (e: unknown) => Promise<unknown>)({ params: { vid: rv }, request })) as { status?: number; data?: Record<string, unknown> } & Record<string, unknown>;
	return r && typeof r.status === 'number' && 'data' in r ? { failed: r.status, ...r.data } : { ok: true, ...r };
}
type Loaded = { rows: { rowId: string; version: string; cells: { kind: string; text?: string; target?: string | null }[] }[] };
const load = async (rv: string, caseId: string, view: View) => (await P.registerLoad(view)({ parent: async () => ({ version: { id: rv, caseId } }) })) as Loaded;
const refCell = (l: Loaded, i = 0) => l.rows[i]!.cells.find((c) => c.kind === 'ref')!;

/** V2 calls the invoice OD-001 and the agreement OD-002: the same refs, swapped originals. */
const swapRefs = (r: SynthRoots) => {
	const ch = r.DATA.chronology as { ref: string }[];
	ch[0]!.ref = 'OD-002';
	ch[1]!.ref = 'OD-001';
};

describe('a register entry keeps its original across versions', () => {
	it.each([
		['annotations_tab', { ref: 'OD-001', date: '2026-10-01', note: 'Synthetic note' }, 'note', 'Synthetic note, edited'],
		['privilege_tab', { ref: 'OD-001', date: '2026-10-01', desc: 'Synthetic description', basis: 'Legal advice' }, 'desc', 'Synthetic description, edited'],
	] as const)('%s: editing only another field leaves the entry on the original it was made on', async (view, v0, field, edited) => {
		const v1 = await importAndActivate(await buildCase(path.join(root, `a-${view}-1`), { caseId: `anchor-a-${view}` }));
		const added = await post(v1.rv, view, v0);
		expect(added).toMatchObject({ ok: true, saved: true });
		// V2 swaps which original OD-001 names; the entry still points to the agreement, now called OD-002
		const c1 = path.join(root, `a-${view}-1`, 'case');
		const v2 = await importAndActivate(await buildCase(path.join(root, `a-${view}-2`), { caseId: `anchor-a-${view}`, caseDir: c1, edit: swapRefs }));
		expect(v2.rv).not.toBe(v1.rv);
		const before = await load(v2.rv, v2.caseId, view);
		expect(refCell(before)).toMatchObject({ text: 'OD-001', target: 'OD-002' });
		const row = before.rows[0]!;
		const saved = await post(v2.rv, view, { ...v0, [field]: edited, rowId: row.rowId, version: row.version });
		expect(saved).toMatchObject({ ok: true, saved: true });
		const after = await load(v2.rv, v2.caseId, view);
		expect(refCell(after)).toMatchObject({ text: 'OD-001', target: 'OD-002' });
	}, 120_000);

	it('annotations_tab: typing a different ref in V2 re-anchors to the original that ref names there', async () => {
		const view = 'annotations_tab' as const;
		const v1 = await importAndActivate(await buildCase(path.join(root, 'r-1'), { caseId: 'anchor-r' }));
		await post(v1.rv, view, { ref: 'OD-001', date: '2026-10-01', note: 'Synthetic note' });
		const v2 = await importAndActivate(await buildCase(path.join(root, 'r-2'), { caseId: 'anchor-r', caseDir: path.join(root, 'r-1', 'case'), edit: swapRefs }));
		const row = (await load(v2.rv, v2.caseId, view)).rows[0]!;
		await post(v2.rv, view, { ref: 'OD-003', date: '2026-10-01', note: 'Synthetic note', rowId: row.rowId, version: row.version });
		expect(refCell(await load(v2.rv, v2.caseId, view))).toMatchObject({ text: 'OD-003', target: 'OD-003' });
	}, 120_000);

	it('annotations_tab: an entry made on a missing original is not linked to the document V2 gives that ref', async () => {
		const view = 'annotations_tab' as const;
		// V1: OD-001's original is not in the case folder, so the entry has no fingerprint to follow
		const v1 = await importAndActivate(await buildCase(path.join(root, 'b-1'), { caseId: 'anchor-b', originals: { [AGREEMENT]: null } }));
		await post(v1.rv, view, { ref: 'OD-001', date: '2026-10-01', note: 'Synthetic note' });
		expect(refCell(await load(v1.rv, v1.caseId, view))).toMatchObject({ text: 'OD-001', target: 'OD-001' });
		// V2: OD-001 is a different, present original
		const v2 = await importAndActivate(await buildCase(path.join(root, 'b-2'), { caseId: 'anchor-b', originals: { [AGREEMENT]: new TextEncoder().encode('%PDF-1.4\n% another synthetic original\n%%EOF\n') } }));
		expect(v2.rv).not.toBe(v1.rv);
		expect(refCell(await load(v2.rv, v2.caseId, view))).toMatchObject({ text: 'OD-001', target: null });
	}, 120_000);
});
