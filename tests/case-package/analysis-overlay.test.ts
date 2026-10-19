// GRS-22 fix round (H1): the newer viewer's hand-authored analysis (`const X = {…}` in its mod_00_analysis.js module) is
// read with the strict parser, never evaluated, and kept as one opaque dataset that the import report lists. Mapping it
// into views waits for GRS-149. Every value below is invented.
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { importCandidate } from '../../src/lib/case-package/import.ts';
import { decodeUtf8Strict, parseStrictJson } from '../../src/lib/case-package/strict-json.ts';
import { convertV5 } from '../../src/lib/case-package/v5/adapter.ts';
import { writePackageDir } from '../../src/lib/case-package/writer.ts';
import { cleanup, synthHtml, synthRoots, tempDir, writeCaseFolder } from './fixtures/synth.ts';

type J = Record<string, any>;
const roots: string[] = [];
afterAll(async () => { for (const r of roots) await cleanup(r); });

const MODULE = '/* ===== module mod_00_analysis.js ===== */';
const OTHER = '/* ===== module mod_10_other.js ===== */';
const X = { matter: { title: 'Invented matter', storyline: [{ h: 'A', t: 'a' }], strategy: [] }, riskMatrix: [{ issue: 'i', category: 'Legal', owner: 'Counsel', refs: ['OD-001'] }, { issue: 'j' }], timeline: [1, 2, 3] };
const literal = (x: unknown) => `(function(){ const X = ${JSON.stringify(x)};`;

async function convert(extra: string[], newer = true) {
  const root = await tempDir('overlay');
  roots.push(root);
  const caseDir = path.join(root, 'case');
  await writeCaseFolder(caseDir);
  const r = synthRoots();
  if (newer) r.META.version = 'V1';
  const result = await convertV5({ html: synthHtml(r, extra), htmlName: 'workspace.html', caseFolder: caseDir, caseId: 'synthetic-overlay' });
  return { root, caseDir, result };
}
const keys = (res: Awaited<ReturnType<typeof convert>>['result']) => res.manifest!.files.filter((f) => f.role === 'dataset').map((f) => f.key);
const overlayCodes = (res: Awaited<ReturnType<typeof convert>>['result']) => res.diagnostics.filter((d) => d.code.startsWith('V5_OVERLAY_'));

describe('the newer viewer\'s hand-authored analysis', () => {
  it('is kept as one opaque dataset, with a warning that names its keys and counts, and the import report lists it', async () => {
    const { caseDir, root, result } = await convert([MODULE, literal(X), '  Object.assign(DATA, X); globalThis.__executed = true;']);
    expect(result.ok).toBe(true);
    expect(keys(result)).toContain('v5-residual-analysis-overlay');
    const files = result.files!;
    const env = parseStrictJson(decodeUtf8Strict(files.get('datasets/v5-residual-analysis-overlay.json')!)) as J;
    expect(env.schema).toBe('opaque@1');
    expect(env.data).toEqual(X);
    expect(env.provenance.sourcePath).toBe('mod_00_analysis.js:X');
    const w = overlayCodes(result);
    expect(w.map((d) => [d.code, d.severity])).toEqual([['V5_OVERLAY_UNMAPPED', 'warning']]);
    expect(w[0]!.message).toContain('3 keys');
    expect(w[0]!.message).toContain('matter 3, riskMatrix 2, timeline 3');
    const pkgDir = path.join(root, 'pkg');
    await writePackageDir(pkgDir, files);
    const r = await importCandidate(pkgDir, caseDir);
    expect(r.verdict).toBe('report');
    expect(r.diagnostics.filter((d) => d.code === 'DS_UNKNOWN_SCHEMA').map((d) => d.file)).toContain('datasets/v5-residual-analysis-overlay.json');
  });

  it('is read as data: a hostile key stays an own key and nothing is evaluated', async () => {
    const hostile = '{"__proto__":{"polluted":1},"constructor":[1],"matter":{"title":"t"}}';
    const { result } = await convert([MODULE, `(function(){ const X = ${hostile};`]);
    const env = parseStrictJson(decodeUtf8Strict(result.files!.get('datasets/v5-residual-analysis-overlay.json')!)) as J;
    expect(Object.keys(env.data)).toEqual(['__proto__', 'constructor', 'matter']);
    expect(({} as J).polluted).toBeUndefined();
  });

  it('warns, and imports nothing from it, when the literal cannot be parsed as JSON', async () => {
    for (const bad of ['(function(){ const X = {"a":};', '(function(){ const X = {"a":1,"a":2};', '(function(){ const X = {"a":new Date()};']) {
      const { result } = await convert([MODULE, bad]);
      expect(result.ok).toBe(true);
      expect(keys(result)).not.toContain('v5-residual-analysis-overlay');
      expect(overlayCodes(result).map((d) => [d.code, d.severity])).toEqual([['V5_OVERLAY_UNREADABLE', 'warning']]);
    }
  });

  it('warns when the module holds no literal, or more than one', async () => {
    for (const lines of [[MODULE, '(function(){ const Y = {"a":1};'], [MODULE, literal(X), literal(X)]]) {
      const { result } = await convert(lines);
      expect(keys(result)).not.toContain('v5-residual-analysis-overlay');
      expect(overlayCodes(result).map((d) => d.code)).toEqual(['V5_OVERLAY_UNREADABLE']);
    }
  });

  it('reads only the analysis module: a literal in another module, or an export without the module, is not an overlay', async () => {
    for (const lines of [[OTHER, literal(X)], [literal(X)], [MODULE, literal(X), OTHER, literal({ other: 1 })], []]) {
      const { result } = await convert(lines);
      const has = keys(result).includes('v5-residual-analysis-overlay');
      expect(has).toBe(lines.length === 4);
      if (!has) expect(overlayCodes(result)).toEqual([]);
    }
  });

  it('is not read for v5, whose payload lines are all there is', async () => {
    const { result } = await convert([MODULE, literal(X)], false);
    expect(result.source!.generation).toBe('v5-js');
    expect(keys(result)).not.toContain('v5-residual-analysis-overlay');
    expect(overlayCodes(result)).toEqual([]);
  });
});
