// GRS-22: the three workspace generations through the one results-package contract. Generation detection is explicit
// and refuses what nobody has inventoried, every top-level source dataset is accounted for, record fields the v5 shape
// has no place for are kept, row positions arrive as the source wrote them, and a ref reused for another original never
// carries an anchor across. Every value below is invented.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DiagSink } from '../../src/lib/case-package/diagnostics.ts';
import { importCandidate } from '../../src/lib/case-package/import.ts';
import { decodeUtf8Strict, parseStrictJson, type JsonObject } from '../../src/lib/case-package/strict-json.ts';
import { isRef } from '../../src/lib/case-package/refs.ts';
import { matchAnchor } from '../../src/lib/case-package/user-work.ts';
import { convertV5 } from '../../src/lib/case-package/v5/adapter.ts';
import { extractV5 } from '../../src/lib/case-package/v5/extract.ts';
import { accountFor, packageDatasets, sourceKeys } from './compat/account.ts';
import { buildSynth } from './fixtures/build.ts';
import { cleanup, synthHtml, synthOriginals, synthRoots, tempDir, writeCaseFolder } from './fixtures/synth.ts';

type J = Record<string, any>;
const roots: string[] = [];
afterAll(async () => { for (const r of roots) await cleanup(r); });
const url = (p: string) => './' + p.split('/').map(encodeURIComponent).join('/');
const AGREEMENT = 'DISCOVERY A/OD-001 Supply agreement.pdf', INVOICE = 'DISCOVERY A/OD-002 Invoice 1001.pdf';
const size = (p: string) => synthOriginals()[p]!.byteLength;
const dataset = (files: Map<string, Uint8Array>, key: string) => (parseStrictJson(decodeUtf8Strict(files.get(`datasets/${key}.json`)!)) as { data: any }).data;
const assetsOf = (files: Map<string, Uint8Array>) => (parseStrictJson(decodeUtf8Strict(files.get('assets.json')!)) as { assets: Record<string, J> }).assets;
const subjects = (ds: readonly { subject?: string | null }[]) => new Set(ds.map((d) => d.subject ?? ''));

async function caseFolder(tag: string): Promise<string> {
  const root = await tempDir(tag);
  roots.push(root);
  await writeCaseFolder(path.join(root, 'case'));
  return path.join(root, 'case');
}
const listing = async (dir: string) => (await readdir(dir, { recursive: true })).sort();

function jsonHtml(appData: J, appSeed: J): Uint8Array {
  const tag = (id: string, v: J) => `<script id="${id}" type="application/json">${JSON.stringify(v).replace(/</g, '\\u003c')}</script>`;
  return new TextEncoder().encode(['<!DOCTYPE html>', '<html><body>', tag('app-data', appData), tag('app-seed', appSeed), '<script>var DATA = JSON.parse(document.getElementById("app-data").textContent);</script>', '</body></html>', ''].join('\n'));
}
const jsonRow = (o: J): J => ({ n: 1, ref: 'DC-SYN-001', date: '2001-02-03', ds: 'text', fn: 'OD-001 Supply agreement.pdf', sj: '', sd: '', to: '', cc: '', ex: 'Head', st: 'Head and the rest', dt: 'sale agreement', amt: null, ai: [], ts: 'extracted', url: url(AGREEMENT), sz: size(AGREEMENT), bd: 'Original', ...o });

