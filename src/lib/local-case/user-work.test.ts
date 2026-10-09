// User work persists outside results: notes re-attach by original fingerprint (never by ref alone), seed overlays
// follow GRS-10's viewSeeds states, register rows keep stable ids, and nothing changes on activation or restart.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCase, putOriginal, row } from '../../../tests/e2e/pilot/lib/fixtures.ts';
import type { LocalCase } from './service.server.ts';
import { ackFor, cleanup, service, tempRoot } from './test-support.ts';
import { UserWorkError } from './user-work.server.ts';

const roots: string[] = [];
const open: LocalCase[] = [];
afterEach(async () => {
	for (const lc of open.splice(0)) lc.shutdown();
	for (const r of roots.splice(0)) await cleanup(r);
});
async function setup(tag: string) {
	const root = await tempRoot(tag);
	roots.push(root);
	const lc = service(path.join(root, 'data'));
	open.push(lc);
	await lc.startup();
	return { root, lc, dataDir: path.join(root, 'data') };
}
const rename = (from: string, to: string) => (r: { DATA: Record<string, unknown> }) => {
	for (const row of r.DATA.chronology as { ref: string }[]) if (row.ref === from) row.ref = to;
};

describe('notes', () => {
	it('survive activation of a renumbered version and restart, re-attached by fingerprint; a reused ref does not carry them', async () => {
		const { root, lc, dataDir } = await setup('notes');
		const v1 = await buildCase(path.join(root, 'v1'));
		const i1 = await lc.importPackage(v1.caseDir, v1.pkgDir);
		expect(await lc.activate(v1.resultsVersion, ackFor(lc, i1.importId))).toBeNull();
		const note = await lc.userWork.addNote('e2e-case', v1.resultsVersion, 'OD-001', 'Check clause 4');
		expect(note.status).toBe('here');
		expect(note.anchorSha256).toMatch(/^[0-9a-f]{64}$/);

		// v2: OD-001's bytes now carry ref OD-009, and the ref OD-001 is reused for SD-001's bytes; rows reordered
		const v2 = await buildCase(path.join(root, 'v2'), {
			caseDir: v1.caseDir,
			edit: (r) => {
				const rows = r.DATA.chronology as { ref: string; url: string; filename: string; size: number }[];
				const od1 = rows.find((x) => x.ref === 'OD-001')!, sd1 = rows.find((x) => x.ref === 'SD-001')!;
				od1.ref = 'OD-009';
				sd1.ref = 'OD-001';
				rows.reverse();
			},
		});
		const i2 = await lc.importPackage(v1.caseDir, v2.pkgDir);
		const preview = lc.userWork.summary('e2e-case', v2.resultsVersion);
		expect(preview).toMatchObject({ total: 1, exact: 1 });
		expect(preview.byRef).toEqual([{ ref: 'OD-009', n: 1, status: 'exact' }]);
		expect(await lc.activate(v2.resultsVersion, ackFor(lc, i2.importId))).toBeNull();
		expect(lc.userWork.notesFor('e2e-case', v2.resultsVersion, 'OD-009').map((n) => [n.id, n.status, n.body])).toEqual([[note.id, 'exact', 'Check clause 4']]);
		expect(lc.userWork.notesFor('e2e-case', v2.resultsVersion, 'OD-001')).toEqual([]); // the reused ref names other bytes

		lc.shutdown();
		open.splice(open.indexOf(lc), 1);
		const again = service(dataDir);
		open.push(again);
		await again.startup();
		expect(again.currentActive()?.vid).toBe(v2.resultsVersion);
		expect(again.userWork.notesFor('e2e-case', v2.resultsVersion, 'OD-009').map((n) => [n.id, n.intact])).toEqual([[note.id, true]]);
		expect(again.userWork.notesFor('e2e-case', v1.resultsVersion, 'OD-001').map((n) => n.status)).toEqual(['here']);
	});

	it('discloses ambiguous fingerprints and documents without an original', async () => {
		const { root, lc } = await setup('ambig');
		const pdf = new TextEncoder().encode('%PDF-1.4\n% one shared body\n%%EOF\n');
		const v1 = await buildCase(path.join(root, 'v1'), { originals: { 'X/A.pdf': pdf }, rows: [row('XA-001', 50, 'X/A.pdf', pdf.byteLength)] });
		await lc.importPackage(v1.caseDir, v1.pkgDir);
		await lc.userWork.addNote('e2e-case', v1.resultsVersion, 'XA-001', 'shared bytes');
		await lc.userWork.addNote('e2e-case', v1.resultsVersion, 'OD-003', 'on a scan');
		// v2 has a second ref with byte-identical content
		await putOriginal(v1.caseDir, 'X/B.pdf', pdf);
		const v2 = await buildCase(path.join(root, 'v2'), { caseDir: v1.caseDir, rows: [row('XA-001', 50, 'X/A.pdf', pdf.byteLength), row('XB-001', 51, 'X/B.pdf', pdf.byteLength)] });
		await lc.importPackage(v1.caseDir, v2.pkgDir);
		const on = lc.userWork.notesFor('e2e-case', v2.resultsVersion, 'XB-001');
		expect(on.map((n) => [n.body, n.status, n.candidates])).toEqual([['shared bytes', 'ambiguous', ['XA-001', 'XB-001']]]);
		const s = lc.userWork.summary('e2e-case', v2.resultsVersion);
		expect(s.ambiguous).toBe(1);
		// OD-003 has an original too; a note on a document without one stays in its own version
		expect(s.total).toBe(2);
	});

	it('rejects empty or oversized notes and unknown documents; flags a body altered on disk', async () => {
		const { root, lc } = await setup('nval');
		const v = await buildCase(path.join(root, 'v'));
		await lc.importPackage(v.caseDir, v.pkgDir);
		await expect(lc.userWork.addNote('e2e-case', v.resultsVersion, 'OD-001', '   ')).rejects.toBeInstanceOf(UserWorkError);
		await expect(lc.userWork.addNote('e2e-case', v.resultsVersion, 'OD-001', 'x'.repeat(20_001))).rejects.toBeInstanceOf(UserWorkError);
		await expect(lc.userWork.addNote('e2e-case', v.resultsVersion, 'NO-1', 'x')).rejects.toBeInstanceOf(UserWorkError);
		const n = await lc.userWork.addNote('e2e-case', v.resultsVersion, 'OD-001', 'original body');
		lc.storage.db().prepare("UPDATE work.note SET body = 'tampered body' WHERE id = ?").run(n.id);
		expect(lc.userWork.notesFor('e2e-case', v.resultsVersion, 'OD-001')[0]!.intact).toBe(false);
		expect(await lc.userWork.deleteNote('e2e-case', n.id)).toBe(true);
		expect(await lc.userWork.deleteNote('other-case', n.id)).toBe(false);
	});
});

