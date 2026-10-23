import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { convertV5 } from '../../src/lib/case-package/v5/adapter';
import { decodeUtf8Strict, parseStrictJson } from '../../src/lib/case-package/strict-json';
import { importCandidate } from '../../src/lib/case-package/import';
import { writePackageDir } from '../../src/lib/case-package/writer';
import { emptyAnalysisSlots, literal, MODULE, V1_MERGE_LINE, X } from './fixtures/newer-analysis';
import { cleanup, synthHtml, synthRoots, tempDir, writeCaseFolder } from './fixtures/synth';

const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs) await cleanup(dir); });
async function convert(edit: (x: typeof X) => void = () => {}) {
	const dir = await tempDir('grs194'); dirs.push(dir);
	const caseDir = path.join(dir, 'case'); await writeCaseFolder(caseDir);
	const roots = synthRoots(); emptyAnalysisSlots(roots);
	const x = structuredClone(X); edit(x);
	const result = await convertV5({ html: synthHtml(roots, [MODULE, literal(x), V1_MERGE_LINE]), htmlName: 'workspace.html', caseFolder: caseDir, caseId: 'grs194-synthetic' });
	expect(result.ok).toBe(true);
	const data = (key: string) => (parseStrictJson(decodeUtf8Strict(result.files!.get(`datasets/${key}.json`)!)) as { data: unknown }).data;
	return { result, data, x, dir, caseDir };
}

describe('GRS-194 newer analysis presentation contract', () => {
	it('recognizes all four groups without fabricating counts or changing source membership', async () => {
		const c = await convert((x) => { x.organogram.nodes.push({ id: 'b', label: 'Org B', refs: ['OD-002'] }); x.organogram.edges.push({ from: 'a', to: 'b', label: 'Supplies', refs: ['OD-001'] }); });
		for (const key of ['anchors', 'organogram']) expect(c.data(key)).toEqual(c.x[key]);
		expect(c.data('timeline-phases')).toEqual(c.x.timeline.phases);
		expect(c.data('contradictions')).toMatchObject({ checks: [], source_checks: [{ check: 'C', result: 'ok' }] });
		expect(c.result.diagnostics.filter((d) => ['anchors', 'organogram', 'timeline-phases'].includes(d.subject ?? '') && d.code === 'V5_DATASET_SHAPE_UNMAPPED')).toEqual([]);
		const pkg = path.join(c.dir, 'package'); await writePackageDir(pkg, c.result.files!);
		const imported = await importCandidate(pkg, c.caseDir);
		expect(imported.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
	});

	it.each([
		['anchors', (x: typeof X) => { x.anchors[0].page = -1; }],
		['organogram', (x: typeof X) => { x.organogram.edges = [{ from: 'a', to: 7 }]; }],
		['timeline-phases', (x: typeof X) => { x.timeline.phases[0].from = 'not-a-date'; }],
		['contradictions', (x: typeof X) => { x.contradictions.checks[0].result = { html: '<script>bad()</script>' }; }],
	] as const)('keeps malformed %s private with an explicit repair diagnostic', async (key, edit) => {
		const c = await convert(edit);
		expect(c.result.manifest!.files.some((f) => f.key === key)).toBe(false);
		expect(c.result.manifest!.files.some((f) => f.key === `v5-residual-${key}`)).toBe(true);
		expect(c.result.diagnostics.some((d) => d.code === 'V5_DATASET_SHAPE_UNMAPPED' && d.subject === key)).toBe(true);
	});
});
