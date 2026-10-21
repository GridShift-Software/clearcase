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
import { cleanup, synthHtml, synthRoots, tempDir, writeCaseFolder, type SynthRoots } from './fixtures/synth.ts';

type J = Record<string, any>;
const roots: string[] = [];
afterAll(async () => { for (const r of roots) await cleanup(r); });

const MODULE = '/* ===== module mod_00_analysis.js ===== */';
const literal = (x: unknown) => `(function(){ const X = ${JSON.stringify(x)};`;
/** The V1 builder's merge line, statement for statement as it writes it after the literal. */
const V1_MERGE_LINE = 'Object.assign(DATA.matter, X.matter); Object.assign(DATA.timeline, {phases: X.timeline.phases, events: X.timeline.events}); DATA.riskMatrix.push.apply(DATA.riskMatrix, X.riskMatrix); Object.assign(DATA.lit.legality, X.legality); DATA.defenceMatrix.push.apply(DATA.defenceMatrix, X.defenceMatrix); DATA.lit.elements.push.apply(DATA.lit.elements, X.elements); DATA.lit.recon.push.apply(DATA.lit.recon, X.recon); Object.assign(DATA.lit.settlement, X.settlement); DATA.lit.enforcement.push.apply(DATA.lit.enforcement, X.enforcement); Object.assign(DATA.organogram, X.organogram); DATA.witnesses.push.apply(DATA.witnesses, X.witnesses); DATA.anchors.push.apply(DATA.anchors, X.anchors); Object.assign(DATA.contradictions, X.contradictions); DATA.lit.authorities.push.apply(DATA.lit.authorities, X.authorities); DATA.lit.crossexam_seed.push.apply(DATA.lit.crossexam_seed, X.crossexam_seed); DATA.infoRequired.push.apply(DATA.infoRequired, X.infoRequired); DATA.lit.prescription.push.apply(DATA.lit.prescription, X.prescription); Object.assign(DATA.lit.prescSummary, X.prescSummary); Object.assign(DATA.lit.interestBasis, X.interestBasis); })();';
const url = (p: string) => './' + p.split('/').map(encodeURIComponent).join('/');
const AGREEMENT = 'DISCOVERY A/OD-001 Supply agreement.pdf';

/** The 19 analysis roots in the newer viewer's own shapes. */
const X: J = {
  matter: { title: 'Invented matter', short: 'IM', forum: 'Invented forum', summary: 'Invented summary', status: 'Open', storyline: [['Start', 'The agreement OD-001 began it.'], ['Then', 'Invoice OD-002 followed.']], strategy: [['Plan', 'Rely on SD-001.']] },
  timeline: {
    phases: [{ key: 'one', title: 'Phase one', from: '2001-02-03', to: '2001-02-28', summary: 'First', oneLine: 'First' }, { key: 'two', title: 'Phase two', from: '2001-02-28', to: '2002-01-01', summary: 'Second', oneLine: 'Second' }],
    events: [
      { date: '2001-02-03', title: 'Agreement signed', detail: 'Invented detail', phase: 'one', type: 'contract', refs: ['OD-001'] },
      { date: '2001-02-28', title: 'Invoice issued', detail: 'Invented', phase: 'two', type: 'invoice', refs: ['OD-002', 'SD-001'] },
      { date: '2001-03-04', title: 'No document', detail: 'Invented', phase: 'two', type: 'note', refs: [] },
    ],
  },
  riskMatrix: [
    { issue: 'Invented risk', category: 'Legal', likelihood: 'Low', impact: 'High', mitigation: 'Invented', owner: 'Counsel', refs: ['OD-001'] },
    { issue: 'Second risk', category: 'Quantum', likelihood: 'High', impact: 'Medium', mitigation: 'Invented', owner: 'Attorney', refs: ['OD-002', 'SD-001'] },
  ],
  legality: { intro: 'Invented intro', docs: [{ ref: 'OD-001', date: '2001-02-03', title: 'Agreement', url: url(AGREEMENT) }], scenarios: [{ scenario: 'S', effect: 'E', prob: 'Possible', action: 'A' }], factors: [{ factor: 'F', note: 'N' }] },
  defenceMatrix: [{ point: 'Point', theirs: 'Their contention', evidence: 'Evidence', docs: ['OD-001', 'OD-002'], rebuttal: 'Rebuttal' }],
  elements: [{ element: 'E', must: 'M', evidence: 'Ev', refs: ['OD-001'], witness: 'W', gap: 'G', goto: 'chronology' }],
  recon: [{ period: '2001-02', invoice: ['OD-002'], supporting: [], charging: [], breakdown: ['OD-002'], pod: [], statement: ['SD-001'], due: ['OD-002'] }],
  settlement: { claim: '1150.00', capital: '1000.00', probability: 0.5, years: 2, discount: 0.1, cost: 100, note: 'Invented', batna: 'Invented' },
  enforcement: [{ phase: '1', step: 'S', basis: 'B', status: 'To do', note: '' }],
  organogram: { nodes: [{ id: 'a', label: 'Org A', kind: 'company', side: 'ours', role: 'Claimant', refs: ['OD-001'] }], edges: [] },
  witnesses: [{ name: 'Ann Lee', side: 'ours', role: 'Supply', willsay: 'Invented will-say', proves: 'Delivery', docs: ['OD-001'], status: 'To consult' }],
  anchors: [{ ref: 'OD-001', issue: 'I', rank: 1, why: 'W', page: 1, quote: 'Invented', title: 'Agreement', date: '2001-02-03' }],
  contradictions: { categories: [{ key: 'rates', title: 'Rates', severity: 'high', explain: 'Invented', items: [{ label: 'L', detail: 'D', refs: ['OD-002'], values: { a: '1.00' } }] }], total: 1, byCat: { rates: 1 }, checks: [{ check: 'C', result: 'ok' }], highCount: 1 },
  authorities: [{ topic: 'T', authority: 'Invented v Invented', proposition: 'P' }],
  crossexam_seed: [{ witness: 'Ann Lee', topic: 'Payment', put: 'Invented put', docs: ['OD-002', 'SD-001'] }],
  infoRequired: [{ id: 'I1', item: 'Item', why: 'Why', status: 'Open', owner: 'Ann', refs: ['OD-001'], from: 'Counsel' }],
  prescription: [{ ref: 'OD-002', no: 'INV01001', date: '2001-02-28', due: '2001-03-04', prescDate: '2004-02-28', amount: '1150.00', risk: 'Low', url: url('DISCOVERY A/OD-002 Invoice 1001.pdf') }],
  prescSummary: { total: 1, reliesOnInterruption: 0, awardDate: '2002-01-01', keyEvent: 'Invented', note: 'Invented' },
  interestBasis: { rate: 10.5, rateNote: 'Invented', method: 'simple', to: '2002-01-01', headline_due: '1150.00', capital: '1000.00', note: 'Invented', refs: ['OD-002'], from: '2001-03-04' },
};

