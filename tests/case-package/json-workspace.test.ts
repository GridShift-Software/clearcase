// The newer workspace generation (JSON script tags) converts through the same pipeline as v5. Every value below is
// invented. The v5 fixture's package identity is pinned so the second generation cannot move v5 output by a byte.
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DiagSink } from '../../src/lib/case-package/diagnostics.ts';
import { importCandidate } from '../../src/lib/case-package/import.ts';
import { decodeUtf8Strict, parseStrictJson } from '../../src/lib/case-package/strict-json.ts';
import { convertV5, type ConvertResult } from '../../src/lib/case-package/v5/adapter.ts';
import { extractV5 } from '../../src/lib/case-package/v5/extract.ts';
import { amountText, riskLevel } from '../../src/lib/case-package/v5/json-workspace.ts';
import { writePackageDir } from '../../src/lib/case-package/writer.ts';
import { buildSynth } from './fixtures/build.ts';
import { cleanup, synthHtml, synthOriginals, synthRoots, tempDir, writeCaseFolder } from './fixtures/synth.ts';

type J = Record<string, unknown>;
const url = (p: string) => './' + p.split('/').map(encodeURIComponent).join('/');
const AGREEMENT = 'DISCOVERY A/OD-001 Supply agreement.pdf', INVOICE = 'DISCOVERY A/OD-002 Invoice 1001.pdf', MAIL = 'MAIL/EM-0001 Re payment.eml', STATEMENT = 'DISCOVERY B/SD-001 Statement.pdf';
const size = (p: string) => synthOriginals()[p]!.byteLength;

function appData(): J {
  const row = (o: J): J => ({ sj: '', sd: '', to: '', cc: '', ex: '', st: '', sec: 'Documents', sub: 'DISCOVERY A', ent: 'Org A Ltd', fm: 'Firm A', amt: null, ai: [], ts: 'extracted', ext: '.pdf', na: 0, tl: 30, pv: 0, pvk: '', mt: ['A'], ...o });
  return {
    chronology: [
      row({ n: 1, ref: 'DC-SYN-001', date: '2001-02-03', ds: 'text', fn: 'OD-001 Supply agreement.pdf', ex: 'Head of text', st: 'Head of text and the rest of it', dt: 'sale agreement', amt: 1150.5, ai: ['DC-SYN-002'], url: url(AGREEMENT), sz: size(AGREEMENT), bd: 'Original' }),
      row({ n: 2, ref: 'CO-SYN-001', date: '2001-02-28', ds: 'header', fn: 'EM-0001 Re payment.eml', sj: 'Re payment', sd: 'Ann Lee', to: 'Bob Ray', dt: 'email', url: url(MAIL), sz: size(MAIL), bd: 'Correspondence', mt: ['A', 'B'], th: 're payment', sub: 'MAIL', ext: '.eml' }),
      row({ n: 3, ref: 'DC-SYN-002', date: '', ds: 'file', fn: 'OD-002 Invoice 1001.pdf', dt: 'invoice', ts: 'ocr', url: url(INVOICE), sz: size(INVOICE), bd: 'Original', mt: ['B'], pr: 'CO-SYN-001', up: 'Upload.zip' }),
      row({ n: 4, ref: 'DC-CT2-001', date: '2002-05-06', ds: 'filename', fn: 'SD-001 Statement.pdf', dt: 'bank statement', amt: 20.123456, ts: 'none', url: url(STATEMENT), sz: size(STATEMENT), bd: 'Supplementary', mt: ['C'], sub: 'DISCOVERY B' }),
    ],
    meta: { builtAt: '2002-06-07 08:09', docCount: 4, dataFolderName: 'Synthetic room', emails: 1, ocrPending: 1, extracted: 2, years: { '2001': 2, '2002': 1 }, bundles: { Original: 2, Correspondence: 1, Supplementary: 1 } },
    bundles: {
      folder: './BUNDLES/', source: 'synthetic', indexSource: 'synthetic index', caselinesSrc: '',
      headerDefaults: { court: 'IN THE SYNTHETIC COURT', judge: '', intro: 'Between:', caseNo: '1/2002', claimant: 'ORG A', claimantRole: 'APPLICANT', defendant: 'ORG B', defendantRole: 'RESPONDENT' },
      headerProvenance: [['Invented', 'CO-SYN-001']],
      list: [{ no: '1', name: 'CORE', title: '(1) CORE', note: 'Invented note', pages: 3, indexPages: 0, filePages: 0, file: '', indexFile: '', rows: [
        { n: 1, key: 'DC-SYN-001', desc: 'OD-001 Supply agreement.pdf', date: '2001-02-03', pages: 2, from: 1, to: 2, parts: [{ rel: AGREEMENT, url: url(AGREEMENT), name: 'OD-001 Supply agreement.pdf', from: 1, to: 2 }], blank: false, missing: false, review: false },
        { n: 2, key: 'DC-SYN-009', desc: 'gone', date: '', pages: 0, from: 0, to: 0, parts: [], blank: false, missing: true, review: true },
      ] }],
    },
    pages: { 'DC-SYN-001': 2 },
    hot: [{ ref: 'DC-CT2-001', score: 5, why: 'statement, key amount' }, { ref: 'DC-SYN-001', score: 9, why: 'the agreement' }],
    entities: [{ key: 'Org A', name: 'Org A Ltd', role: 'Claimant', count: 2, first: '2001', last: '2002', tax: 0 }],
    people: [{ name: 'Ann Lee', side: 'client', role: 'Director', sent: 1, recv: 2 }],
    agreements: [{ ref: 'DC-SYN-001', n: 1, date: '2001-02-03', ent: 'Org A Ltd', fn: 'OD-001 Supply agreement.pdf', dt: 'sale agreement', url: url(AGREEMENT), ex: 'Head of text' }],
    contradictions: [
      { kind: 'Divergent figures', ent: 'Org A Ltd', year: '2001', dt: 'invoice', lo: 100.0, hi: 1150.5, sev: 'High', gap: 91.3, refs: ['DC-SYN-001', 'DC-SYN-002'], note: 'Two invoices differ.' },
      { kind: 'Divergent figures', ent: 'Org A Ltd', year: '2002', dt: 'statement', lo: 1, hi: 2, sev: 'Low', gap: 50, refs: ['DC-CT2-001'], note: 'Low one.' },
    ],
    tax: [{ ref: 'DC-SYN-001', ev: 'Assessment' }],
    ft: { agreement: '1.1' },
    fulltext: { 'DC-SYN-001': 'Head of text and the rest of it' },
  };
}

