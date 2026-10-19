// GRS-22 fix round (M2, M3): nothing a mapper reads may vanish, and one odd field may not demote a matrix.
// Every read key of every JSON-script record kind (READ in json-workspace.ts) is set to a unique marker, then to a
// value of the wrong type; each marker must come out somewhere in the mapped DATA. A key that is meant to be absorbed
// is named in ABSORBED with its reason. Every value below is invented.
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DiagSink } from '../../src/lib/case-package/diagnostics.ts';
import { importCandidate } from '../../src/lib/case-package/import.ts';
import { decodeUtf8Strict, parseStrictJson, type JsonObject } from '../../src/lib/case-package/strict-json.ts';
import { convertV5 } from '../../src/lib/case-package/v5/adapter.ts';
import { contradictionsOf, READ, toV5Roots } from '../../src/lib/case-package/v5/json-workspace.ts';
import { mapNewerRoots } from '../../src/lib/case-package/v5/newer-workspace.ts';
import { buildSynth } from './fixtures/build.ts';
import { cleanup, tempDir, writeCaseFolder } from './fixtures/synth.ts';

type J = Record<string, any>;
type List = keyof typeof READ;
type Kind = 'str' | 'num' | 'pos' | 'amount' | 'strs' | 'bool' | 'pairs' | 'nested';

/** The type each read key arrives as; every key not named is text. */
const KINDS: Partial<Record<List, Record<string, Kind>>> = {
  row: { n: 'pos', amt: 'amount', ai: 'strs', sz: 'num' },
  contradiction: { refs: 'strs', lo: 'amount', hi: 'amount', gap: 'amount' },
  person: { sent: 'num', recv: 'num' },
  risk: { l: 'num', i: 'num' },
  element: { els: 'strs' },
  agreement: { n: 'pos' },
  bundle: { pages: 'num', filePages: 'num', indexPages: 'num', rows: 'nested' },
  bundleRow: { n: 'num', from: 'num', to: 'num', pages: 'num', blank: 'bool', missing: 'bool', review: 'bool', parts: 'nested' },
  bundlePart: { from: 'num', to: 'num' },
  bundles: { headerDefaults: 'nested', list: 'nested' },
  matter: { storyline: 'pairs', strategy: 'pairs' },
};

/** Keys the mapper absorbs into another field without writing them out, and why. Empty: every read key lands. */
const ABSORBED: Partial<Record<List, Record<string, string>>> = {};

const kindOf = (list: List, key: string): Kind => (KINDS[list] as Record<string, Kind> | undefined)?.[key] ?? 'str';

/** Where a record of each kind sits in the source (app-data or app-seed). */
const EMBED: Record<List, (rec: J) => { data?: J; seed?: J }> = {
  row: (rec) => ({ data: { chronology: [rec] } }),
  contradiction: (rec) => ({ data: { contradictions: [rec] } }),
  person: (rec) => ({ data: { people: [rec] } }),
  entity: (rec) => ({ data: { entities: [rec] } }),
  risk: (rec) => ({ seed: { risk: [rec] } }),
  defence: (rec) => ({ seed: { vdm: [rec] } }),
  info: (rec) => ({ seed: { inforeq: [rec] } }),
  witness: (rec) => ({ seed: { witnesses: [rec] } }),
  element: (rec) => ({ seed: { elements: [rec] } }),
  authority: (rec) => ({ seed: { authorities: [rec] } }),
  discovery: (rec) => ({ seed: { discovery: [rec] } }),
  agreement: (rec) => ({ data: { agreements: [rec] } }),
  bundle: (rec) => ({ data: { bundles: { list: [rec] } } }),
  bundleRow: (rec) => ({ data: { bundles: { list: [{ rows: [rec] }] } } }),
  bundlePart: (rec) => ({ data: { bundles: { list: [{ rows: [{ parts: [rec] }] }] } } }),
  bundles: (rec) => ({ data: { bundles: { list: [], ...rec } } }),
  matter: (rec) => ({ seed: { matters: [rec] } }),
};