/** The analysis slots as the V1 builder leaves them in DATA: empty, filled only by the module at run time. */
function newerRoots(): SynthRoots {
  const r = synthRoots();
  r.META.version = 'V1';
  const D = r.DATA;
  D.profile = { matter_full: 'Profile title', short: 'PT', claim_type: 'A claim.' };
  D.matter = {};
  D.timeline = { events: [], phases: [], yearCounts: {}, typeByYear: {} };
  for (const k of ['riskMatrix', 'defenceMatrix', 'witnesses', 'infoRequired', 'anchors']) D[k] = [];
  D.organogram = { nodes: [], edges: [] };
  D.contradictions = { categories: [], total: 0, byCat: {}, checks: [], highCount: 0 };
  D.lit = {
    legality: { intro: '', docs: [], scenarios: [], factors: [] }, elements: [], recon: [], settlement: {}, enforcement: [], authorities: [], crossexam_seed: [],
    prescription: [], prescSummary: {}, interestBasis: { rate: '', method: '', from: '', source: 'builder' },
  };
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
    const extra = { ...X, extraRows: [{ ref: 'OD-099' }, { ref: 'OD-098' }] };
    const line = V1_MERGE_LINE.replace(' })();', ' DATA.chronology.push.apply(DATA.chronology, X.extraRows); })();');
    const c = await convert([MODULE, literal(extra), line]);
    expect(data(c, 'chronology')).toHaveLength(c.rows.length);
    expect(data(c, 'risk-matrix')).toEqual(X.riskMatrix);
    expect(data(c, 'v5-residual-analysis-overlay')).toEqual({ extraRows: extra.extraRows });
    const w = notes(c, 'V5_OVERLAY_UNMAPPED');
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toContain('1 key');
    expect(w[0]!.message).toContain('extraRows 2');
  });

  it('keeps a root residual when its DATA slot is not the kind the merge needs, as the viewer could not merge it either', async () => {
    const c = await convert([MODULE, literal(X), V1_MERGE_LINE], (r) => { r.DATA.riskMatrix = {}; delete (r.DATA.lit as J).recon; });
    expect(data(c, 'v5-residual-analysis-overlay')).toEqual({ riskMatrix: X.riskMatrix, recon: X.recon });
    expect(notes(c, 'V5_OVERLAY_UNMAPPED')[0]!.message).toContain('riskMatrix 2, recon 1');
    expect(data(c, 'witnesses')).toEqual(X.witnesses);
  });
});
