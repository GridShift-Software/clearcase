// Rescan & Update (GRS-20) on the synthetic v5-shaped case: a repeat scan is idempotent, same-prefix additions get
// distinct refs, a same-name same-size change is found by a full scan only, removed originals are reported,
// processing-pending state survives a rescan, and a quick scan never claims the analysis is current.
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCase, putOriginal } from '../e2e/pilot/lib/fixtures.ts';
import { documentRows } from '../../src/lib/local-case/documents.server.ts';
import { additions, clearAdditions, ensureRescanProvider, FILE_TABLE, rescan, rescanRows, walk } from '../../src/lib/local-case/rescan/rescan.server.ts';
import { compare, dateFromName, docTypeOf, folderRules } from '../../src/lib/local-case/rescan/rules.ts';
import type { LocalCase } from '../../src/lib/local-case/service.server.ts';
import { ackFor, cleanup, service, tempRoot } from '../../src/lib/local-case/test-support.ts';

let root: string, lc: LocalCase, rv: string, caseDir: string, caseId: string;
const bytes = (s: string) => new TextEncoder().encode(s);

beforeAll(async () => {
	root = await tempRoot('rescan');
	lc = service(path.join(root, 'data'));
	await lc.startup();
	const c = await buildCase(path.join(root, 'v1'));
	const i = await lc.importPackage(c.caseDir, c.pkgDir);
	expect(await lc.activate(c.resultsVersion, ackFor(lc, i.importId!))).toBeNull();
	rv = c.resultsVersion;
	caseDir = c.caseDir;
	caseId = lc.store.getVersion(rv)!.case_id;
	ensureRescanProvider(lc);
}, 60_000);
afterAll(async () => { lc?.shutdown(); if (root) await cleanup(root); });

const stored = () => lc.userWork.listTableRows(FILE_TABLE, { caseId });

