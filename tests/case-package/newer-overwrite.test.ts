// GRS-171: the newer-export mapping never overwrites a source field. Where a mapper writes a key the source record
// already holds, a value derived from other fields or a reading that does not carry the source's own value, the source
// value stays on the record as source_<k>, or source_source_<k> when source_<k> is taken too. Each site is probed with
// `k` alone and with `k` and `source_<k>` in both key orders. Every value below is invented.
import { afterAll, describe, expect, it } from 'vitest';
import { importCandidate } from '../../src/lib/case-package/import.ts';
import { decodeUtf8Strict, parseStrictJson } from '../../src/lib/case-package/strict-json.ts';
import { buildReportOf, bundlesOf, caselinesIndexOf, contractsOf, filingsOf, linkSampleOf, quantumOf, schedOf } from '../../src/lib/case-package/v5/newer-workspace.ts';
import { buildSynth } from './fixtures/build.ts';
import { cleanup } from './fixtures/synth.ts';

type J = Record<string, any>;
type Pairs = [string, unknown][];
const rec = (...pairs: Pairs): J => Object.fromEntries(pairs);
const odd = (k: string) => ({ odd: `held-${k}` });
const byRef = new Map<string, J>([['OD-001', { ref: 'OD-001', filename: 'OD-001 Supply agreement.pdf', doc_type: 'SLA' }]]);

const section = (p: Pairs) => (bundlesOf({ caselinesSections: [rec(['sec', '001'], ['first', 13], ['last', 309], ...p)] }) as J).caselinesSections['001'] as J;
const pageMap = (p: Pairs) => caselinesIndexOf(rec(['1', 'Page one'], ...p), './PLEADINGS/Synthetic%20Bundle.pdf', 0) as J;
const seed = (p: Pairs) => (filingsOf({ registerSeed: [rec(['date', '2001-02-03'], ['party', 'Claimant'], ['answer', 'Plea'], ['answerDate', '2001-03-04'], ...p)] }) as J).registerSeed[0] as J;
const bundles = (p: Pairs) => bundlesOf(rec(...p)) as J;
const bundle = (p: Pairs) => (bundlesOf({ list: [rec(['no', '1'], ['name', 'Bundle A'], ['rows', [{ key: '1-1' }]], ...p)] }) as J).list[0] as J;
const contractItem = (p: Pairs) => (contractsOf({ groups: [{ key: 'G', items: [rec(['ref', 'OD-001'], ['signed', 'Signed'], ...p)] }] }, byRef) as J).groups[0].items[0] as J;
const seriesRow = (p: Pairs) => (quantumOf({ amountDueSeries: [rec(['ref', 'OD-001'], ['title', 'Own'], ...p)] }, byRef) as J).amountDueSeries[0] as J;
const linkRow = (p: Pairs) => (linkSampleOf([rec(['ref', 'OD-001'], ['title', 'Own'], ...p)], byRef) as J[])[0]!;
const pendingRow = (p: Pairs) => (buildReportOf({ pending: [rec(['ref', 'OD-001'], ['title', 'Own'], ...p)] }, byRef) as J).pending[0] as J;
const schedItem = (p: Pairs) => (schedOf([{ key: 'pl1', bundle: 'Original', items: [rec(...p)] }]) as J).discovery[0] as J;
const schedFile = (p: Pairs) => (schedOf([{ key: 'pl1', bundle: 'Original', items: [{ files: [rec(['name', 'A.pdf'], ...p)] }] }]) as J).discovery[0].files[0] as J;
const EXTRACTS = [{ ref: 'CB-001', name: 'PL-1.pdf' }];

