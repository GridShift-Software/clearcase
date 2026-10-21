// GRS-170: the JSON-script mapping keeps a source field that is already named source_<name>; it never overwrites it.
// Each source holds `source_<k>` and an unreadable `k`, in both key orders, at every place the mapping moves a field
// aside: the matter's matters and client, a risk's category and type, and the top-level app-data and app-seed keys.
// Every value below is invented.
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { importCandidate } from '../../src/lib/case-package/import.ts';
import { decodeUtf8Strict, parseStrictJson } from '../../src/lib/case-package/strict-json.ts';
import { convertV5 } from '../../src/lib/case-package/v5/adapter.ts';
import { writePackageDir } from '../../src/lib/case-package/writer.ts';
import { cleanup, tempDir, writeCaseFolder } from './fixtures/synth.ts';

type J = Record<string, unknown>;
const tag = (id: string, v: unknown) => `<script id="${id}" type="application/json">${JSON.stringify(v).replace(/<\//g, '<\\/')}</script>`;
const jsonHtml = (lines: string[]) => new TextEncoder().encode(['<!DOCTYPE html>', '<html><head><meta charset="utf-8"><title>Synthetic JSON workspace</title></head><body>', ...lines, '</body></html>', ''].join('\n'));
const dataset = (files: Map<string, Uint8Array>, key: string) => (parseStrictJson(decodeUtf8Strict(files.get(`datasets/${key}.json`)!)) as { data: unknown }).data;

/** `source_<k>` holding `held-<k>`, and `k` holding a value the mapping cannot read, in the order asked for. */
const pair = (k: string, odd: unknown, kFirst: boolean): [string, unknown][] => (kFirst ? [[k, odd], [`source_${k}`, `held-${k}`]] : [[`source_${k}`, `held-${k}`], [k, odd]]);
const odd = (k: string) => ({ odd: `odd-${k}` });
const record = (...pairs: [string, unknown][][]): J => Object.fromEntries(pairs.flat());

function sources(kFirst: boolean): { appData: J; appSeed: J } {
  return {
    // `entities` must be a list and `timeline` is a mapped root, so both are already in DATA when the key is moved aside
    appData: { meta: { builtAt: '2003-04-05 06:07' }, conflict: 'data-conflict', ...record(pair('entities', odd('entities'), kFirst), pair('timeline', odd('timeline'), kFirst)) },
    appSeed: record(
      pair('client', odd('client'), kFirst),
      pair('matters', [{ id: 'A', title: 'A v B', extra: 'odd-matters' }], kFirst),
      [['risk', [record([['risk', 'Invented risk.']], pair('category', odd('category'), kFirst), pair('type', odd('type'), kFirst))]]],
      // `matter` is the mapped matter's root; `conflict` is already in DATA from app-data
      pair('matter', odd('matter'), kFirst),
      pair('conflict', odd('conflict'), kFirst),
    ),
  };
}
const SITES = ['entities', 'timeline', 'client', 'matters', 'category', 'type', 'matter', 'conflict'];
const VALUES = [...SITES.flatMap((k) => [`held-${k}`, `odd-${k}`]), 'data-conflict'];

/** The top-level fields of a dataset (of each record, for a list) whose value holds the text `s`. */
const fieldsHolding = (data: unknown, s: string): string[] => {
  const holds = (v: unknown) => JSON.stringify(v).includes(JSON.stringify(s));
  if (Array.isArray(data)) return data.flatMap((r) => fieldsHolding(r, s));
  if (data !== null && typeof data === 'object') return Object.entries(data).filter(([, v]) => holds(v)).map(([k]) => k);
  return holds(data) ? [''] : [];
};

const roots: string[] = [];
afterAll(async () => { for (const r of roots) await cleanup(r); });