function appSeed(): J {
  return {
    client: 'Synthetic client & group',
    matters: [
      { id: 'A', title: 'A v B', sub: 'Dissolution', forum: 'Invented High Court', parties: 'A (applicant) v B (respondent)', posture: 'Pre-litigation.', storyline: [['I. Background', 'It began [[DC-SYN-001]] </script> not a tag.'], ['II. Next', 'Then.']], strategy: [['1. Summary', 'Favourable.']] },
      { id: 'B', title: 'A v Revenue', sub: 'Tax', forum: 'Tax Court', parties: 'A v Revenue', posture: 'Objection lodged.', storyline: [['I. Assessments', 'Raised.']], strategy: [] },
    ],
    risk: [{ id: 'A1', matter: 'A', risk: 'Court refuses relief.', type: 'Legal', l: 2, i: 5, mit: 'Lead with the signed pages.', owner: 'Counsel', target: '1x5=5', res: 'Issue motion.' }],
    vdm: [{ matter: 'A', opponent: 'B', contention: 'Non-binding.', evidence: 'Signed pages.', rebuttal: 'Refuted.' }],
    inforeq: [{ matter: 'A', grp: '2.1 Originals', doc: 'Signed Heads.', why: 'Founding instrument.', src: 'Client', pri: 'P1' }],
    elements: [{ matter: 'A', cause: 'Breach of contract', els: ['A binding agreement', 'Breach'], ev: 'Executed Heads.', wit: 'The client' }],
    authorities: [{ src: 'Companies Act 71 of 2008', cite: 's 81(1)(d)(iii)', prop: 'Winding-up.', matter: 'A', note: 'Alternative relief.' }],
    witnesses: [{ name: 'Ann Lee', role: 'Client', matter: 'A / B', scope: 'The whole chronology.', status: 'Outstanding' }],
    discovery: [{ matter: 'A', grp: 'Background', doc: 'Email: financing', date: '2001-02-28', co: 'C' }],
    settlement: [{ matter: 'A', batna: 'Protocol.', best: 'Full performance.', worst: 'Drift.', note: 'Settle.' }],
    conflict_note: 'Run a conflict check.',
  };
}