/** Each site: the record a mapper writes, the key it writes, the source value already there, and what the mapper writes. */
const SITES: { site: string; map: (p: Pairs) => J; k: string; held: unknown; wrote: unknown; base?: Pairs }[] = [
  { site: 'a CaseLines section from (first)', map: section, k: 'from', held: 'held-from', wrote: 13 },
  { site: 'a CaseLines section to (last)', map: section, k: 'to', held: 'held-to', wrote: 309 },
  { site: 'a CaseLines section title read as text', map: section, k: 'title', held: odd('title'), wrote: '' },
  { site: 'the caselines index file (the locator)', map: pageMap, k: 'file', held: 'held-file', wrote: 'Synthetic Bundle.pdf' },
  { site: 'the caselines index pages', map: pageMap, k: 'pages', held: 'held-pages', wrote: 1 },
  { site: 'the caselines index pairs', map: pageMap, k: 'index', held: odd('index'), wrote: [[1, 'Page one']] },
  { site: 'a filing seed filing read as text', map: seed, k: 'filing', held: odd('filing'), wrote: '' },
  { site: 'a filing seed ref read as text', map: seed, k: 'ref', held: ['held-ref'], wrote: '' },
  { site: 'a filing seed status read as text', map: seed, k: 'status', held: odd('status'), wrote: '' },
  { site: 'a filing seed rdate (answerDate)', map: seed, k: 'rdate', held: 'held-rdate', wrote: '2001-03-04' },
  { site: 'a filing seed response (answer)', map: seed, k: 'response', held: 'held-response', wrote: 'Plea' },
  { site: 'the bundles extractFiles (a list of extracts)', map: bundles, base: [['extracts', EXTRACTS]], k: 'extractFiles', held: 'held-extractFiles', wrote: EXTRACTS },
  { site: 'the bundles extracts that is neither text nor a list', map: bundles, k: 'extracts', held: odd('extracts'), wrote: '' },
  { site: 'a bundle items that is neither a list nor a count', map: bundle, k: 'items', held: odd('items'), wrote: ['1-1'] },
  { site: 'a bundle items count that nDocs and nItems do not keep', map: bundle, base: [['nDocs', 1], ['nItems', 1]], k: 'items', held: 7, wrote: ['1-1'] },
  { site: 'a contract item note that is not text', map: contractItem, k: 'note', held: odd('note'), wrote: 'Signed' },
  { site: 'a quantum series row filename that is not text', map: seriesRow, k: 'filename', held: odd('filename'), wrote: 'OD-001 Supply agreement.pdf' },
  { site: 'a link sample row filename that is not text', map: linkRow, k: 'filename', held: 3, wrote: 'OD-001 Supply agreement.pdf' },
  { site: 'a build report row filename that is not text', map: pendingRow, k: 'filename', held: true, wrote: 'OD-001 Supply agreement.pdf' },
  { site: 'a schedule item no read as a count', map: schedItem, k: 'no', held: 'held-no', wrote: 0 },
  { site: 'a schedule item date read as text', map: schedItem, k: 'date', held: odd('date'), wrote: '' },
  { site: 'a schedule item desc read as text', map: schedItem, k: 'desc', held: ['held-desc'], wrote: '' },
  { site: 'a schedule file url read as text', map: schedFile, k: 'url', held: odd('url'), wrote: '' },
];