const marker = (list: string, key: string, tag = 'M') => `${tag}~${list}~${key}`;
function valueOf(list: List, key: string, kind: Kind, i: number): { value: unknown; needles: string[] } {
  const m = marker(list, key);
  switch (kind) {
    case 'num': case 'pos': return { value: 4_000_000 + i, needles: [String(4_000_000 + i)] };
    case 'amount': return { value: 5_000_000.25 + i, needles: [String(5_000_000.25 + i)] };
    case 'strs': return { value: [m], needles: [m] };
    case 'bool': return { value: true, needles: [`"${key}":true`] };
    case 'pairs': return { value: [[m + '~h', m + '~t']], needles: [m + '~h', m + '~t'] };
    default: return { value: m, needles: [m] };
  }
}

const mapped = (list: List, rec: J): string => {
  const e = EMBED[list](rec);
  const roots = toV5Roots((e.data ?? {}) as JsonObject, (e.seed ?? {}) as JsonObject, new DiagSink(100));
  return JSON.stringify([roots.DATA, roots['window.__SCHED__']]);
};

describe('every read key of the JSON script lands in the mapped record (M3)', () => {
  for (const list of Object.keys(READ) as List[]) {
    const keys = READ[list] as readonly string[];
    // a nested key carries the records of the next list; the sweep walks those as their own list
    const flat = keys.filter((k) => kindOf(list, k) !== 'nested');

    it(`${list}: ${flat.length} keys, set together`, () => {
      const rec: J = {};
      const needles: [string, string][] = [];
      flat.forEach((k, i) => { const v = valueOf(list, k, kindOf(list, k), i); rec[k] = v.value; for (const n of v.needles) needles.push([k, n]); });
      const out = mapped(list, rec);
      const missing = needles.filter(([k, n]) => !ABSORBED[list]?.[k] && !out.includes(n)).map(([k]) => k);
      expect(missing).toEqual([]);
    });

    it(`${list}: a value of the wrong type is kept, not read as empty`, () => {
      const missing: string[] = [];
      for (const k of flat) {
        const m = marker(list, k, 'W');
        const out = mapped(list, { [k]: { w: m } });
        if (!ABSORBED[list]?.[k] && !out.includes(m)) missing.push(k);
      }
      expect(missing).toEqual([]);
    });
  }

  it('contradictions: each item keeps its own severity, the category the highest', () => {
    const list = ['Low', 'High', 'Medium'].map((sev, i) => ({ kind: 'Divergent figures', ent: `E${i}`, year: '2001', dt: 'invoice', note: 'n', refs: [], sev }));
    const out = contradictionsOf(list as never, new Map()) as J;
    expect(out.categories).toHaveLength(1);
    expect(out.categories[0].severity).toBe('high');
    expect(out.categories[0].items.map((x: J) => x.sev)).toEqual(['Low', 'High', 'Medium']);
    expect(out.highCount).toBe(1);
  });

  it('a row\'s `ex` that is not the head of its `st` is kept; one that is, is not repeated', () => {
    const row = (o: J) => (JSON.parse(mapped('row', { ref: 'R-1', ...o }))[0].chronology[0]) as J;
    expect(row({ st: 'The whole text', ex: 'The whole' })).not.toHaveProperty('ex');
    expect(row({ st: 'The whole text', ex: 'Another note' })).toMatchObject({ excerpt: 'The whole text', ex: 'Another note' });
    expect(row({ st: '', ex: 'Only the head' })).toMatchObject({ excerpt: 'Only the head' });
  });

  it('an agreement\'s `n` is dropped only when its chronology row carries the same position', () => {
    const contracts = (n: number) => {
      const data = { chronology: [{ ref: 'R-1', n: 1 }], agreements: [{ ref: 'R-1', n }] };
      const roots = toV5Roots(data as never, {}, new DiagSink(100));
      return ((roots.DATA as J).contracts.groups[0].items[0]) as J;
    };
    expect(contracts(1)).not.toHaveProperty('n');
    expect(contracts(2)).toMatchObject({ n: 2 });
  });

  it('an empty `pr` or `ds` says nothing and is not written', () => {
    const row = JSON.parse(mapped('row', { ref: 'R-1', pr: '', ds: '' }))[0].chronology[0] as J;
    expect(row).not.toHaveProperty('pr');
    expect(row).not.toHaveProperty('date_source');
  });

  it('an amount the grammar cannot hold stays on the row under its own name', () => {
    const row = JSON.parse(mapped('row', { ref: 'R-1', amt: 'R 1 150,00' }))[0].chronology[0] as J;
    expect(row.amount).toBe('');
    expect(row.amt).toBe('R 1 150,00');
  });
});