/** As the generator writes it: one JSON script tag per line, `</` escaped inside strings. */
const tag = (id: string, v: unknown) => `<script id="${id}" type="application/json">${JSON.stringify(v).replace(/<\//g, '<\\/')}</script>`;
const jsonHtml = (lines: string[]) => new TextEncoder().encode(['<!DOCTYPE html>', '<html><head><meta charset="utf-8"><title>Synthetic JSON workspace</title></head><body>', ...lines, '<script>', 'const NAV = [];', 'globalThis.__executed = true;', '</script>', '</body></html>', ''].join('\n'));
const dataset = (files: Map<string, Uint8Array>, key: string) => (parseStrictJson(decodeUtf8Strict(files.get(`datasets/${key}.json`)!)) as { data: unknown }).data;
const roots: string[] = [];
afterAll(async () => { for (const r of roots) await cleanup(r); });

async function convert(html: Uint8Array): Promise<{ root: string; caseDir: string; result: ConvertResult }> {
  const root = await tempDir('json-ws');
  roots.push(root);
  const caseDir = path.join(root, 'case');
  await writeCaseFolder(caseDir);
  return { root, caseDir, result: await convertV5({ html, htmlName: 'SYN_Workspace.html', caseFolder: caseDir, caseId: 'synthetic-json' }) };
}