describe('a newer-export mapper never overwrites a source field of the name it writes (GRS-171)', () => {
  for (const s of SITES) {
    it(`keeps the source value of ${s.site} beside what the mapping writes`, () => {
      const chain = `held-source_${s.k}`;
      const variants: [string, Pairs][] = [
        [`${s.k} alone`, [[s.k, s.held]]],
        [`${s.k}, then source_${s.k}`, [[s.k, s.held], [`source_${s.k}`, chain]]],
        [`source_${s.k}, then ${s.k}`, [[`source_${s.k}`, chain], [s.k, s.held]]],
      ];
      // the held value lands at source_<k>, or at source_source_<k> when source_<k> holds a value of its own, which stays put
      for (const [name, pairs] of variants) {
        const out = s.map([...(s.base ?? []), ...pairs]);
        expect(out[s.k], `${name}: written`).toEqual(s.wrote);
        if (pairs.length > 1) {
          expect(out[`source_${s.k}`], `${name}: source_${s.k}`).toEqual(chain);
          expect(out[`source_source_${s.k}`], `${name}: source_source_${s.k}`).toEqual(s.held);
        } else expect(out[`source_${s.k}`], `${name}: source_${s.k}`).toEqual(s.held);
      }
    });
  }

  it('adds no source_ field where the mapping carries the source value: the same value, a number or boolean as text, null, an empty note, a count nDocs keeps', () => {
    const aside = (out: J) => Object.keys(out).filter((k) => k.startsWith('source_'));
    const carried: [J, J][] = [
      [section([['from', 13], ['to', 309], ['title', 7]]), { from: 13, to: 309, title: '7' }],
      [seed([['filing', 5], ['ref', true], ['status', null]]), { filing: '5', ref: 'true', status: '' }],
      [pageMap([]), { file: 'Synthetic Bundle.pdf', pages: 1 }],
      [contractItem([['note', '']]), { note: 'Signed' }],
      [contractItem([['note', null]]), { note: 'Signed' }],
      [bundle([['items', 1]]), { items: ['1-1'], nDocs: 1, nItems: 1 }],
      [bundles([['extracts', null]]), { extracts: '' }],
      [seriesRow([['filename', null]]), { filename: 'OD-001 Supply agreement.pdf' }],
      [schedItem([['no', 12], ['date', '2001-02-03'], ['desc', 'Letter']]), { no: 12, date: '2001-02-03', desc: 'Letter' }],
      [schedItem([['no', null], ['date', 20010203]]), { no: 0, date: '20010203', desc: '' }],
      [schedFile([['url', 'files/A.pdf']]), { url: 'files/A.pdf' }],
    ];
    for (const [out, expected] of carried) {
      expect(out).toMatchObject(expected);
      expect(aside(out), JSON.stringify(expected)).toEqual([]);
    }
  });

  it('keeps a schedule item\'s no, date and desc and a file\'s url, read as a count or text, as written in schedules', () => {
    const item = { no: 'held-no', date: odd('date'), desc: ['held-desc'], files: [{ name: 'A.pdf', url: odd('url') }] };
    const out = schedOf([{ key: 'pl1', bundle: 'Original', items: [item] }]) as J;
    expect(out.discovery[0]).toMatchObject({ no: 0, date: '', desc: '', files: [{ fn: 'A.pdf', url: '' }] });
    expect(out.schedules[0].items[0]).toEqual(item);
  });
});

const roots: string[] = [];
afterAll(async () => { for (const r of roots) await cleanup(r); });

/** `k` holding `held` and `source_<k>` holding `held-source_<k>`, in the order asked for. */
const pair = (k: string, held: unknown, kFirst: boolean): Pairs => (kFirst ? [[k, held], [`source_${k}`, `held-source_${k}`]] : [[`source_${k}`, `held-source_${k}`], [k, held]]);
const E2E: [string, unknown][] = [
  ['from', 'held-from'], ['to', 'held-to'], ['title', odd('title')],
  ['file', 'held-file'], ['pages', 'held-pages'], ['index', odd('index')],
  ['filing', odd('filing')], ['ref', ['held-ref']], ['status', odd('status')], ['rdate', 'held-rdate'], ['response', 'held-response'],
  ['extractFiles', 'held-extractFiles'], ['items', odd('items')], ['note', odd('note')], ['filename', odd('filename')],
  ['no', 'held-no'], ['date', odd('date')], ['desc', ['held-desc']], ['url', odd('url')],
];
const VALUES: unknown[] = E2E.flatMap(([k, v]) => [v, `held-source_${k}`]);

/** Each path (keys, `*` for a list index) at which `data` holds the value `v`. */
const pathsOf = (data: unknown, v: unknown, at: string[] = []): string[][] => {
  if (JSON.stringify(data) === JSON.stringify(v)) return [at];
  if (Array.isArray(data)) return data.flatMap((x) => pathsOf(x, v, [...at, '*']));
  if (data !== null && typeof data === 'object') return Object.entries(data).flatMap(([k, x]) => pathsOf(x, v, [...at, k]));
  return [];
};

