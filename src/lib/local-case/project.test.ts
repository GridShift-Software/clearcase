// The projector keeps raw values raw, derives display fields without inventing any, and its digest covers every
// projected row.
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, importCandidate, type ImportResult } from '../case-package/index.ts';
import { buildCase, type SynthCase } from '../../../tests/e2e/pilot/lib/fixtures.ts';
import type { AttachmentRow, ChronologyListRow, DocumentStateRow, OverviewModel } from './model.ts';
import { project, readModelDigest, type Projection } from './project.server.ts';
import { datasetKeys, datasetOf } from './results.server.ts';
import { cleanup, service, tempRoot } from './test-support.ts';

let root: string, c: SynthCase, result: ImportResult & { verdict: 'report' | 'accept' }, p: Projection;
beforeAll(async () => {
	root = await tempRoot('project');
	c = await buildCase(path.join(root, 'c'), { edit: (r) => { (r.DATA.chronology as Record<string, unknown>[])[0]!.date_type = 'issued'; } });
	const r = await importCandidate(c.pkgDir, c.caseDir);
	if (r.verdict === 'reject') throw new Error('synthetic import rejected');
	result = r;
	p = project(r.candidate, r.counts);
});
afterAll(() => cleanup(root));

describe('projection', () => {
	it('stores each source row unchanged as canonical JSON, in source order', () => {
		const rows = result.candidate.dataset('chronology')!.data as Record<string, unknown>[];
		const byRef = new Map(p.documents.map((d) => [d.ref, d]));
		rows.forEach((row, ord) => {
			const d = byRef.get(row.ref as string)!;
			expect(d.ord).toBe(ord);
			expect(d.row_json).toBe(canonicalJson(row));
		});
		const list = JSON.parse(p.chronologyJson) as ChronologyListRow[];
		expect(list.map((x) => x.ref)).toEqual(rows.map((x) => x.ref));
	});

	it('derives dates without inferring a basis: supplied type shown, otherwise none', () => {
		const list = JSON.parse(p.chronologyJson) as ChronologyListRow[];
		expect(list[0]!.dateType).toBe('issued');
		expect(list.slice(1).every((x) => x.dateType === null && x.dateSource === null)).toBe(true);
		const undated = list.find((x) => x.ref === 'OD-003')!;
		expect(undated.date).toBe('');
	});

	it('distinguishes direct originals, attachments through the parent and unavailable sources (BA-09)', () => {
		const em = p.documents.find((d) => d.ref === 'EM-0001')!;
		const state = JSON.parse(em.state_json) as DocumentStateRow;
		expect(state.file).toBe('present');
		const atts = JSON.parse(em.attachments_json) as AttachmentRow[];
		expect(atts.map((a) => [a.key, a.route, a.via])).toEqual([['EM-0001.a1', 'parent', 'EM-0001'], ['EM-0001.a2', 'parent', 'EM-0001'], ['EM-0001.a3', 'parent', 'EM-0001']]);
		const assets = new Map(p.assets.map((a) => [a.key, a]));
		expect(assets.get('EM-0001.a1')).toMatchObject({ kind: 'embedded', status: 'embedded', real_path: null, sha256: null });
		expect(assets.get('OD-001')).toMatchObject({ kind: 'file', status: 'verified', download_only: 0 });
	});

	it('never synthesises text: the list carries the excerpt only, the overview only source values and derived counts', () => {
		const o = JSON.parse(p.overview) as OverviewModel;
		expect(o.counts.documents).toBe(7);
		expect(o.dates).toEqual({ min: '2001-02-03', max: '2001-02-28', undated: 1 });
		expect(o.matter?.storyline[0]?.t).toContain('[[OD-001]]');
		expect(o.resultsVersion).toBe(c.resultsVersion);
		expect(JSON.stringify(p)).not.toMatch(/"text":"(?!extracted|ocr|none|pending|unsupported|unknown)/);
	});

	it('is deterministic, and the digest changes when any projected row changes', () => {
		const again = project(result.candidate, result.counts);
		const d = (x: Projection) => readModelDigest({ ...x, expect: JSON.stringify(x.expect) });
		expect(d(again)).toBe(d(p));
		const tampered = { ...p, documents: p.documents.map((x, i) => (i === 0 ? { ...x, state_json: x.state_json.replace('present', 'missing') } : x)) };
		expect(d(tampered)).not.toBe(d(p));
		const reordered = { ...p, assets: [...p.assets].reverse() };
		expect(d(reordered)).toBe(d(p)); // row order in storage does not matter, content does
	});
});

describe('dataset access for views', () => {
	it('reads recognized datasets from the stored bytes, frozen, and never opaque ones', async () => {
		const lc = service(path.join(root, 'data'));
		try {
			await lc.startup();
			await lc.importPackage(c.caseDir, c.pkgDir);
			const people = datasetOf<{ name: string }[]>(lc.store, c.resultsVersion, 'people');
			expect(people?.[0]?.name).toBe('Ann Lee');
			expect(Object.isFrozen(people)).toBe(true);
			expect(datasetOf(lc.store, c.resultsVersion, 'no-such-dataset')).toBeNull();
			expect(datasetKeys(lc.store, c.resultsVersion)).toContain('chronology');
			expect(datasetOf(lc.store, 'sha256:' + '0'.repeat(64), 'people')).toBeNull();
		} finally { lc.shutdown(); }
	});
});