describe('seed overlays and registers', () => {
	it('keeps edits by stable seed id across reordered seeds and shows a conflict when the seed changed', async () => {
		const { root, lc } = await setup('seeds');
		const v1 = await buildCase(path.join(root, 'v1'));
		const i1 = await lc.importPackage(v1.caseDir, v1.pkgDir);
		expect(await lc.activate(v1.resultsVersion, ackFor(lc, i1.importId))).toBeNull();
		const seeds = lc.userWork.seedRows(v1.resultsVersion);
		expect(seeds.length).toBeGreaterThanOrEqual(2);
		const target = seeds[0]!;
		await lc.userWork.putSeedOverlay({ caseId: 'e2e-case', datasetKey: target.datasetKey, seedId: target.seedId, baseSeedSha256: target.seedSha256, fields: { status: 'Served' } });
		expect(lc.userWork.seedViews('e2e-case', v1.resultsVersion).find((s) => s.state !== 'seed')?.state).toBe('edited');

		// v2: same seeds in reverse order -> the edit still applies to the same seed
		const reorder = (r: { DATA: Record<string, any> }) => { for (const k of Object.keys(r.DATA)) if (Array.isArray(r.DATA[k]?.registerSeed)) r.DATA[k].registerSeed.reverse(); if (Array.isArray(r.DATA.lit?.crossexam_seed)) r.DATA.lit.crossexam_seed.reverse(); (r.DATA.matter as any).short = 'R'; };
		const v2 = await buildCase(path.join(root, 'v2'), { caseDir: v1.caseDir, edit: reorder });
		await lc.importPackage(v1.caseDir, v2.pkgDir);
		const views2 = lc.userWork.seedViews('e2e-case', v2.resultsVersion);
		const e2 = views2.find((s) => s.state !== 'seed');
		expect(e2?.state).toBe('edited');
		expect(e2?.state === 'edited' && e2.seed.seedId).toBe(target.seedId);

		// v3: the seed's content changed (natural key kept) -> conflict, both shown
		const change = (r: { DATA: Record<string, any> }) => {
			const rec = { ...target.record } as Record<string, unknown>;
			const holder = target.datasetKey === 'filings' ? r.DATA.filings.registerSeed : r.DATA.lit.crossexam_seed;
			const keyFields = target.datasetKey === 'filings' ? ['ref', 'filing'] : ['witness', 'topic'];
			const hit = (holder as Record<string, unknown>[]).find((x) => keyFields.every((k) => x[k] === rec[k]))!;
			const free = Object.keys(hit).find((k) => !keyFields.includes(k) && typeof hit[k] === 'string')!;
			hit[free] = `${hit[free]} (revised)`;
		};
		const v3 = await buildCase(path.join(root, 'v3'), { caseDir: v1.caseDir, edit: change });
		await lc.importPackage(v1.caseDir, v3.pkgDir);
		const c3 = lc.userWork.seedViews('e2e-case', v3.resultsVersion).find((s) => s.state !== 'seed');
		expect(c3?.state).toBe('conflict');
		expect(lc.userWork.overlays('e2e-case')[0]!.fields).toEqual({ status: 'Served' }); // activation and imports never rewrite user rows
	});

	it('register rows keep stable ids and validate their fields', async () => {
		const { root, lc } = await setup('reg');
		const id1 = await lc.userWork.putRow('e2e-case', 'privilege-log', null, { ref: 'OD-002', basis: 'Legal advice', page: 3 });
		const id2 = await lc.userWork.putRow('e2e-case', 'privilege-log', null, { ref: 'SD-010', basis: 'Litigation' });
		expect(await lc.userWork.deleteRow('e2e-case', 'privilege-log', id1)).toBe(true);
		const rows = lc.userWork.listRows('e2e-case', 'privilege-log');
		expect(rows.map((r) => [r.rowId, r.fields.ref, r.intact])).toEqual([[id2, 'SD-010', true]]);
		await lc.userWork.putRow('e2e-case', 'privilege-log', id2, { ref: 'SD-010', basis: 'Changed' });
		expect(lc.userWork.listRows('e2e-case', 'privilege-log').map((r) => r.fields.basis)).toEqual(['Changed']);
		expect(lc.userWork.listRows('other-case', 'privilege-log')).toEqual([]);
		await expect(lc.userWork.putRow('e2e-case', 'Bad Store', null, {})).rejects.toBeInstanceOf(UserWorkError);
		await expect(lc.userWork.putRow('e2e-case', 'x', null, { nested: { a: 1 } as never })).rejects.toBeInstanceOf(UserWorkError);
		await expect(lc.userWork.putRow('e2e-case', 'x', null, JSON.parse('{"__proto__": 1}'))).rejects.toBeInstanceOf(UserWorkError);
		void root;
	});
});