describe('generation detection', () => {
  const generation = (edit: (r: ReturnType<typeof synthRoots>) => void) => {
    const r = synthRoots();
    edit(r);
    const sink = new DiagSink();
    const src = extractV5(synthHtml(r), sink);
    return { generation: src?.generation ?? null, errors: sink.finish().filter((d) => d.severity === 'error').map((d) => [d.code, d.subject]) };
  };

  it('names the newer builder by the version it was inventoried at', () => {
    expect(generation(() => {})).toEqual({ generation: 'v5-js', errors: [] });
    expect(generation((r) => { r.META.version = 'V1'; })).toEqual({ generation: 'v5-js-newer', errors: [] });
  });

  it('refuses a builder version nobody has inventoried, also when it is not text', () => {
    for (const version of ['V2', 'v1', '', 2, null, { major: 1 }]) {
      expect(generation((r) => { r.META.version = version; })).toEqual({ generation: null, errors: [['VER_UNSUPPORTED', 'META.version']] });
    }
  });

  it('converts nothing from a refused generation and leaves the received input as it was', async () => {
    const dir = await caseFolder('refuse-generation');
    const before = await listing(dir);
    const r = synthRoots();
    r.META.version = 'V2';
    const html = synthHtml(r);
    const copy = html.slice();
    const res = await convertV5({ html, htmlName: 'workspace.html', caseFolder: dir, caseId: 'synthetic-case' });
    expect(res.ok).toBe(false);
    expect(res.files).toBeNull();
    expect(res.manifest).toBeNull();
    expect(res.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code)).toEqual(['VER_UNSUPPORTED']);
    expect(res.diagnostics.find((d) => d.code === 'VER_UNSUPPORTED')!.message).toContain('"V2"');
    expect(html).toEqual(copy);
    expect(await listing(dir)).toEqual(before);
  });

  it('refuses an HTML that carries neither the payload lines nor the app-data script', async () => {
    const dir = await caseFolder('refuse-unknown');
    const html = new TextEncoder().encode('<!DOCTYPE html>\n<html><body><script>var data = {"chronology": []};</script></body></html>\n');
    const res = await convertV5({ html, htmlName: 'workspace.html', caseFolder: dir, caseId: 'synthetic-case' });
    expect(res.files).toBeNull();
    expect(res.diagnostics.filter((d) => d.severity === 'error').map((d) => [d.code, d.subject])).toEqual([['V5_PAYLOAD_MISSING', 'DATA'], ['V5_PAYLOAD_MISSING', 'META']]);
  });
});

