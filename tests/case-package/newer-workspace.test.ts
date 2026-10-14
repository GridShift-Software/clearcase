// The newer builder of the v5 workspace HTML: its generation is recognised, and a dataset whose shape the converter
// does not map is demoted to an opaque residual instead of refusing the case. Every value below is invented.
import { afterAll, describe, expect, it } from 'vitest';
import { DiagSink } from '../../src/lib/case-package/diagnostics.ts';
import { importCandidate } from '../../src/lib/case-package/import.ts';
import { extractV5 } from '../../src/lib/case-package/v5/extract.ts';
import { bundlesOf, caselinesIndexOf, contractsOf, filingsOf, matterOf, metaOf, quantumOf, schedOf } from '../../src/lib/case-package/v5/newer-workspace.ts';
import { decodeUtf8Strict, parseStrictJson } from '../../src/lib/case-package/strict-json.ts';
import { buildSynth } from './fixtures/build.ts';
import { cleanup, synthHtml, synthRoots } from './fixtures/synth.ts';

const url = (p: string) => './' + p.split('/').map(encodeURIComponent).join('/');

type J = Record<string, any>;
const roots: string[] = [];
afterAll(async () => { for (const r of roots) await cleanup(r); });
const datasetKeys = (b: Awaited<ReturnType<typeof buildSynth>>) => b.result.manifest!.files.filter((f) => f.role === 'dataset').map((f) => f.key);
const dataset = (b: Awaited<ReturnType<typeof buildSynth>>, key: string) => (parseStrictJson(decodeUtf8Strict(b.files.get(`datasets/${key}.json`)!)) as { data: unknown }).data;
const ROWS: J[] = [
  { ref: 'OD-001', date: '2001-02-03', filename: 'OD-001 Supply agreement.pdf', doc_type: 'SLA' },
  { ref: 'OD-002', date: '2001-02-28', filename: 'OD-002 Invoice 1001.pdf', doc_type: 'invoice' },
  { ref: 'OD-003', date: '', filename: 'OD-003 Scan.pdf', doc_type: 'invoice' },
];
const byRef = new Map(ROWS.map((r) => [r.ref as string, r]));

describe('the newer generation of the v5 payload lines', () => {
  it('is recognised by META.version, META.fileCount or a DATA.profile; plain v5 is not', () => {
    const generation = (edit: (r: ReturnType<typeof synthRoots>) => void) => { const r = synthRoots(); edit(r); return extractV5(synthHtml(r), new DiagSink())!.generation; };
    expect(generation(() => {})).toBe('v5-js');
    expect(generation((r) => { r.META.version = 'V1'; })).toBe('v5-js-newer');
    expect(generation((r) => { r.META.fileCount = 7; })).toBe('v5-js-newer');
    expect(generation((r) => { r.DATA.profile = { short: 'SYN' }; })).toBe('v5-js-newer');
  });
});

describe('a mapped dataset that misses its schema', () => {
  it('is kept as an opaque residual with a warning, and the package still reports', async () => {
    const b = await buildSynth('shape-demote', (r) => { delete (r.DATA.quantum as J).amountDueSeries[0].filename; });
    roots.push(b.root);
    const keys = datasetKeys(b);
    expect(keys).not.toContain('quantum');
    expect(keys).toContain('v5-residual-quantum');
    const w = b.result.diagnostics.filter((d) => d.code === 'V5_DATASET_SHAPE_UNMAPPED');
    expect(w.map((d) => [d.severity, d.subject])).toEqual([['warning', 'quantum']]);
    expect(w[0]!.message).toBe('DATA.quantum does not match v5.quantum@1 (/amountDueSeries/0 must have required properties filename); kept as the opaque dataset v5-residual-quantum, so its view shows the empty state');
    const r = await importCandidate(b.pkgDir, b.caseDir);
    expect(r.verdict).toBe('report');
    expect(r.diagnostics.filter((d) => d.code === 'DS_SHAPE_INVALID')).toEqual([]);
    expect(r.diagnostics.filter((d) => d.code === 'DS_UNKNOWN_SCHEMA').map((d) => d.file)).toEqual(['datasets/v5-residual-quantum.json']);
  });

  it('never demotes the chronology: a broken register still refuses the package', async () => {
    const b = await buildSynth('shape-keep-chronology', (r) => { delete (r.DATA.chronology as J[])[0]!.filename; });
    roots.push(b.root);
    expect(datasetKeys(b)).toContain('chronology');
    expect(b.result.diagnostics.filter((d) => d.code === 'V5_DATASET_SHAPE_UNMAPPED')).toEqual([]);
    const r = await importCandidate(b.pkgDir, b.caseDir);
    expect(r.verdict).toBe('reject');
    expect(r.diagnostics.filter((d) => d.code === 'DS_SHAPE_INVALID').map((d) => d.file)).toEqual(['datasets/chronology.json']);
  });
});

