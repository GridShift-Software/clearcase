// CC-09-r2 regressions on the bundle views' store (synthetic cases, a real work.sqlite): the write queue and column
// patching (D3: a tick and an O on one file from two tabs under a held lock both survive), the Copy/Original conflict
// (D3), a lock taken by another process part-way through a multi-file write (D6), and CaseLines link order (D17).
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { cleanup, service, tempRoot, withoutBusyWait } from '../../src/lib/local-case/test-support.ts';
import type { LocalCase } from '../../src/lib/local-case/service.server.ts';

const g = globalThis as { __clearcase?: unknown };
const roots: string[] = [];
const open: LocalCase[] = [];
afterAll(async () => { for (const l of open) try { l.shutdown(); } catch { /* closed */ } for (const r of roots) await cleanup(r); });
async function fresh(tag: string) {
	const root = await tempRoot(tag); roots.push(root);
	const lc = service(path.join(root, 'data')); open.push(lc);
	g.__clearcase = { app: lc, originals: null, id: tag, startedAt: '', build: null };
	vi.resetModules();
	const s = await import('../../src/lib/views/bundles/store.server.ts');
	await s.marksTable();
	return { lc, s, root };
}
/** Hold work.sqlite's write lock from another connection (busy_timeout 0, BEGIN IMMEDIATE) until release(). */
const hold = (root: string) => { const d = new DatabaseSync(path.join(root, 'data', 'work.sqlite')); d.exec('PRAGMA busy_timeout=0'); d.exec('BEGIN IMMEDIATE'); return () => { d.exec('ROLLBACK'); d.close(); }; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('D3: two tabs on one file while the store is busy', () => {
	it('a tick (tab 1) and an O (tab 2) on a file without a row both survive a held lock', async () => {
		const { s, root } = await fresh('r2-two-tabs');
		const release = hold(root);
		const t1 = s.writeMarks('case-1', [{ locator: 'F/a.pdf' }], { selected: true });
		await sleep(300);
		const t2 = s.writeMarks('case-1', [{ locator: 'F/a.pdf', base: null }], { co: 'O' });
		await sleep(1500);
		release();
		expect((await t1).saved).toEqual(['F/a.pdf']);
		expect(await t2).toEqual({ saved: ['F/a.pdf'], conflicts: [] });
		expect(await s.readMarks('case-1')).toEqual([{ locator: 'F/a.pdf', selected: true, co: 'O' }]);
	}, 60_000);
	it('a Copy/Original change over another tab\'s different mark is refused with nothing written, and the stored mark named', async () => {
		const { s } = await fresh('r2-co-conflict');
		await s.writeMarks('case-1', [{ locator: 'F/a.pdf', base: null }], { co: 'C' }); // tab 1
		const r = await s.writeMarks('case-1', [{ locator: 'F/a.pdf', base: null }, { locator: 'F/b.pdf', base: null }], { co: 'O' }); // tab 2, loaded before
		expect(r).toEqual({ saved: [], conflicts: [{ locator: 'F/a.pdf', stored: 'C' }] });
		expect(await s.readMarks('case-1')).toEqual([{ locator: 'F/a.pdf', selected: false, co: 'C' }]);
		// Retry with the stored mark as the base saves tab 2's marks over it
		expect((await s.writeMarks('case-1', [{ locator: 'F/a.pdf', base: 'C' }, { locator: 'F/b.pdf', base: null }], { co: 'O' })).saved).toEqual(['F/a.pdf', 'F/b.pdf']);
		// the same mark set twice is no conflict
		expect((await s.writeMarks('case-1', [{ locator: 'F/a.pdf', base: null }], { co: 'O' })).conflicts).toEqual([]);
	});
	it('the header recheck: the fields-hash changes with the stored fields, not with time', async () => {
		const { s } = await fresh('r2-hash');
		const h0 = s.singleHash('case-1', s.HEADER_STORE);
		await s.putSingle('case-1', s.HEADER_STORE, { court: 'Synthetic court' });
		const h1 = s.singleHash('case-1', s.HEADER_STORE);
		await s.putSingle('case-1', s.HEADER_STORE, { court: 'Synthetic court' });
		expect(h1).not.toBe(h0);
		expect(s.singleHash('case-1', s.HEADER_STORE)).toBe(h1);
	});
});

describe('D6: a lock taken by another process part-way through a multi-file write', () => {
	it('reports exactly the files saved, never "Not saved"; a Retry of the rest finishes the change', async () => {
		const { lc, s, root } = await fresh('r2-partial');
		const keys = ['F/1.pdf', 'F/2.pdf', 'F/3.pdf', 'F/4.pdf'];
		const uw = lc.userWork as unknown as { putTableRow: (...a: unknown[]) => Promise<void> };
		const orig = uw.putTableRow.bind(uw);
		let release: (() => void) | null = null;
		uw.putTableRow = async (...a: unknown[]) => { await orig(...a); release ??= hold(root); };
		let err: unknown = null;
		const wait = withoutBusyWait(lc.storage);
		try { await s.writeMarks('case-1', keys.map((locator) => ({ locator })), { selected: true }); } catch (e) { err = e; }
		release!();
		wait();
		uw.putTableRow = orig;
		expect(err).toBeInstanceOf(s.PartialWrite);
		const saved = (err as InstanceType<typeof s.PartialWrite>).saved;
		const stored = (await s.readMarks('case-1')).filter((m) => m.selected).map((m) => m.locator);
		expect(saved).toEqual(stored);
		expect(saved).toEqual(['F/1.pdf']);
		const r = (await s.guarded({}, async () => { throw err; })) as unknown as { status: number; data: { message: string; saved: string[] } };
		expect(r.status).toBe(503);
		expect(r.data.message).toMatch(/^Partly saved: 1 file saved, then the case store was busy .*Retry saves them\.$/);
		expect(r.data.message).not.toMatch(/Not saved|nothing was written/);
		expect(r.data.saved).toEqual(['F/1.pdf']);
		await s.writeMarks('case-1', keys.filter((k) => !saved.includes(k)).map((locator) => ({ locator })), { selected: true });
		expect((await s.readMarks('case-1')).filter((m) => m.selected)).toHaveLength(4);
	}, 60_000);
});

describe('D17: CaseLines links saved while the store is busy', () => {
	it('two links posted under a held lock get distinct seq in submission order', async () => {
		const { lc, s, root } = await fresh('r2-seq');
		const release = hold(root);
		const a = s.addLink('case-1', 'Synthetic/first.pdf');
		await sleep(100);
		const b = s.addLink('case-1', 'Synthetic/second.pdf');
		await sleep(1200);
		release();
		await Promise.all([a, b]);
		const rows = lc.userWork.listRows('case-1', s.LINKS_STORE).map((r) => [r.fields.path, r.fields.seq]).sort((x, y) => Number(x[1]) - Number(y[1]));
		expect(rows).toEqual([['Synthetic/first.pdf', 1], ['Synthetic/second.pdf', 2]]);
	}, 60_000);
});