describe('every top-level source dataset is accounted for', () => {
  it('the newer generation: the 24 DATA keys, META and both auxiliary roots, the new datasets residual and reported', async () => {
    const NEW = { anchors: [], emails: { rows: [{ ref: 'OD-001' }], threads: [], gaps: [] }, organogram: { nodes: [], edges: [] }, profile: { short: 'SYN' }, text: { 'OD-001': 'Invented text.' }, transcripts: [{ ref: 'OD-001', pages: 2 }], whatsapp: { chats: [], media: {} } };
    const b = await buildSynth('account-newer', (r) => {
      r.META.version = 'V1';
      Object.assign(r.DATA, NEW);
    });
    roots.push(b.root);
    const r = synthRoots();
    Object.assign(r.DATA, NEW);
    const keys = sourceKeys('v5-js-newer', { DATA: r.DATA as never, META: r.META as never, sched: r.SCHED as never, caselines: r.CASELINES as never });
    expect([...keys.keys()].filter((k) => k.startsWith('DATA.'))).toHaveLength(24);
    const account = accountFor('v5-js-newer', keys, packageDatasets(b.files), subjects(b.result.diagnostics));
    expect(account.filter((a) => a.state === 'unaccounted' || a.state === 'dropped')).toEqual([]);
    expect(account.filter((a) => a.state === 'residual').map((a) => a.source).sort()).toEqual(['DATA.anchors', 'DATA.emails', 'DATA.organogram', 'DATA.profile', 'DATA.text', 'DATA.transcripts', 'DATA.whatsapp']);
    expect(account.filter((a) => a.state === 'empty').map((a) => a.source)).toEqual([]);
    expect(account.find((a) => a.source === 'DATA.anchors')).toEqual({ source: 'DATA.anchors', state: 'residual', datasets: ['v5-residual-anchors'] });
    expect(account.find((a) => a.source === 'DATA.lit')!.datasets).toContain('lit-presc-summary');
    expect(account.find((a) => a.source === 'window.__SCHED__')).toEqual({ source: 'window.__SCHED__', state: 'mapped', datasets: ['discovery-schedules'] });
    expect(account.find((a) => a.source === 'window.__CASELINES_IDX__')).toEqual({ source: 'window.__CASELINES_IDX__', state: 'mapped', datasets: ['caselines-index'] });
    expect(b.result.diagnostics.filter((d) => d.code === 'V5_UNMAPPED_KEY').map((d) => [d.severity, d.subject]).sort()).toEqual(Object.keys(NEW).map((k) => ['warning', `DATA.${k}`]).sort());
  });

  it('the JSON script: every app-data and app-seed key is mapped, kept residual, or dropped with a diagnostic', async () => {
    const appData: J = { chronology: [jsonRow({})], meta: { builtAt: '2002-06-07 08:09', docCount: 1 }, people: [], entities: [], agreements: [], contradictions: [], hot: [{ ref: 'DC-SYN-001', why: 'x' }], threads: [{ k: 't' }], ft: { a: '1' }, pages: { 'DC-SYN-001': 2 } };
    const appSeed: J = { client: 'Synthetic client', matters: [], risk: [{ id: 'R1', risk: 'Invented.', l: 2, i: 3, mit: '', owner: 'Owner One', type: 'Legal' }], vdm: [], inforeq: [], witnesses: [], elements: [], authorities: [], discovery: [], settlement: [{ matter: 'A' }], conflict_note: 'Invented.' };
    const dir = await caseFolder('account-json');
    const res = await convertV5({ html: jsonHtml(appData, appSeed), htmlName: 'workspace.html', caseFolder: dir, caseId: 'synthetic-case' });
    expect(res.files).not.toBeNull();
    const account = accountFor('json-script', sourceKeys('json-script', { appData, appSeed }), packageDatasets(res.files!), subjects(res.diagnostics));
    expect(account.filter((a) => a.state === 'unaccounted')).toEqual([]);
    expect(account.find((a) => a.source === 'app-data.ft')!.state).toBe('dropped');
    expect(Object.fromEntries(account.map((a) => [a.source, a.state]))).toEqual({
      'app-data.chronology': 'mapped', 'app-data.meta': 'mapped', 'app-data.people': 'mapped', 'app-data.entities': 'mapped', 'app-data.agreements': 'empty', 'app-data.contradictions': 'empty',
      'app-data.hot': 'mapped', 'app-data.threads': 'residual', 'app-data.ft': 'dropped', 'app-data.pages': 'residual',
      'app-seed.client': 'mapped', 'app-seed.matters': 'mapped', 'app-seed.risk': 'mapped', 'app-seed.vdm': 'empty', 'app-seed.inforeq': 'empty', 'app-seed.witnesses': 'empty',
      'app-seed.elements': 'empty', 'app-seed.authorities': 'empty', 'app-seed.discovery': 'empty', 'app-seed.settlement': 'residual', 'app-seed.conflict_note': 'residual',
    });
  });
});