describe('rescan of the synthetic case', () => {
	it('an unchanged folder scanned twice: nothing added, no row written, the second scan returns the same rows', async () => {
		const a = await rescan(lc, rv, 'quick');
		expect(a.counts).toMatchObject({ scanned: 7, indexed: 7, added: 0, changed: 0, removed: 0 });
		const before = stored();
		const b = await rescan(lc, rv, 'quick');
		expect(b.rows).toEqual(a.rows);
		expect(stored()).toEqual(before);
		expect(before).toEqual([]);
	});

	it('a quick scan never claims the analysis is current; a full scan of an unchanged folder does', async () => {
		const q = await rescan(lc, rv, 'quick');
		expect([q.current, q.verdict]).toEqual([false, expect.stringContaining('contents were not compared')]);
		const f = await rescan(lc, rv, 'full');
		expect([f.current, f.counts.changed]).toEqual([true, 0]);
	});

	it('several same-prefix additions get distinct refs that continue the case numbering, stable on a repeat scan', async () => {
		await putOriginal(caseDir, 'DISCOVERY A/OD-005 Letter 2001-03-04.pdf', bytes('%PDF-1.4 a'));
		await putOriginal(caseDir, 'DISCOVERY A/OD-005 Letter copy.pdf', bytes('%PDF-1.4 b'));
		await putOriginal(caseDir, 'DISCOVERY A/sub/Invoice 2001.pdf', bytes('%PDF-1.4 c'));
		await putOriginal(caseDir, 'MAIL/EM-0003 Reply.eml', bytes('Subject: x\r\n\r\ny'));
		const r = await rescan(lc, rv, 'quick');
		const added = r.rows.filter((x) => x.kind === 'added');
		expect(added.map((x) => [x.path, x.ref, x.bundle])).toEqual([
			['DISCOVERY A/OD-005 Letter 2001-03-04.pdf', 'OD-005', 'Original'],
			['DISCOVERY A/OD-005 Letter copy.pdf', 'OD-006', 'Original'],
			['DISCOVERY A/sub/Invoice 2001.pdf', 'OD-007', 'Original'],
			['MAIL/EM-0003 Reply.eml', 'EM-0003', 'Correspondence'],
		]);
		expect(added.map((x) => [x.date, x.docType, x.processing])).toEqual([['2001-03-04', 'other', 'pending'], ['', 'other', 'pending'], ['', 'invoice', 'pending'], ['', 'email', 'pending']]);
		const again = await rescan(lc, rv, 'quick');
		expect(again.rows).toEqual(r.rows);
		expect(again.counts.newlyAdded).toBe(0);
		// published through the document-row read contract, after the imported rows, with no duplicate ref
		const d = documentRows(lc.store, rv);
		const refs = d.rows.map((x) => x.ref);
		expect(new Set(refs).size).toBe(refs.length);
		expect(d.rows.filter((x) => x.source === 'provider:rescanned').map((x) => x.ref)).toEqual(['OD-005', 'OD-006', 'OD-007', 'EM-0003']);
		expect(d.dropped).toEqual([]);
		expect(d.rows.find((x) => x.ref === 'OD-005')?.state.flags).toContain('processing-pending');
	});

	it('a same-name, same-size content change: a quick scan cannot see it, a full scan reports it, a later quick scan keeps it', async () => {
		const rel = 'DISCOVERY A/OD-001 Supply agreement.pdf';
		const old = await readFile(path.join(caseDir, rel));
		const changed = Buffer.from(old);
		changed[changed.length - 2] ^= 1;
		await writeFile(path.join(caseDir, rel), changed);
		const q = await rescan(lc, rv, 'quick');
		expect(q.rows.some((x) => x.kind === 'changed')).toBe(false);
		expect(q.current).toBe(false);
		const f = await rescan(lc, rv, 'full');
		expect(f.rows.filter((x) => x.kind === 'changed').map((x) => [x.ref, x.evidence])).toEqual([['OD-001', 'sha256']]);
		expect(f.current).toBe(false);
		const q2 = await rescan(lc, rv, 'quick');
		expect(q2.rows.filter((x) => x.kind === 'changed').map((x) => x.ref)).toEqual(['OD-001']);
		await writeFile(path.join(caseDir, rel), old);
		const back = await rescan(lc, rv, 'full');
		expect(back.rows.some((x) => x.kind === 'changed')).toBe(false);
	});

	it('a size change is found by a quick scan', async () => {
		const rel = 'DISCOVERY B/SD-001 Statement.pdf';
		const old = await readFile(path.join(caseDir, rel));
		await writeFile(path.join(caseDir, rel), Buffer.concat([old, Buffer.from(' ')]));
		const q = await rescan(lc, rv, 'quick');
		expect(q.rows.filter((x) => x.kind === 'changed').map((x) => [x.ref, x.evidence])).toEqual([['SD-001', 'size']]);
		await writeFile(path.join(caseDir, rel), old);
		expect((await rescan(lc, rv, 'quick')).rows.some((x) => x.kind === 'changed')).toBe(false);
	});

	it('a removed original is reported by ref, and stops being reported when it is back', async () => {
		const rel = 'DISCOVERY A/OD-003 Scan.pdf';
		const old = await readFile(path.join(caseDir, rel));
		await rm(path.join(caseDir, rel));
		const r = await rescan(lc, rv, 'quick');
		expect(r.rows.filter((x) => x.kind === 'removed').map((x) => [x.ref, x.path])).toEqual([['OD-003', rel]]);
		expect(r.counts.removed).toBe(1);
		// the imported row is results: it stays, unchanged
		expect(documentRows(lc.store, rv).rows.find((x) => x.ref === 'OD-003')?.source).toBe('results');
		await writeFile(path.join(caseDir, rel), old);
		expect((await rescan(lc, rv, 'quick')).counts.removed).toBe(0);
	});

	it('processing-pending state is kept: imported pending text stays pending, additions stay pending over rescans', async () => {
		await rescan(lc, rv, 'full');
		await rescan(lc, rv, 'quick');
		const d = documentRows(lc.store, rv);
		expect(d.rows.find((x) => x.ref === 'EM-0002')?.list.textStatus).toBe('pending');
		expect(rescanRows(lc, caseId, rv).filter((x) => x.kind === 'added').every((x) => x.processing === 'pending')).toBe(true);
	});

	it('an addition that disappears keeps its ref issued; clearing additions never lets a ref be issued twice', async () => {
		await rm(path.join(caseDir, 'DISCOVERY A/sub/Invoice 2001.pdf'));
		const r = await rescan(lc, rv, 'quick');
		expect(r.rows.find((x) => x.ref === 'OD-007')?.kind).toBe('withdrawn');
		expect(additions(lc, caseId, rv).map((x) => x.ref)).toEqual(['OD-005', 'OD-006', 'EM-0003']);
		expect(await clearAdditions(lc, rv)).toBe(3);
		expect(additions(lc, caseId, rv)).toEqual([]);
		const again = await rescan(lc, rv, 'quick');
		expect(again.rows.filter((x) => x.kind === 'added').map((x) => x.ref)).toEqual(['OD-008', 'OD-009', 'EM-0004']);
	});

	it('the walk skips hidden entries and a processing package folder', async () => {
		await putOriginal(caseDir, '.hidden/x.pdf', bytes('x'));
		await putOriginal(caseDir, 'pkg-copy/manifest.json', bytes('{}'));
		await putOriginal(caseDir, 'pkg-copy/assets.json', bytes('{}'));
		const w = await walk(caseDir);
		expect(w.files.some((f) => f.path.startsWith('.hidden') || f.path.startsWith('pkg-copy'))).toBe(false);
	});
});

describe('rescan rules', () => {
	it('dates from file names follow v5 but must be real dates', () => {
		expect([dateFromName('2001-2-3 note.pdf'), dateFromName('3.2.2001.pdf'), dateFromName('no date.pdf'), dateFromName('2001-13-40.pdf')]).toEqual(['2001-02-03', '2001-02-03', '', '']);
	});
	it('types and bundles follow v5 where the case gives no better rule', () => {
		expect([docTypeOf('a.MSG'), docTypeOf('Invoice 12.pdf'), docTypeOf('x.docx')]).toEqual(['email', 'invoice', 'other']);
		const rules = folderRules([]);
		expect([rules('SUPPLEMENTARY/x.pdf'), rules('Pleadings 1/x.pdf'), rules('x.pdf')]).toEqual([{ prefix: 'SD', bundle: 'Supplementary' }, { prefix: 'PN', bundle: 'Pleadings' }, { prefix: 'OD', bundle: 'Original' }]);
	});
	it("a v5-style './'-encoded path and the walked path are one file (S-rescan_tab-1)", () => {
		const out = compare({ mode: 'quick', walked: [{ path: 'A B/x.pdf', size: 1, mtimeMs: 1 }], indexed: [{ ref: 'OD-001', path: 'A B/x.pdf', size: 1, sha256: null, bundle: 'Original' }], previous: [], issued: {}, takenRefs: new Set(['OD-001']) });
		expect(out.rows).toEqual([]);
	});
});
