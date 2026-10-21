// GRS-149: the newer builder (META.version V1) writes its hand-authored analysis as code. Its mod_00_analysis.js module
// holds `const X = {…}` and merges X into DATA's empty slots at run time. The converter reads the literal and the
// module's merge statements as text, never evaluating either, and fills the package roots that v5 and the JSON script
// fill. A shape the v5 roots cannot hold stays residual with a diagnostic and its counts. Every value below is invented.
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { importCandidate } from '../../src/lib/case-package/import.ts';
import { decodeUtf8Strict, parseStrictJson } from '../../src/lib/case-package/strict-json.ts';
import { convertV5 } from '../../src/lib/case-package/v5/adapter.ts';
import { writePackageDir } from '../../src/lib/case-package/writer.ts';
import { AGREEMENT, emptyAnalysisSlots, literal, MODULE, V1_MERGE_LINE, X } from './fixtures/newer-analysis.ts';
import { cleanup, synthHtml, synthRoots, tempDir, writeCaseFolder, type SynthRoots } from './fixtures/synth.ts';

type J = Record<string, any>;
const roots: string[] = [];
afterAll(async () => { for (const r of roots) await cleanup(r); });

const url = (p: string) => './' + p.split('/').map(encodeURIComponent).join('/');

function newerRoots(): SynthRoots {
  const r = synthRoots();
  emptyAnalysisSlots(r);
  return r;
}

async function convert(lines: string[], edit?: (r: SynthRoots) => void) {
  const root = await tempDir('newer-analysis');
  roots.push(root);
  const caseDir = path.join(root, 'case');
  await writeCaseFolder(caseDir);
  const r = newerRoots();
  edit?.(r);
  const result = await convertV5({ html: synthHtml(r, lines), htmlName: 'workspace.html', caseFolder: caseDir, caseId: 'synthetic-newer-analysis' });
  return { root, caseDir, result, rows: r.DATA.chronology as J[] };
}
type Converted = Awaited<ReturnType<typeof convert>>;
const keys = (c: Converted) => c.result.manifest!.files.filter((f) => f.role === 'dataset').map((f) => f.key);
const envelope = (c: Converted, key: string) => parseStrictJson(decodeUtf8Strict(c.result.files!.get(`datasets/${key}.json`)!)) as J;
const data = (c: Converted, key: string) => envelope(c, key).data;
const notes = (c: Converted, code: string) => c.result.diagnostics.filter((d) => d.code === code);
const docLink = (rows: J[], ref: string) => { const r = rows.find((x) => x.ref === ref)!; return { date: r.date, doc_type: r.doc_type, filename: r.filename, ref, url: r.url }; };

