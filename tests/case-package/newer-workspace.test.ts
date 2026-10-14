// The newer builder of the v5 workspace HTML: its generation is recognised, and a dataset whose shape the converter
// does not map is demoted to an opaque residual instead of refusing the case. Every value below is invented.
import { afterAll, describe, expect, it } from 'vitest';
import { DiagSink } from '../../src/lib/case-package/diagnostics.ts';
import { importCandidate } from '../../src/lib/case-package/import.ts';
import { extractV5 } from '../../src/lib/case-package/v5/extract.ts';
import { matterOf, metaOf, quantumOf } from '../../src/lib/case-package/v5/newer-workspace.ts';
import { decodeUtf8Strict, parseStrictJson } from '../../src/lib/case-package/strict-json.ts';
import { buildSynth } from './fixtures/build.ts';
import { cleanup, synthHtml, synthRoots } from './fixtures/synth.ts';

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

  it('converts a newer-shaped fixture into the mapped datasets, with no demotion for the mapped ones', async () => {
    const b = await buildSynth('newer-mapped', (r) => {
      r.META = { ...(r.META as J), version: 'V1' };
      delete (r.META as J).invoices; delete (r.META as J).dateSpan; delete (r.META as J).docTypes;
      r.DATA.matter = {};
      r.DATA.profile = { matter_full: 'Synthetic matter in full', short: 'SYN', forum: 'Invented forum', claim_type: 'A claim.' };
      for (const row of (r.DATA.quantum as J).amountDueSeries as J[]) { row.title = row.filename; delete row.filename; }
    });
    roots.push(b.root);
    expect(b.result.source!.generation).toBe('v5-js-newer');
    expect(b.result.diagnostics.filter((d) => d.code === 'V5_DATASET_SHAPE_UNMAPPED')).toEqual([]);
    expect(datasetKeys(b)).toEqual(expect.arrayContaining(['matter', 'meta', 'quantum', 'v5-residual-profile']));
    expect(dataset(b, 'meta')).toMatchObject({ version: 'V1', invoices: 1, dateSpan: ['2001-02-03', '2001-02-28'] });
    expect(dataset(b, 'matter')).toEqual({ title: 'Synthetic matter in full', short: 'SYN', forum: 'Invented forum', storyline: [{ h: 'The claim', t: 'A claim.' }, { h: 'Forum', t: 'Invented forum' }], strategy: [] });
    expect((dataset(b, 'quantum') as J).amountDueSeries[0]).toMatchObject({ ref: 'OD-002', filename: 'OD-002 Invoice 1001.pdf', title: 'OD-002 Invoice 1001.pdf' });
    const r = await importCandidate(b.pkgDir, b.caseDir);
    expect(r.verdict).toBe('report');
  });
});