describe('the newer shapes mapped onto v5', () => {
  it('meta: fills invoices, dateSpan and docTypes from the rows only where the source has none', () => {
    const src = { builtAt: '2002-06-07 08:09', docCount: 3, dataFolderName: 'Synthetic room', bundles: { Original: 3 }, emails: 0, people: 1, textNone: 1, textPending: 0, textOcr: 2, fileCount: 3, short: 'SYN', version: 'V1' };
    expect(metaOf(src, ROWS)).toEqual({ ...src, invoices: 2, dateSpan: ['2001-02-03', '2001-02-28'], docTypes: { SLA: 1, invoice: 2 } });
    expect(metaOf({ ...src, invoices: 9, dateSpan: ['1999-01-01'], docTypes: { x: 1 } }, ROWS)).toMatchObject({ invoices: 9, dateSpan: ['1999-01-01'], docTypes: { x: 1 } });
    expect(metaOf({}, [])).toEqual({ invoices: 0, dateSpan: [], docTypes: {} });
  });

  it('matter: the profile narrative under plain headings, the parties first, empty fields left out', () => {
    const profile = {
      matter_full: 'Org A (Pty) Ltd v The Minister', short: 'A v M', we_act_for: 'Org A (Pty) Ltd', our_role: 'plaintiff', opponent: 'The Minister', opponent_type: 'organ of state',
      claim_type: 'Contractual claim for payment.', forum: 'Invented High Court, case 1/2002', headline_note: '', quantum_chain: 'invoice -> statement',
      discovery_affidavits: [{ file: 'AFFIDAVIT.pdf', ref: 'RT-003', date: '2023-06-13' }], existential_risk: 'Legality review.', interest_basis: { rate: 'prime + 5%', method: 'Simple' },
      out_of_scope: 'none', case_root: 'C:\\not\\rendered', folder_map: [{ folder: 'X' }],
    };
    expect(matterOf(profile, { matter: 'ignored', short: 'ignored' })).toEqual({
      title: 'Org A (Pty) Ltd v The Minister', short: 'A v M', forum: 'Invented High Court, case 1/2002',
      storyline: [
        { h: 'Parties', t: 'Org A (Pty) Ltd (plaintiff)\nThe Minister (organ of state)' },
        { h: 'The claim', t: 'Contractual claim for payment.' }, { h: 'Forum', t: 'Invented High Court, case 1/2002' }, { h: 'Quantum chain', t: 'invoice -> statement' },
        { h: 'Discovery affidavits', t: 'file: AFFIDAVIT.pdf, ref: RT-003, date: 2023-06-13' },
      ],
      strategy: [{ h: 'Existential risk', t: 'Legality review.' }, { h: 'Interest basis', t: 'rate: prime + 5%\nmethod: Simple' }, { h: 'Out of scope', t: 'none' }],
    });
    expect(matterOf({}, { matter: 'From META', short: 'FM' })).toEqual({ title: 'From META', short: 'FM', forum: '', storyline: [], strategy: [] });
  });

  it('quantum: a series row takes the filename of its chronology row, else its own title; the rest is carried over', () => {
    const q = { headline_due: '1.00', amountDueSeries: [{ ref: 'OD-002', title: 'T', amount: '1.00', date: '', url: '' }, { ref: 'XX-999', title: 'Own title', amount: '', date: '', url: '' }, 'not a row'], statementSeries: [{ ref: 'OD-001', filename: 'kept.pdf' }], postArb: 3 };
    expect(quantumOf(q, byRef)).toEqual({
      headline_due: '1.00', postArb: 3,
      amountDueSeries: [{ ref: 'OD-002', title: 'T', amount: '1.00', date: '', url: '', filename: 'OD-002 Invoice 1001.pdf' }, { ref: 'XX-999', title: 'Own title', amount: '', date: '', url: '', filename: 'Own title' }, 'not a row'],
      statementSeries: [{ ref: 'OD-001', filename: 'kept.pdf' }],
    });
  });

  it('contracts: doc_type from the chronology row, party and role empty, the signed reading as the note', () => {
    const c: J = { count: 2, groups: [{ key: 'G', items: [{ ref: 'OD-001', title: 'T', note: '', signed: 'Signed' }, { ref: 'OD-002', title: 'U', note: 'Kept', signed: 'Unclear', doc_type: 'own' }] }] };
    expect(contractsOf(c, byRef)).toEqual({ count: 2, groups: [{ key: 'G', items: [
      { ref: 'OD-001', title: 'T', note: 'Signed', signed: 'Signed', doc_type: 'SLA', party: '', role: '' },
      { ref: 'OD-002', title: 'U', note: 'Kept', signed: 'Unclear', doc_type: 'own', party: '', role: '' },
    ] }] });
  });

  it('filings: a note per group, a role per item, the seed in the v5 field names', () => {
    const f: J = { count: 1, groups: [{ key: 'Main', items: [{ ref: 'CB-021', title: 'T', cls: 'court' }] }], registerSeed: [{ filing: 'Summons', date: '2021-09-29', party: 'Plaintiff', answer: 'Plea', answerDate: '2023-11-16', note: 'N' }, { fdate: '', filing: 'v5 row', fparty: '', rdate: '', ref: '', response: '', status: 'S' }] };
    expect(filingsOf(f)).toEqual({ count: 1, groups: [{ key: 'Main', note: '', items: [{ ref: 'CB-021', title: 'T', cls: 'court', role: '' }] }], registerSeed: [
      { filing: 'Summons', date: '2021-09-29', party: 'Plaintiff', answer: 'Plea', answerDate: '2023-11-16', note: 'N', fdate: '2021-09-29', fparty: 'Plaintiff', rdate: '2023-11-16', ref: '', response: 'Plea', status: '' },
      { fdate: '', filing: 'v5 row', fparty: '', rdate: '', ref: '', response: '', status: 'S' },
    ] });
  });

  it('bundles: the list counts, each row\'s from, the sections keyed by number and the extracts list moved aside', () => {
    const b: J = {
      list: [{ no: '1', name: 'CORE BUNDLE', pages: 722, indexPages: 1, bodyPages: 721, items: 2, check: 'OK', rows: [{ n: 1, key: '1-1', desc: 'A', pages: 285, frm: 1, to: 285, parts: [] }, { n: 2, key: '1-2', desc: 'B', pages: 12, frm: 286, to: 297, parts: [] }] }],
      count: 1, caselinesSections: [{ sec: '002', first: 13, last: 309, stampFrom: 1, stampTo: 297, title: 'POC' }], extracts: [{ ref: 'CB-029', name: 'PL-1.pdf' }], caselinesSrc: './X.pdf', catalogue: {},
    };
    expect(bundlesOf(b)).toEqual({
      count: 1, source: '', indexSource: '', catalogue: {}, catCount: 0, extracts: '', extractFiles: [{ ref: 'CB-029', name: 'PL-1.pdf' }], caselinesSrc: './X.pdf',
      caselinesSections: { '002': { sec: '002', first: 13, last: 309, stampFrom: 1, stampTo: 297, title: 'POC', from: 13, to: 309 } },
      list: [{
        no: '1', name: 'CORE BUNDLE', pages: 722, indexPages: 1, bodyPages: 721, check: 'OK', slug: '1_CORE_BUNDLE', planFile: '', bundlePages: 721, filePages: 722,
        nDocs: 2, nItems: 2, nMissing: 0, nNeedsExtent: 0, nReview: 0, items: ['1-1', '1-2'],
        rows: [{ n: 1, key: '1-1', desc: 'A', pages: 285, frm: 1, from: 1, to: 285, parts: [] }, { n: 2, key: '1-2', desc: 'B', pages: 12, frm: 286, from: 286, to: 297, parts: [] }],
      }],
    });
    const v5 = (synthRoots().DATA as J).bundles as J;
    expect(bundlesOf(v5)).toEqual(v5);
  });

  it('caselines index: the page map as sorted [page, text] pairs, the file named from the CaseLines locator', () => {
    expect(caselinesIndexOf({ '2': 'two', '10': 'ten', '1': 'one' }, './PLEADINGS%20%26%20NOTICES/CASELINES%20BUNDLE.pdf', 0)).toEqual({ file: 'CASELINES BUNDLE.pdf', pages: 3, index: [[1, 'one'], [2, 'two'], [10, 'ten']] });
    expect(caselinesIndexOf({ '1': 'one' }, '', 1745)).toEqual({ file: '', pages: 1745, index: [[1, 'one']] });
  });

  it('discovery schedules: the Original and Supplementary schedules as the two v5 lists, the full list kept', () => {
    const pl1: J = { key: 'pl1', bundle: 'Original', items: [{ no: 3, desc: 'Letter', date: '2017-02-06', gap: true, files: [{ ref: 'OD-001', name: 'A.pdf', url: './A.pdf', pages: 5 }] }] };
    const def: J = { key: 'def', bundle: '', items: [{ no: 1, desc: 'Not held', date: '', files: [] }] };
    const pl2: J = { key: 'pl2', bundle: 'Supplementary', items: [{ no: 7, desc: 'Statement', date: '', files: [{ ref: 'SD-001', name: 'S.pdf', url: './S.pdf', x: 'filed under item 1' }] }] };
    expect(schedOf([pl1, def, pl2])).toEqual({
      discovery: [{ no: 3, desc: 'Letter', date: '2017-02-06', gap: true, co: '', nfiles: 1, files: [{ ref: 'OD-001', name: 'A.pdf', url: './A.pdf', pages: 5, fn: 'A.pdf', co: '' }] }],
      supplementary: [{ no: 7, desc: 'Statement', date: '', co: '', nfiles: 1, files: [{ ref: 'SD-001', name: 'S.pdf', url: './S.pdf', x: 'filed under item 1', fn: 'S.pdf', co: '' }] }],
      schedules: [pl1, def, pl2],
    });
  });

  it('converts a newer-shaped fixture into the mapped datasets, with no demotion for the mapped ones', async () => {
    const b = await buildSynth('newer-mapped', (r) => {
      r.META = { ...(r.META as J), version: 'V1' };
      delete (r.META as J).invoices; delete (r.META as J).dateSpan; delete (r.META as J).docTypes;
      r.DATA.matter = {};
      r.DATA.profile = { matter_full: 'Synthetic matter in full', short: 'SYN', forum: 'Invented forum', claim_type: 'A claim.' };
      for (const row of (r.DATA.quantum as J).amountDueSeries as J[]) { row.title = row.filename; delete row.filename; }
      for (const it of (r.DATA.contracts as J).groups[0].items as J[]) { delete it.doc_type; delete it.party; delete it.role; it.note = ''; it.signed = 'Signed'; }
      const filings = r.DATA.filings as J;
      delete filings.groups[0].note; filings.groups[0].items = (filings.groups[0].items as J[]).map(({ role: _r, ...it }) => ({ ...it, doc_type: 'pleading', party: '' }));
      filings.registerSeed = [{ filing: 'Statement of claim', date: '2001-04-05', party: 'Claimant', answer: 'None yet', answerDate: '', note: '' }];
      const b = r.DATA.bundles as J;
      delete b.source; delete b.indexSource; delete b.catCount; delete b.catalogue;
      b.caselinesSections = [{ sec: '001', first: 1, last: 2, title: 'Pleadings' }]; b.extracts = [{ ref: 'OD-001', name: 'x.pdf' }];
      for (const k of ['slug', 'planFile', 'bundlePages', 'filePages', 'nDocs', 'nItems', 'nMissing', 'nNeedsExtent', 'nReview']) delete b.list[0][k];
      b.list[0].items = 1; b.list[0].rows[0].frm = b.list[0].rows[0].from; delete b.list[0].rows[0].from;
      r.CASELINES = { '1': 'Page one', '2': 'Page two' };
      (r as J).SCHED = [{ key: 'pl1', bundle: 'Original', items: [{ no: 1, desc: 'Agreement', date: '2001-02-03', files: [{ ref: 'OD-001', name: 'OD-001 Supply agreement.pdf', url: url('DISCOVERY A/OD-001 Supply agreement.pdf') }] }] }];
    });
    roots.push(b.root);
    expect(b.result.source!.generation).toBe('v5-js-newer');
    expect(b.result.diagnostics.filter((d) => d.code === 'V5_DATASET_SHAPE_UNMAPPED')).toEqual([]);
    expect(datasetKeys(b)).toEqual(expect.arrayContaining(['matter', 'meta', 'quantum', 'v5-residual-profile']));
    expect(dataset(b, 'meta')).toMatchObject({ version: 'V1', invoices: 1, dateSpan: ['2001-02-03', '2001-02-28'] });
    expect(dataset(b, 'matter')).toEqual({ title: 'Synthetic matter in full', short: 'SYN', forum: 'Invented forum', storyline: [{ h: 'The claim', t: 'A claim.' }, { h: 'Forum', t: 'Invented forum' }], strategy: [] });
    expect((dataset(b, 'quantum') as J).amountDueSeries[0]).toMatchObject({ ref: 'OD-002', filename: 'OD-002 Invoice 1001.pdf', title: 'OD-002 Invoice 1001.pdf' });
    expect(datasetKeys(b)).toEqual(expect.arrayContaining(['contracts', 'filings', 'bundles', 'caselines-index', 'discovery-schedules']));
    expect((dataset(b, 'contracts') as J).groups[0].items[0]).toMatchObject({ doc_type: 'SLA', note: 'Signed', party: '', role: '' });
    expect((dataset(b, 'filings') as J).registerSeed[0]).toMatchObject({ fdate: '2001-04-05', filing: 'Statement of claim', fparty: 'Claimant', response: 'None yet' });
    expect((dataset(b, 'bundles') as J).list[0]).toMatchObject({ slug: '1_Bundle_A', nDocs: 1, items: ['OD-1'], rows: [{ from: 1 }] });
    expect(dataset(b, 'caselines-index')).toEqual({ file: 'OD-001 Supply agreement.pdf', pages: 2, index: [[1, 'Page one'], [2, 'Page two']] });
    expect((dataset(b, 'discovery-schedules') as J).discovery[0]).toMatchObject({ no: 1, nfiles: 1, files: [{ fn: 'OD-001 Supply agreement.pdf' }] });
    const r = await importCandidate(b.pkgDir, b.caseDir);
    expect(r.verdict).toBe('report');
  });
});