describe('the newer export\'s code-embedded analysis (GRS-149)', () => {
  it('reaches the risks, matter headings, timeline events, defence rows and witnesses the v5 views read', async () => {
    const c = await convert([MODULE, literal(X), V1_MERGE_LINE]);
    expect(c.result.ok).toBe(true);
    expect(data(c, 'risk-matrix')).toEqual(X.riskMatrix);
    expect(data(c, 'matter')).toMatchObject({ title: 'Invented matter', short: 'IM', forum: 'Invented forum', storyline: [{ h: 'Start', t: 'The agreement OD-001 began it.' }, { h: 'Then', t: 'Invoice OD-002 followed.' }], strategy: [{ h: 'Plan', t: 'Rely on SD-001.' }] });
    expect(data(c, 'timeline-events')).toEqual([
      { date: '2001-02-03', kind: 'contract', note: 'Invented detail', ref: 'OD-001', title: 'Agreement signed', url: url(AGREEMENT), phase: 'one', refs: ['OD-001'] },
      { date: '2001-02-28', kind: 'invoice', note: 'Invented', ref: 'OD-002', title: 'Invoice issued', url: url('DISCOVERY A/OD-002 Invoice 1001.pdf'), phase: 'two', refs: ['OD-002', 'SD-001'] },
      { date: '2001-03-04', kind: 'note', note: 'Invented', ref: '', title: 'No document', url: '', phase: 'two', refs: [] },
    ]);
    expect(data(c, 'defence-matrix')).toEqual([{ point: 'Point', dcs: 'Their contention', rebuttal: 'Rebuttal', evidence: 'Evidence', refs: '', docs: [docLink(c.rows, 'OD-001'), docLink(c.rows, 'OD-002')] }]);
    expect(data(c, 'witnesses')).toEqual(X.witnesses);
  });

  it('accounts for every root: each fills a recognized dataset or stays residual with a diagnostic and its counts', async () => {
    const c = await convert([MODULE, literal(X), V1_MERGE_LINE]);
    expect(keys(c)).not.toContain('v5-residual-analysis-overlay');
    expect(c.result.diagnostics.filter((d) => d.code.startsWith('V5_OVERLAY_'))).toEqual([]);
    // the profile no longer stands in for the matter: the module's matter is what the newer viewer shows
    expect(keys(c)).toContain('v5-residual-profile');
    expect(data(c, 'lit-legality')).toEqual(X.legality);
    expect(data(c, 'lit-elements')).toEqual([{ element: 'E', must: 'M', evidence: 'Ev', witness: 'W', tab: 'chronology', refs: ['OD-001'], gap: 'G' }]);
    expect(data(c, 'lit-recon')).toEqual([{ month: '2001-02', invoice: ['OD-002'], statement: ['SD-001'], supporting: [], charging: [], amountdue: ['OD-002'], pod: [], breakdown: ['OD-002'] }]);
    expect(data(c, 'lit-settlement')).toMatchObject({ ...X.settlement, claimDate: expect.any(String) });
    expect(data(c, 'lit-enforcement')).toEqual(X.enforcement);
    expect(data(c, 'contradictions')).toMatchObject({
      byCat: { rates: 1 }, total: 1, highCount: 1, checks: [], source_checks: X.contradictions.checks,
      categories: [{ key: 'rates', title: 'Rates', severity: 'high', explain: 'Invented', items: [{ label: 'L', detail: 'D', values: { a: '1.00' }, refs: [{ ref: 'OD-002', amount: '', filename: 'OD-002 Invoice 1001.pdf', url: url('DISCOVERY A/OD-002 Invoice 1001.pdf') }] }] }],
    });
    expect(data(c, 'lit-authorities')).toEqual(X.authorities);
    expect(data(c, 'lit-crossexam-seed')).toEqual([{ witness: 'Ann Lee', topic: 'Payment', put: 'Invented put', docs: 'OD-002, SD-001' }]);
    expect(data(c, 'info-required')).toEqual(X.infoRequired);
    expect(data(c, 'lit-prescription')).toEqual(X.prescription);
    expect(data(c, 'lit-presc-summary')).toEqual(X.prescSummary);
    expect(data(c, 'lit-interest-basis')).toMatchObject({ ...X.interestBasis, source: 'builder' });
    // the date-bounded phases do not fit the v5 year-range phases: kept residual, with the demotion note
    expect(data(c, 'v5-residual-timeline-phases')).toEqual(X.timeline.phases);
    expect(notes(c, 'V5_DATASET_SHAPE_UNMAPPED').map((d) => d.subject)).toEqual(['timeline-phases']);
    // the module's anchors and organogram fill DATA keys no view reads: residual, each named with its count
    expect(data(c, 'v5-residual-anchors')).toEqual(X.anchors);
    expect(data(c, 'v5-residual-organogram')).toEqual(X.organogram);
    const unmapped = new Map(notes(c, 'V5_UNMAPPED_KEY').map((d) => [d.subject, d.message]));
    expect(unmapped.get('DATA.anchors')).toContain('(1 entry)');
    expect(unmapped.get('DATA.organogram')).toContain('(2 keys)');
    const pkgDir = path.join(c.root, 'pkg');
    await writePackageDir(pkgDir, c.result.files!);
    const v = await importCandidate(pkgDir, c.caseDir);
    expect(v.verdict).toBe('report');
    expect(v.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('merges only the V1 builder\'s statements: another statement leaves its root residual and named with its count, and never reaches the register', async () => {
    const extra = { ...X, extraRows: [{ ref: 'OD-099' }, { ref: 'ZZ-901' }] };
    const line = V1_MERGE_LINE.replace(' })();', ' DATA.chronology.push.apply(DATA.chronology, X.extraRows); })();');
    const c = await convert([MODULE, literal(extra), line]);
    expect(data(c, 'chronology')).toHaveLength(c.rows.length);
    // the module does something other than the builder's merges, so none applies and X stays whole
    expect(data(c, 'risk-matrix')).toEqual([]);
    expect(data(c, 'v5-residual-analysis-overlay')).toEqual(extra);
    const w = notes(c, 'V5_OVERLAY_UNMAPPED');
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toContain('20 keys');
    expect(w[0]!.message).toContain('extraRows 2');
    expect(w[0]!.message).toContain('1 unrecognised and 0 repeated statements');
  });

  describe('fails closed on a module whose statements are not all the pinned merges, each once (M1)', () => {
    const RISK = 'DATA.riskMatrix.push.apply(DATA.riskMatrix, X.riskMatrix);';
    const WITHOUT_RISK = V1_MERGE_LINE.replace(`${RISK} `, '');
    const WITNESS = 'DATA.witnesses.push.apply(DATA.witnesses, X.witnesses);';
    const closed = async (lines: string[], unrecognised: number, repeated: number) => {
      const c = await convert([MODULE, literal(X), ...lines]);
      expect(c.result.ok).toBe(true);
      expect(data(c, 'risk-matrix')).toEqual([]);
      expect(data(c, 'witnesses')).toEqual([]);
      expect(data(c, 'matter')).not.toMatchObject({ title: 'Invented matter' });
      expect(data(c, 'v5-residual-analysis-overlay')).toEqual(X);
      const w = notes(c, 'V5_OVERLAY_UNMAPPED');
      expect(w).toHaveLength(1);
      expect(w[0]!.message).toContain('19 keys');
      expect(w[0]!.message).toContain(`${unrecognised} unrecognised and ${repeated} repeated statements`);
    };

    it('a) an unknown statement before the merges places nothing', async () => {
      await closed([`X.riskMatrix = []; ${V1_MERGE_LINE}`], 1, 0);
    });

    it('b) an unknown statement after the merges places nothing', async () => {
      await closed([V1_MERGE_LINE.replace(' })();', ' DATA.witnesses.length = 0; })();')], 1, 0);
    });

    it('c) a merge inside a block comment, a string or a line comment is not a merge', async () => {
      await closed([`/* off; ${RISK} */ ${WITHOUT_RISK}`], 2, 0);
      await closed([`var off = "x; ${RISK} y"; ${WITHOUT_RISK}`], 2, 0);
      await closed([`// off; ${RISK}`, WITHOUT_RISK], 1, 0);
    });

    it('d) a merge written twice places nothing', async () => {
      await closed([V1_MERGE_LINE.replace(' })();', ` ${WITNESS} })();`)], 0, 1);
    });
  });

  it('keeps a root residual when its DATA slot is not the kind the merge needs, as the viewer could not merge it either', async () => {
    const c = await convert([MODULE, literal(X), V1_MERGE_LINE], (r) => { r.DATA.riskMatrix = {}; delete (r.DATA.lit as J).recon; });
    expect(data(c, 'v5-residual-analysis-overlay')).toEqual({ riskMatrix: X.riskMatrix, recon: X.recon });
    expect(notes(c, 'V5_OVERLAY_UNMAPPED')[0]!.message).toContain('riskMatrix 2, recon 1');
    expect(data(c, 'witnesses')).toEqual(X.witnesses);
  });
});