describe('the newer builder\'s mappers keep every source key (M3)', () => {
  it('writes every key of every mapped structure to the output, at its own path', () => {
    const leaves = (v: unknown, p: string, out: [string, string][]): void => {
      if (typeof v === 'string') out.push([p, v]);
      else if (Array.isArray(v)) v.forEach((x, i) => leaves(x, `${p}/${i}`, out));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) leaves(x, `${p}/${k}`, out);
    };
    const m = (s: string) => `N~${s}`;
    const DATA: J = {
      chronology: [{ ref: m('chron.ref'), filename: m('chron.filename'), doc_type: m('chron.doc_type'), unread: m('chron.unread') }],
      profile: { matter_full: m('profile.matter_full'), forum: m('profile.forum'), claim_type: m('profile.claim_type'), notes: m('profile.notes'), extra: m('profile.extra') },
      quantum: { amountDueSeries: [{ ref: m('q.ref'), title: m('q.title'), extra: m('q.extra') }], headline_due: m('q.due') },
      contracts: { count: m('c.count'), groups: [{ key: m('c.key'), items: [{ ref: m('c.ref'), signed: m('c.signed'), extra: m('c.extra') }] }] },
      filings: { groups: [{ key: m('f.key'), items: [{ ref: m('f.ref'), extra: m('f.extra') }] }], registerSeed: [{ filing: m('f.filing'), date: m('f.date'), party: m('f.party'), answer: m('f.answer'), answerDate: m('f.answerDate'), extra: m('f.extra') }] },
      bundles: { list: [{ no: m('b.no'), name: m('b.name'), items: 1, rows: [{ key: m('b.key'), frm: 4, extra: m('b.rowextra') }], extra: m('b.extra') }], caselinesSections: [{ sec: m('b.sec'), first: 1, last: 2, title: m('b.stitle'), extra: m('b.sextra') }], extracts: [{ ref: m('b.xref') }], caselinesSrc: './X.pdf' },
      linkSample: [{ ref: m('l.ref'), title: m('l.title'), extra: m('l.extra') }],
      buildReport: { generatedFrom: m('br.from'), pending: [{ ref: m('br.ref'), title: m('br.title'), extra: m('br.extra') }], textNone: [], counts: { a: m('br.count') } },
      lit: { interestBasis: { rate: m('ib.rate'), extra: m('ib.extra') }, settlement: { claim: m('s.claim'), extra: m('s.extra') } },
    };
    const META: J = { version: 'V1', builtAt: '2002-06-07 08:09', docCount: 1, matter: m('meta.matter'), extra: m('meta.extra') };
    const expected: [string, string][] = [];
    leaves(DATA, 'DATA', expected);
    leaves(META, 'META', expected);
    const out = JSON.stringify(mapNewerRoots({ DATA, META, 'window.__SCHED__': [{ key: 'k', bundle: 'Original', items: [{ no: 1, desc: m('s.desc'), extra: m('s.itemextra'), files: [{ ref: m('s.fref'), name: m('s.fname'), extra: m('s.fextra') }] }] }] } as never));
    expect(expected.filter(([, v]) => !out.includes(v)).map(([p]) => p)).toEqual([]);
  });
});