describe('the JSON script keeps what the v5 shape has no place for', () => {
  it('carries every record field the mapping does not read, reported as unsupported rather than lost', async () => {
    const appData: J = {
      chronology: [jsonRow({ ext: '.pdf', na: 0, tl: 4000, pv: 1, pvk: 'k1', sh: 1, zz: 'kept' })],
      meta: { builtAt: '2002-06-07 08:09' }, people: [{ name: 'Ann Lee', sent: 1, recv: 0, role: 'Director', zz: 'kept' }], entities: [{ name: 'Org A Ltd', role: 'Claimant', zz: 'kept' }],
      agreements: [{ ref: 'DC-SYN-001', n: 1, date: '2001-02-03', ent: 'Org A Ltd', fn: 'OD-001 Supply agreement.pdf', dt: 'sale agreement', url: url(AGREEMENT), ex: 'Head', zz: 'kept' }],
      contradictions: [{ kind: 'Divergent figures', ent: 'Org A Ltd', year: '2001', dt: 'invoice', lo: null, hi: null, sev: 'Low', gap: null, refs: ['DC-SYN-001'], note: 'n', zz: 'kept' }],
      bundles: { folder: './BUNDLES/', source: 's', indexSource: 'i', caselinesSrc: '', zz: 'kept', headerDefaults: { court: 'C', zz: 'kept' }, list: [{ no: '1', name: 'CORE', pages: 2, zz: 'kept', rows: [{ n: 1, key: 'DC-SYN-001', desc: 'd', from: 1, to: 2, pages: 2, zz: 'kept', parts: [{ name: 'p', rel: AGREEMENT, url: url(AGREEMENT), from: 1, to: 2, zz: 'kept' }] }] }] },
    };
    const appSeed: J = {
      risk: [{ id: 'R1', risk: 'Invented.', l: 2, i: 3, mit: '', zz: 'kept' }], vdm: [{ matter: 'A', opponent: 'B', contention: 'c', evidence: 'e', rebuttal: 'r', zz: 'kept' }],
      inforeq: [{ doc: 'd', src: 's', pri: 'P1', zz: 'kept' }], witnesses: [{ name: 'Ann Lee', role: 'r', scope: 's', zz: 'kept' }], elements: [{ cause: 'c', els: ['a'], ev: 'e', wit: 'w', zz: 'kept' }],
      authorities: [{ src: 's', cite: 'c', prop: 'p', matter: 'A', zz: 'kept' }], discovery: [{ doc: 'd', date: '', co: '', zz: 'kept' }],
    };
    const dir = await caseFolder('json-keep');
    const res = await convertV5({ html: jsonHtml(appData, appSeed), htmlName: 'workspace.html', caseFolder: dir, caseId: 'synthetic-case' });
    expect(res.files).not.toBeNull();
    const f = res.files!;
    expect(dataset(f, 'chronology')[0]).toMatchObject({ ext: '.pdf', na: 0, tl: 4000, pv: 1, pvk: 'k1', sh: 1, zz: 'kept' });
    const kept = [
      dataset(f, 'people')[0], dataset(f, 'entities')[0], dataset(f, 'contracts').groups[0].items[0], dataset(f, 'contradictions').categories[0].items[0],
      dataset(f, 'bundles'), dataset(f, 'bundles').headerDefaults, dataset(f, 'bundles').list[0], dataset(f, 'bundles').list[0].rows[0], dataset(f, 'bundles').list[0].rows[0].parts[0],
      dataset(f, 'risk-matrix')[0], dataset(f, 'defence-matrix')[0], dataset(f, 'info-required')[0], dataset(f, 'witnesses')[0], dataset(f, 'lit-elements')[0], dataset(f, 'lit-authorities')[0],
      dataset(f, 'discovery-schedules').discovery[0],
    ];
    expect(kept.map((x) => x.zz)).toEqual(kept.map(() => 'kept'));
    expect(dataset(f, 'contracts').groups[0].items[0]).not.toHaveProperty('n');
    const r = await importCandidate({ files: f }, dir);
    expect(r.verdict).toBe('report');
    const unsupported = r.diagnostics.filter((d) => d.code === 'DS_UNSUPPORTED_FIELD').map((d) => `${d.file} ${d.subject}`);
    for (const field of ['ext', 'na', 'tl', 'pv', 'pvk', 'sh', 'zz']) expect(unsupported).toContain(`datasets/chronology.json ${field}`);
  });
});