describe('a JSON-script source field already named source_<name> is never overwritten by the mapping (GRS-170)', () => {
  for (const kFirst of [false, true]) {
    it(`keeps both values, each with its warning, when ${kFirst ? 'k' : 'source_<k>'} comes first`, async () => {
      const root = await tempDir('json-source-names');
      roots.push(root);
      const caseDir = path.join(root, 'case');
      await writeCaseFolder(caseDir);
      const { appData, appSeed } = sources(kFirst);
      const result = await convertV5({ html: jsonHtml([tag('app-data', appData), tag('app-seed', appSeed)]), htmlName: 'SYN_Workspace.html', caseFolder: caseDir, caseId: 'synthetic-json' });
      expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      const files = result.files!;
      const pkgDir = path.join(root, 'pkg');
      await writePackageDir(pkgDir, files);
      const imported = await importCandidate(pkgDir, caseDir);
      expect(imported.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      const keys = result.manifest!.files.flatMap((f) => (f.role === 'dataset' && f.key !== undefined && f.key !== 'conversion-report' ? [f.key] : []));
      const kept = VALUES.map((s) => ({ s, at: keys.flatMap((key) => fieldsHolding(dataset(files, key), s).map((field) => ({ key, field }))) }));
      expect(kept.filter((v) => v.at.length === 0).map((v) => v.s), 'values lost').toEqual([]);
      // a value kept as residual has the warning that names its dataset; one kept on a mapped record, its field's own
      const warned = ({ key, field }: { key: string; field: string }) => (key.startsWith('v5-residual-')
        ? result.diagnostics.some((d) => d.code === 'V5_UNMAPPED_KEY' && d.message.endsWith(`opaque dataset ${key}`))
        : imported.diagnostics.some((d) => d.code === 'DS_UNSUPPORTED_FIELD' && d.subject === field));
      expect(kept.flatMap((v) => v.at.filter((at) => !warned(at)).map((at) => `${v.s} in ${at.key}.${at.field}`)), 'values kept without a warning').toEqual([]);
    });
  }
});

// A risk's `l` and `i` write the derived likelihood_score and impact_score; a source risk that already holds either name beside a number keeps its own value aside.
const scoreRisks = (): J[] => [
  record([['risk', 'Invented score first.'], ['likelihood_score', 'held-likelihood_score'], ['impact_score', 'held-impact_score'], ['l', 4], ['i', 2]]),
  record([['risk', 'Invented score last.'], ['l', 3], ['i', 1], ['impact_score', 'held-impact_score-last'], ['likelihood_score', 'held-likelihood_score-last']]),
  record([['risk', 'Invented score and prefix.'], ['l', 5], ['i', 5], ['likelihood_score', 'held-score-a'], ['source_likelihood_score', 'held-score-b']]),
];

describe('a risk with a source likelihood_score or impact_score beside a numeric l or i keeps the source value (GRS-170)', () => {
  it('writes the derived scores and keeps each source value aside, with its warning', async () => {
    const root = await tempDir('json-source-names-scores');
    roots.push(root);
    const caseDir = path.join(root, 'case');
    await writeCaseFolder(caseDir);
    const appSeed = { risk: scoreRisks() };
    const result = await convertV5({ html: jsonHtml([tag('app-data', { meta: { builtAt: '2003-04-05 06:07' } }), tag('app-seed', appSeed)]), htmlName: 'SYN_Workspace.html', caseFolder: caseDir, caseId: 'synthetic-json' });
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const files = result.files!;
    const pkgDir = path.join(root, 'pkg');
    await writePackageDir(pkgDir, files);
    const imported = await importCandidate(pkgDir, caseDir);
    expect(imported.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const risks = dataset(files, 'risk-matrix') as J[];
    expect(risks.map((r) => [r.likelihood_score, r.impact_score])).toEqual([[4, 2], [3, 1], [5, 5]]);
    const held = ['held-likelihood_score', 'held-impact_score', 'held-likelihood_score-last', 'held-impact_score-last', 'held-score-a', 'held-score-b'];
    const kept = held.map((s) => ({ s, at: fieldsHolding(risks, s) }));
    expect(kept.filter((v) => v.at.length === 0).map((v) => v.s), 'values lost').toEqual([]);
    expect(kept.flatMap((v) => v.at.filter((field) => !imported.diagnostics.some((d) => d.code === 'DS_UNSUPPORTED_FIELD' && d.subject === field)).map((field) => `${v.s} in ${field}`)), 'values kept without a warning').toEqual([]);
  });
});