describe('the JSON-script workspace generation', () => {
  it('converts into the v5 datasets, with the rest residual and the token index dropped', async () => {
    const { caseDir, result } = await convert(jsonHtml([tag('app-data', appData()), tag('app-seed', appSeed())]));
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);
    const files = result.files!;
    const keys = result.manifest!.files.filter((f) => f.role === 'dataset').map((f) => f.key).sort();
    expect(keys).toEqual([
      'bundles', 'chronology', 'contracts', 'contradictions', 'conversion-report', 'defence-matrix', 'discovery-schedules', 'entities', 'info-required', 'lit-authorities', 'lit-elements',
      'matter', 'meta', 'people', 'risk-matrix', 'source-layout', 'timeline-events', 'timeline-phases', 'timeline-type-by-year', 'timeline-year-counts',
      'v5-residual-conflict-note', 'v5-residual-fulltext', 'v5-residual-hot', 'v5-residual-meta', 'v5-residual-pages', 'v5-residual-settlement', 'v5-residual-tax', 'view-content', 'witnesses',
    ]);
    const rows = dataset(files, 'chronology') as J[];
    expect(rows[0]).toEqual({
      ref: 'DC-SYN-001', n: 1, seq: 1, date: '2001-02-03', filename: 'OD-001 Supply agreement.pdf', subject: '', sender: '', to: '', cc: '', excerpt: 'Head of text and the rest of it',
      doc_type: 'sale agreement', bundle: 'Original', amount: '1150.5', also_in: ['DC-SYN-002'], text_status: 'extracted', url: url(AGREEMENT), refs: [], invoice_no: '', size: size(AGREEMENT), attachments: [], date_source: 'text',
      ent: 'Org A Ltd', mt: ['A'], sec: 'Documents', sub: 'DISCOVERY A', fm: 'Firm A', ext: '.pdf', na: 0, tl: 30, pv: 0, pvk: '',
    });
    expect(rows[2]).toMatchObject({ ref: 'DC-SYN-002', date: '', date_source: 'file', excerpt: '', amount: '', text_status: 'ocr', pr: 'CO-SYN-001', up: 'Upload.zip' });
    expect(rows[3]).toMatchObject({ ref: 'DC-CT2-001', amount: '20.1235', text_status: 'none' });
    expect(dataset(files, 'meta')).toEqual({
      builtAt: '2002-06-07 08:09', docCount: 4, dataFolderName: 'Synthetic room', bundles: { Original: 2, Correspondence: 1, Supplementary: 1 }, emails: 1, invoices: 1, people: 1, textNone: 1, textPending: 0,
      dateSpan: ['2001-02-03', '2002-05-06'], docTypes: { 'sale agreement': 1, email: 1, invoice: 1, 'bank statement': 1 },
    });
    expect(dataset(files, 'matter')).toEqual({
      title: 'Synthetic client & group', short: 'Synthetic client & group', forum: 'A: Invented High Court; B: Tax Court',
      storyline: [
        { h: 'Matter A: A v B', t: 'Dissolution\nA (applicant) v B (respondent)\nInvented High Court\nPre-litigation.' }, { h: 'I. Background', t: 'It began [[DC-SYN-001]] </script> not a tag.' }, { h: 'II. Next', t: 'Then.' },
        { h: 'Matter B: A v Revenue', t: 'Tax\nA v Revenue\nTax Court\nObjection lodged.' }, { h: 'I. Assessments', t: 'Raised.' },
      ],
      strategy: [{ h: 'Matter A: A v B', t: 'Pre-litigation.' }, { h: '1. Summary', t: 'Favourable.' }, { h: 'Matter B: A v Revenue', t: 'Objection lodged.' }],
    });
    expect(dataset(files, 'contradictions')).toEqual({
      byCat: { 'divergent-figures': 2 }, checks: [], highCount: 1, total: 2,
      categories: [{ key: 'divergent-figures', title: 'Divergent figures', severity: 'high', explain: '', items: [
        { label: 'Org A Ltd · 2001 · invoice', sev: 'High', detail: 'Two invoices differ.', rates: { LOW: '100', HIGH: '1150.5', GAP: '91.3' }, spread: 'low R 100.00, high R 1 150.50, gap 91.3%', refs: [{ ref: 'DC-SYN-001', amount: '', filename: 'OD-001 Supply agreement.pdf', url: url(AGREEMENT) }, { ref: 'DC-SYN-002', amount: '', filename: 'OD-002 Invoice 1001.pdf', url: url(INVOICE) }] },
        { label: 'Org A Ltd · 2002 · statement', sev: 'Low', detail: 'Low one.', rates: { LOW: '1', HIGH: '2', GAP: '50' }, spread: 'low R 1.00, high R 2.00, gap 50%', refs: [{ ref: 'DC-CT2-001', amount: '', filename: 'SD-001 Statement.pdf', url: url(STATEMENT) }] },
      ] }],
    });
    expect(dataset(files, 'timeline-events')).toEqual([
      { date: '2001-02-03', kind: 'sale agreement', note: 'the agreement', ref: 'DC-SYN-001', title: 'OD-001 Supply agreement.pdf', url: url(AGREEMENT) },
      { date: '2002-05-06', kind: 'bank statement', note: 'statement, key amount', ref: 'DC-CT2-001', title: 'SD-001 Statement.pdf', url: url(STATEMENT) },
    ]);
    expect(dataset(files, 'timeline-phases')).toEqual([['2001', '2 documents in 2001'], ['2002', '1 document in 2002']]);
    expect(dataset(files, 'timeline-year-counts')).toEqual({ '2001': 2, '2002': 1 });
    expect(dataset(files, 'timeline-type-by-year')).toEqual({ '2001': { 'sale agreement': 1, email: 1 }, '2002': { 'bank statement': 1 } });
    expect(dataset(files, 'contracts')).toEqual({ count: 1, groups: [{ key: 'sale agreement', items: [{ date: '2001-02-03', doc_type: 'sale agreement', note: 'Head of text', party: 'Org A Ltd', ref: 'DC-SYN-001', role: '', text_status: 'extracted', title: 'OD-001 Supply agreement.pdf', url: url(AGREEMENT) }] }] });
    expect(dataset(files, 'risk-matrix')).toEqual([{ issue: 'Court refuses relief.', likelihood: 'Low', impact: 'High', likelihood_score: 2, impact_score: 5, mitigation: 'Lead with the signed pages.', id: 'A1', matter: 'A', category: 'Legal', owner: 'Counsel', target: '1x5=5', res: 'Issue motion.' }]);
    expect(dataset(files, 'defence-matrix')).toEqual([{ point: 'Matter A · B', dcs: 'Non-binding.', rebuttal: 'Refuted.', evidence: 'Signed pages.', refs: '', docs: [] }]);
    expect(dataset(files, 'info-required')).toEqual([{ item: 'Signed Heads.', owner: 'Client', status: 'P1', matter: 'A', grp: '2.1 Originals', why: 'Founding instrument.' }]);
    expect(dataset(files, 'witnesses')).toEqual([{ name: 'Ann Lee', role: 'Client', willsay: 'The whole chronology.', matter: 'A / B', status: 'Outstanding' }]);
    expect(dataset(files, 'lit-elements')).toEqual([{ element: 'Breach of contract', must: 'A binding agreement; Breach', evidence: 'Executed Heads.', witness: 'The client', tab: '', matter: 'A' }]);
    expect(dataset(files, 'lit-authorities')).toEqual([{ topic: 'Matter A', authority: 'Companies Act 71 of 2008 s 81(1)(d)(iii)', proposition: 'Winding-up.', note: 'Alternative relief.' }]);
    expect(dataset(files, 'people')).toEqual([{ name: 'Ann Lee', email: '', org: '', sent: 1, received: 2, total: 3, role: 'Director', side: 'client' }]);
    expect(dataset(files, 'entities')).toEqual([{ name: 'Org A Ltd', note: '', role: 'Claimant', key: 'Org A', count: 2, first: '2001', last: '2002', tax: 0 }]);
    expect(dataset(files, 'discovery-schedules')).toEqual({ discovery: [{ no: 1, date: '2001-02-28', desc: 'Email: financing', co: 'C', nfiles: 0, files: [], matter: 'A', grp: 'Background' }], supplementary: [] });
    const bundles = dataset(files, 'bundles') as J;
    expect(bundles).toMatchObject({ count: 1, totalDocs: 2, totalItems: 2, totalPages: 3, headerDefaults: { court: 'IN THE SYNTHETIC COURT', judge: '', intro: 'Between:', caseNo: '1/2002', claimant: 'ORG A', claimantRole: 'APPLICANT', defendant: 'ORG B', defendantRole: 'RESPONDENT' }, headerProvenance: [['Invented', 'CO-SYN-001']] });
    expect((bundles.list as J[])[0]).toMatchObject({ no: '1', name: 'CORE', slug: 'core', title: '(1) CORE', nDocs: 2, nMissing: 1, nReview: 1, items: ['DC-SYN-001', 'DC-SYN-009'] });
    expect(((bundles.list as J[])[0]!.rows as J[])[0]).toEqual({ key: 'DC-SYN-001', n: 1, desc: 'OD-001 Supply agreement.pdf', from: 1, to: 2, pages: 2, date: '2001-02-03', blank: false, missing: false, review: false, parts: [{ name: 'OD-001 Supply agreement.pdf', rel: AGREEMENT, url: url(AGREEMENT), from: 1, to: 2 }] });
    expect(dataset(files, 'v5-residual-tax')).toEqual([{ ref: 'DC-SYN-001', ev: 'Assessment' }]);
    expect(dataset(files, 'v5-residual-settlement')).toEqual([{ matter: 'A', batna: 'Protocol.', best: 'Full performance.', worst: 'Drift.', note: 'Settle.' }]);
    expect(dataset(files, 'view-content')).toEqual({});
    expect((dataset(files, 'conversion-report') as J).sourceLines).toEqual({ 'app-data': 3, 'app-seed': 4 });
    const assets = (parseStrictJson(decodeUtf8Strict(files.get('assets.json')!)) as { assets: Record<string, J> }).assets;
    expect(assets['DC-SYN-001']).toMatchObject({ kind: 'file', path: AGREEMENT, size: size(AGREEMENT) });
    expect(assets['DC-SYN-002']).toMatchObject({ kind: 'file', path: INVOICE, parentRef: 'CO-SYN-001' });
    expect(result.diagnostics.find((d) => d.code === 'V5_SOURCE_INDEX_DROPPED')).toMatchObject({ severity: 'info', subject: 'app-data.ft' });
    expect(result.diagnostics.filter((d) => d.code === 'V5_UNMAPPED_KEY').map((d) => d.subject).sort()).toEqual(['DATA.conflict_note', 'DATA.fulltext', 'DATA.hot', 'DATA.meta', 'DATA.pages', 'DATA.settlement', 'DATA.tax']);
    expect(result.manifest!.inputRevision.claims).toEqual({ builtAt: '2002-06-07 08:09', docCount: 4 });
    // the written package validates without an error
    const pkgDir = path.join(caseDir, '..', 'pkg');
    await writePackageDir(pkgDir, files);
    const r = await importCandidate(pkgDir, caseDir);
    expect(r.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`)).toEqual([]);
    expect(r.verdict).not.toBe('reject');
  });

  it('converts without an app-seed and with an empty app-data', async () => {
    const { result } = await convert(jsonHtml([tag('app-data', appData())]));
    expect(result.ok).toBe(true);
    const keys = result.manifest!.files.filter((f) => f.role === 'dataset').map((f) => f.key);
    expect(keys).not.toContain('matter');
    expect(keys).not.toContain('discovery-schedules');
    const empty = await convert(jsonHtml([tag('app-data', { meta: { builtAt: '2002-06-07 08:09' } })]));
    expect(empty.result.ok).toBe(true);
    expect(dataset(empty.result.files!, 'chronology')).toEqual([]);
    expect(dataset(empty.result.files!, 'meta')).toEqual({ builtAt: '2002-06-07 08:09', docCount: 0, dataFolderName: '', bundles: {}, emails: 0, invoices: 0, people: 0, textNone: 0, textPending: 0, dateSpan: [], docTypes: {} });
  });

  it('is told apart from v5 and refused when both or malformed', () => {
    const v5 = extractV5(synthHtml(synthRoots()), new DiagSink(100));
    expect(v5?.generation).toBe('v5-js');
    expect(v5?.lines).toEqual({ DATA: 8, META: 9, 'window.__SCHED__': 13, 'window.__CASELINES_IDX__': 16 });
    const json = extractV5(jsonHtml([tag('app-data', appData()), tag('app-seed', appSeed())]), new DiagSink(100));
    expect(json?.generation).toBe('json-script');
    expect(json?.lines).toEqual({ 'app-data': 3, 'app-seed': 4 });
    expect(Object.keys(json?.roots ?? {}).sort()).toEqual(['DATA', 'META', 'window.__SCHED__']);
    const both = new DiagSink(100);
    expect(extractV5(synthHtml(synthRoots(), [tag('app-data', appData())]), both)).toBeNull();
    expect(both.finish().map((d) => d.code)).toContain('V5_PAYLOAD_AMBIGUOUS');
    const twice = new DiagSink(100);
    expect(extractV5(jsonHtml([tag('app-data', appData()), tag('app-data', appData())]), twice)).toBeNull();
    expect(twice.finish().map((d) => d.code)).toContain('V5_PAYLOAD_AMBIGUOUS');
    const array = new DiagSink(100);
    expect(extractV5(jsonHtml([tag('app-data', [1])]), array)).toBeNull();
    expect(array.finish().map((d) => d.code)).toContain('V5_PAYLOAD_NOT_JSON');
    const broken = new DiagSink(100);
    expect(extractV5(jsonHtml(['<script id="app-data" type="application/json">{"a":</script>']), broken)).toBeNull();
    expect(broken.finish().map((d) => d.code)).toContain('V5_PAYLOAD_NOT_JSON');
  });

  it('writes amounts in the package grammar', () => {
    expect(amountText(1150.5)).toBe('1150.5');
    expect(amountText(414800258.0)).toBe('414800258');
    expect(amountText(20.123456)).toBe('20.1235');
    expect(amountText(-20.5)).toBe('-20.5');
    expect(amountText(1e21)).toBe('');
    expect(amountText(null)).toBe('');
    expect(amountText('12.50')).toBe('12.50');
    expect(amountText('R 12')).toBe('');
  });

  it("names a risk score in v5's words and leaves any other value as written", () => {
    expect([5, 4, 3, 2, 1, 0].map(riskLevel)).toEqual(['High', 'High', 'Medium', 'Low', 'Low', '0']);
    expect(riskLevel('Medium')).toBe('Medium');
    expect(riskLevel(undefined)).toBe('');
  });

  it('leaves the v5 fixture package byte-identical', async () => {
    const b = await buildSynth('json-ws-pin');
    roots.push(b.root);
    expect(b.result.manifest!.resultsVersion).toBe('sha256:4f6d690162b700513b04c7fcab4cc10ddbfad962c8bdbbd9b91160e13d1629ae');
    expect(b.files.size).toBe(37);
  });
});