describe('row positions as the source wrote them', () => {
  it('keeps a JSON-script position written as text, and numbers as numbers, in source order', async () => {
    const appData: J = { chronology: [jsonRow({ n: '12' }), jsonRow({ n: 3, ref: 'DC-SYN-002', fn: 'OD-002 Invoice 1001.pdf', url: url(INVOICE), sz: size(INVOICE) })], meta: { builtAt: '2002-06-07 08:09' } };
    const dir = await caseFolder('json-positions');
    const res = await convertV5({ html: jsonHtml(appData, {}), htmlName: 'workspace.html', caseFolder: dir, caseId: 'synthetic-case' });
    const rows = dataset(res.files!, 'chronology') as J[];
    expect(rows.map((x) => [x.ref, x.n, x.seq])).toEqual([['DC-SYN-001', '12', '12'], ['DC-SYN-002', 3, 3]]);
    expect((await importCandidate({ files: res.files! }, dir)).verdict).not.toBe('reject');
  });

  it('imports the newer generation\'s numeric positions beside v5\'s text ones, unchanged and in source order', async () => {
    const b = await buildSynth('newer-positions', (r) => {
      r.META.version = 'V1';
      (r.DATA.chronology as J[]).forEach((row, i) => { row.n = i + 1; row.seq = i + 1; });
      (r.DATA.chronology as J[]).reverse();
    });
    roots.push(b.root);
    const rows = dataset(b.files, 'chronology') as J[];
    expect(rows.map((x) => [typeof x.n, typeof x.seq])).toEqual(rows.map(() => ['number', 'number']));
    expect(rows.map((x) => x.n)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect((await importCandidate(b.pkgDir, b.caseDir)).verdict).not.toBe('reject');
  });
});

describe('a ref reused for another original across generations', () => {
  it('never re-attaches an anchor by ref: it follows the original\'s fingerprint, or is missing', async () => {
    const v5 = await buildSynth('reuse-v5', undefined, { caseId: 'one-case' });
    roots.push(v5.root);
    const newer = await buildSynth('reuse-newer', (r) => {
      r.META.version = 'V1';
      const rows = r.DATA.chronology as J[];
      const od1 = rows.find((x) => x.ref === 'OD-001')!, od2 = rows.find((x) => x.ref === 'OD-002')!, sd1 = rows.find((x) => x.ref === 'SD-001')!;
      for (const k of ['url', 'filename', 'size']) [od1[k], od2[k]] = [od2[k], od1[k]];
      r.DATA.chronology = rows.filter((x) => x !== sd1);
    }, { caseId: 'one-case' });
    roots.push(newer.root);
    const before = assetsOf(v5.files), after = assetsOf(newer.files);
    expect(after['OD-001']!.sha256).not.toBe(before['OD-001']!.sha256);
    const originals = Object.entries(after).filter(([ref, a]) => a.kind === 'file' && isRef(ref)).map(([ref, a]) => ({ ref, sha256: a.sha256 as string }));
    const anchor = (ref: string) => ({ caseId: 'one-case', sha256: before[ref]!.sha256 as string, refAtCreation: ref, resultsVersion: v5.result.manifest!.resultsVersion });
    expect(matchAnchor(anchor('OD-001'), originals)).toEqual({ status: 'exact', ref: 'OD-002' });
    expect(matchAnchor(anchor('OD-002'), originals)).toEqual({ status: 'exact', ref: 'OD-001' });
    expect(matchAnchor(anchor('SD-001'), originals)).toEqual({ status: 'missing' });
    expect(matchAnchor(anchor('OD-003'), originals)).toEqual({ status: 'exact', ref: 'OD-003' });
  });
});

describe('the storyline shapes of each generation', () => {
  it('JSON-script storyline pairs and the newer profile both arrive as v5 headings', async () => {
    const appSeed: J = { client: 'Synthetic client', matters: [{ id: 'A', title: 'A v B', sub: '', forum: 'F', parties: 'A v B', posture: 'P', storyline: [['I. Start', 'Began.'], ['II. Then', 'Went on.']], strategy: [['1. Plan', 'Win.']] }] };
    const dir = await caseFolder('storyline-json');
    const res = await convertV5({ html: jsonHtml({ chronology: [jsonRow({})], meta: { builtAt: '2002-06-07 08:09' } }, appSeed), htmlName: 'workspace.html', caseFolder: dir, caseId: 'synthetic-case' });
    expect((dataset(res.files!, 'matter') as JsonObject).storyline).toEqual([{ h: 'Matter A: A v B', t: 'A v B\nF\nP' }, { h: 'I. Start', t: 'Began.' }, { h: 'II. Then', t: 'Went on.' }]);
    const b = await buildSynth('storyline-newer', (r) => { r.META.version = 'V1'; r.DATA.matter = {}; r.DATA.profile = { matter_full: 'Synthetic matter', claim_type: 'A claim.', existential_risk: 'A risk.' }; });
    roots.push(b.root);
    expect(dataset(b.files, 'matter')).toMatchObject({ title: 'Synthetic matter', storyline: [{ h: 'The claim', t: 'A claim.' }], strategy: [{ h: 'Existential risk', t: 'A risk.' }] });
  });
});

describe('source keys that name Object.prototype members', () => {
  // The strict parser keeps "__proto__" as an own data property; the adapter must too, and must count such names right.
  const odd = (s: string) => JSON.parse(s) as J;

  it('JSON script: kept on the record, counted in the tallies, and kept as residual datasets', async () => {
    const appData = odd(`{"chronology": [${JSON.stringify(jsonRow({ dt: 'constructor' })).slice(0, -1)}, "__proto__": {"x": 1}, "constructor": "kept"}, ${JSON.stringify(jsonRow({ ref: 'DC-SYN-002', dt: '__proto__', fn: 'OD-002 Invoice 1001.pdf', url: url(INVOICE), sz: size(INVOICE) }))}],
      "meta": {"builtAt": "2002-06-07 08:09"}, "__proto__": {"y": 2}}`);
    const appSeed = odd('{"constructor": "seed value"}');
    const dir = await caseFolder('json-proto');
    const res = await convertV5({ html: jsonHtml(appData, appSeed), htmlName: 'workspace.html', caseFolder: dir, caseId: 'synthetic-case' });
    expect(res.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const f = res.files!;
    const row = dataset(f, 'chronology')[0] as J;
    expect(Object.hasOwn(row, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(row, '__proto__')!.value).toEqual({ x: 1 });
    expect(row.constructor).toBe('kept');
    expect(JSON.stringify(dataset(f, 'meta').docTypes)).toBe('{"__proto__":1,"constructor":1}');
    expect(JSON.stringify(dataset(f, 'timeline-type-by-year'))).toBe('{"2001":{"__proto__":1,"constructor":1}}');
    expect(Object.getOwnPropertyDescriptor(dataset(f, 'v5-residual-proto'), 'y')!.value).toBe(2);
    expect(dataset(f, 'v5-residual-constructor')).toBe('seed value');
    expect((await importCandidate({ files: f }, dir)).verdict).not.toBe('reject');
  });

  it('newer generation: the META tallies and the CaseLines index keep such names', async () => {
    const b = await buildSynth('newer-proto', (r) => {
      r.META.version = 'V1';
      delete (r.META as J).docTypes;
      (r.DATA.chronology as J[])[0]!.doc_type = 'constructor';
      (r.DATA.chronology as J[])[1]!.doc_type = '__proto__';
      r.CASELINES = odd('{"1": "Page one", "__proto__": "not a page"}');
    });
    roots.push(b.root);
    const docTypes = dataset(b.files, 'meta').docTypes as J;
    expect(Object.getOwnPropertyDescriptor(docTypes, '__proto__')!.value).toBe(1);
    expect(Object.getOwnPropertyDescriptor(docTypes, 'constructor')!.value).toBe(1);
    const idx = dataset(b.files, 'caselines-index') as J;
    expect(idx.index).toEqual([[1, 'Page one']]);
    expect(Object.getOwnPropertyDescriptor(idx, '__proto__')!.value).toBe('not a page');
  });
});