describe('one odd risk field does not demote the Risk Matrix (M2)', () => {
  const made: string[] = [];
  afterAll(async () => { for (const r of made) await cleanup(r); });
  const GOOD = { issue: 'Invented issue', likelihood: 'Low', impact: 'High', mitigation: 'Invented mitigation' };
  const ODD = { ...GOOD, issue: 'Odd one' };

  it('JSON script: category, owner and refs are written only with the schema type, else kept under a source name', async () => {
    const tag = (id: string, v: unknown) => `<script id="${id}" type="application/json">${JSON.stringify(v)}</script>`;
    const html = new TextEncoder().encode(['<!DOCTYPE html>', '<html><body>', tag('app-data', { chronology: [], meta: { builtAt: '2002-06-07 08:09' } }),
      tag('app-seed', { risk: [
        { risk: 'Typed', type: 'Legal', owner: 'Counsel', refs: ['DC-1'], l: 2, i: 5, mit: 'm' },
        { risk: 'Null owner', type: 'Legal', owner: null, l: 2, i: 5, mit: 'm' },
        { risk: 'Numeric type', type: 5, owner: 'Counsel', l: 2, i: 5, mit: 'm' },
        { risk: 'String refs', type: 'Legal', owner: 'Counsel', refs: 'DC-1, DC-2', l: 2, i: 5, mit: 'm' },
        { risk: 'Own category', category: 7, type: 'Legal', owner: ['A'], refs: [1], l: 2, i: 5, mit: 'm' },
      ] }), '</body></html>', ''].join('\n'));
    const root = await tempDir('read-lists-risk');
    made.push(root);
    const caseDir = path.join(root, 'case');
    await writeCaseFolder(caseDir);
    const result = await convertV5({ html, htmlName: 'SYN.html', caseFolder: caseDir, caseId: 'synthetic-risk' });
    expect(result.diagnostics.filter((d) => d.code === 'V5_DATASET_SHAPE_UNMAPPED')).toEqual([]);
    const risks = (parseStrictJson(decodeUtf8Strict(result.files!.get('datasets/risk-matrix.json')!)) as { data: J[] }).data;
    expect(risks).toHaveLength(5);
    expect(risks[0]).toMatchObject({ category: 'Legal', owner: 'Counsel', refs: ['DC-1'] });
    expect(risks[1]).toMatchObject({ category: 'Legal', source_owner: null });
    expect(risks[1]).not.toHaveProperty('owner');
    expect(risks[2]).toMatchObject({ source_type: 5, owner: 'Counsel' });
    expect(risks[2]).not.toHaveProperty('category');
    expect(risks[3]).toMatchObject({ source_refs: 'DC-1, DC-2', category: 'Legal' });
    expect(risks[3]).not.toHaveProperty('refs');
    expect(risks[4]).toMatchObject({ category: 'Legal', source_category: 7, source_owner: ['A'], source_refs: [1] });
    const r = await importCandidate({ files: result.files! }, caseDir);
    expect(r.diagnostics.filter((d) => d.code === 'DS_SHAPE_INVALID')).toEqual([]);
  });

  it('newer export: a DATA.riskMatrix with an odd field is still the Risk Matrix', async () => {
    const b = await buildSynth('read-lists-newer-risk', (r) => {
      r.META.version = 'V1';
      r.DATA.riskMatrix = [
        { ...GOOD, category: 'Legal', owner: 'Counsel', refs: ['OD-001'] },
        { ...ODD, owner: null },
        { ...ODD, category: 3 },
        { ...ODD, refs: 'OD-001' },
      ];
    });
    made.push(b.root);
    expect(b.result.diagnostics.filter((d) => d.code === 'V5_DATASET_SHAPE_UNMAPPED')).toEqual([]);
    const risks = (parseStrictJson(decodeUtf8Strict(b.files.get('datasets/risk-matrix.json')!)) as { data: J[] }).data;
    expect(risks[0]).toMatchObject({ category: 'Legal', owner: 'Counsel', refs: ['OD-001'] });
    expect(risks[1]).toMatchObject({ source_owner: null });
    expect(risks[1]).not.toHaveProperty('owner');
    expect(risks[2]).toMatchObject({ source_category: 3 });
    expect(risks[3]).toMatchObject({ source_refs: 'OD-001' });
    const r = await importCandidate(b.pkgDir, b.caseDir);
    expect(r.diagnostics.filter((d) => d.code === 'DS_SHAPE_INVALID')).toEqual([]);
  });
});