describe('every source value the newer mapping meets at a written name reaches the package with a warning (GRS-171)', () => {
  for (const kFirst of [false, true]) {
    it(`converts and imports with each value kept and warned, when ${kFirst ? 'k' : 'source_<k>'} comes first`, async () => {
      const at = (k: string, held: unknown) => pair(k, held, kFirst);
      const v = (k: string) => E2E.find(([n]) => n === k)![1];
      const b = await buildSynth(`newer-overwrite-${kFirst}`, (r) => {
        r.META = { ...(r.META as J), version: 'V1' };
        const bundlesRoot = r.DATA.bundles as J;
        bundlesRoot.caselinesSections = [rec(['sec', '001'], ['first', 1], ['last', 2], ...at('from', v('from')), ...at('to', v('to')), ...at('title', v('title')))];
        bundlesRoot.extracts = EXTRACTS;
        for (const [k, x] of at('extractFiles', v('extractFiles'))) bundlesRoot[k] = x;
        for (const [k, x] of at('items', v('items'))) bundlesRoot.list[0][k] = x;
        r.CASELINES = rec(['1', 'Page one'], ['2', 'Page two'], ...at('file', v('file')), ...at('pages', v('pages')), ...at('index', v('index')));
        (r.DATA.filings as J).registerSeed = [rec(['date', '2001-04-05'], ['party', 'Claimant'], ['answer', 'None yet'], ['answerDate', ''],
          ...at('filing', v('filing')), ...at('ref', v('ref')), ...at('status', v('status')), ...at('rdate', v('rdate')), ...at('response', v('response')))];
        // the synthetic contract item is the filings item too, so each record here is a copy of its own
        const contracts = (r.DATA.contracts as J).groups[0].items as J[];
        contracts[0] = rec(...Object.entries(contracts[0]!).filter(([k]) => k !== 'note'), ['signed', 'Signed'], ...at('note', v('note')));
        const series = (r.DATA.quantum as J).amountDueSeries as J[];
        series[0] = rec(...Object.entries(series[0]!).filter(([k]) => k !== 'filename'), ...at('filename', v('filename')));
        (r as J).SCHED = [{ key: 'pl1', bundle: 'Original', items: [rec(...at('no', v('no')), ...at('date', v('date')), ...at('desc', v('desc')),
          ['files', [rec(['ref', 'OD-001'], ['name', 'OD-001 Supply agreement.pdf'], ...at('url', v('url')))]])] }];
      });
      roots.push(b.root);
      expect(b.result.source!.generation).toBe('v5-js-newer');
      const imported = await importCandidate(b.pkgDir, b.caseDir);
      expect(imported.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      const keys = b.result.manifest!.files.flatMap((f) => (f.role === 'dataset' && f.key !== undefined && f.key !== 'conversion-report' ? [f.key] : []));
      const data = (key: string) => (parseStrictJson(decodeUtf8Strict(b.files.get(`datasets/${key}.json`)!)) as { data: unknown }).data;
      const kept = VALUES.map((s) => ({ s, at: keys.flatMap((key) => pathsOf(data(key), s).map((path) => ({ key, path }))) }));
      expect(kept.filter((x) => x.at.length === 0).map((x) => x.s), 'values lost').toEqual([]);
      // a value kept as residual has the warning that names its dataset; one kept on a mapped record, the DS_UNSUPPORTED_FIELD of a field on its path
      const warned = ({ key, path }: { key: string; path: string[] }) => (key.startsWith('v5-residual-')
        ? b.result.diagnostics.some((d) => (d.code === 'V5_UNMAPPED_KEY' || d.code === 'V5_DATASET_SHAPE_UNMAPPED') && d.message.includes(key))
        : imported.diagnostics.some((d) => {
          if (d.code !== 'DS_UNSUPPORTED_FIELD' || d.file !== `datasets/${key}.json` || !d.pointer?.startsWith('/data/')) return false;
          const segs = d.pointer.slice('/data/'.length).split('/');
          return segs.length <= path.length && segs.every((seg, i) => seg === '*' || seg === path[i]);
        }));
      expect(kept.flatMap((x) => x.at.filter((a) => !warned(a)).map((a) => `${JSON.stringify(x.s)} in ${a.key}/${a.path.join('/')}`)), 'values kept without a warning').toEqual([]);
    });
  }
});
