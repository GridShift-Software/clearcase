// Integrity metadata (ADR 0012) on genuine converter output: META and source-layout are checked against their own
// contracts, never rendered; every view dataset and every unknown required schema stays unsupported.
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { buildSynth, editPackage, resealFiles } from '../../case-package/fixtures/build.ts';
import { cleanup, synthHtml, synthRoots, tempDir, writeCaseFolder, type SynthRoots } from '../../case-package/fixtures/synth.ts';
import { convertV5 } from '../../../src/lib/case-package/v5/adapter.ts';
import { world } from './fixture.ts';
import { Candidate } from '../../../src/lib/case-package/candidate.ts';
import { canonicalBytes } from '../../../src/lib/case-package/canonical.ts';
import { validateHostedPackage } from '../../../src/lib/case-package/hosted-validation.ts';
import type { DatasetEnvelope, Manifest } from '../../../src/lib/case-package/schema.ts';
import { preparePackage, type OriginalFacts } from '../../../src/lib/results/hosted/project.ts';
import { renderRequiredSections } from '../../../src/lib/server/runtime/hosted/required-section-render.ts';
import { checkSnapshot, signoffBlocker } from '../../../src/lib/publication/hosted/rules.ts';
import type { CandidateSnapshot } from '../../../src/lib/publication/hosted/ports.ts';
import { sha256Canonical } from '../../../src/lib/results-review/native/digest.ts';

const roots: string[] = [];
afterAll(async () => { for (const r of roots) await cleanup(r); });
const worlds: Awaited<ReturnType<typeof world>>[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.close(); });

/** The synthetic META deliberately disagrees with its records; this makes every count agree. */
function reconcileMeta(r: SynthRoots): void {
  const rows = r.DATA.chronology as Record<string, string>[];
  const by = (f: string) => { const c: Record<string, number> = {}; for (const x of rows) c[x[f]!] = (c[x[f]!] ?? 0) + 1; return c; };
  const status = by('text_status'), types = by('doc_type');
  Object.assign(r.META, { docCount: rows.length, textNone: status.none ?? 0, textPending: status.pending ?? 0, emails: types.email ?? 0,
    invoices: types.invoice ?? 0, people: (r.DATA.people as unknown[]).length, bundles: by('bundle'), docTypes: types });
}

async function converted(tag: string, edit?: (r: SynthRoots) => void): Promise<Map<string, Uint8Array>> {
  const b = await buildSynth(tag, edit);
  roots.push(b.root);
  return b.files;
}

/** The canonical hosted validation and projection of `files`, as the publication material reader runs them. */
function accepted(files: ReadonlyMap<string, Uint8Array>) {
  const prepared = preparePackage(files);
  if (!prepared.ok) throw new Error(prepared.problems.join('; '));
  const facts: OriginalFacts = new Map(prepared.fileAssets.map((f) => [f.key, { path: f.path, sha256: f.sha256, size: f.size, mediaType: f.mediaType, status: 'verified' as const, downloadOnly: false }]));
  const { result } = validateHostedPackage({ files, originals: facts });
  expect(result.errorFingerprints).toEqual([]);
  const projected = prepared.project(facts);
  if (!projected.ok) throw new Error(projected.problems.join('; '));
  return { result, candidate: result.candidate!, projection: projected.projection, originals: new Map(prepared.fileAssets.map((f) => [f.key, `asset-${f.key}`])) };
}

async function sectionsOf(files: ReadonlyMap<string, Uint8Array>, candidate?: Candidate): Promise<Record<string, string>> {
  const a = accepted(files);
  const out = await renderRequiredSections({ candidate: candidate ?? a.candidate, projection: a.projection, originals: a.originals, counts: a.result.counts });
  return Object.fromEntries(out.map((s) => [s.key, s.state]));
}

const editLayout = (files: Map<string, Uint8Array>, edit: (layout: Record<string, string[]>) => void) =>
  editPackage(files, 'datasets/source-layout.json', (env) => { edit(env.data); env.count = Object.keys(env.data).length; });

/** A Candidate over the same accepted package with one dataset replaced or added, as a reader would hold it. */
function withDataset(c: Candidate, env: DatasetEnvelope): Candidate {
  const manifest = structuredClone(c.manifest) as Manifest;
  const file = { path: `datasets/${env.key}.json`, role: 'dataset' as const, key: env.key, kind: env.kind, schema: env.schema, required: env.required, count: env.count, sha256: '0'.repeat(64), size: 1 };
  manifest.files = [...manifest.files.filter((f) => f.key !== env.key), file];
  const datasets = new Map(c.datasetKeys().map((k) => [k, c.dataset(k)!]));
  datasets.set(env.key, env);
  return new Candidate({ manifest, manifestSha256: c.manifestSha256, resultsVersion: c.resultsVersion, inputRevisionId: c.inputRevisionId,
    files: new Map([...c.snapshot()].map((f) => [f.path, f.bytes])), datasets, assets: { ...c.assets }, originals: new Map(), unavailable: new Set() });
}

describe('integrity metadata on actual converter-generated packages', () => {
  it('verifies META counts and the lossless source layout, and still holds every view dataset it cannot render', async () => {
    const files = await converted('integrity-ok', reconcileMeta);
    expect(accepted(files).result.counts.V5_META_COUNT_DISAGREEMENT).toBeUndefined();
    const s = await sectionsOf(files);
    expect(s.meta).toBe('integrity-verified');
    expect(s['source-layout']).toBe('integrity-verified');
    expect(s.chronology).toBe('valid');
    for (const key of ['discovery-schedules', 'caselines-index', 'people', 'matter', 'risk-matrix', 'bundles']) expect(s[key]).toBe('unsupported');
    expect(Object.entries(s).filter(([, v]) => v === 'integrity-verified').map(([k]) => k).sort()).toEqual(['meta', 'source-layout']);
  });

  it('marks META invalid when its counts disagree with the records, even though validation only warns', async () => {
    const files = await converted('integrity-meta-source');
    const a = accepted(files);
    expect(a.result.verdict).toBe('report');
    expect(a.result.counts.V5_META_COUNT_DISAGREEMENT).toBeGreaterThan(0);
    const s = await sectionsOf(files);
    expect(s.meta).toBe('invalid');
    expect(s['source-layout']).toBe('integrity-verified');
  });

  it('marks a tampered META count invalid', async () => {
    const files = editPackage(await converted('integrity-meta-tamper', reconcileMeta), 'datasets/meta.json', (env) => { env.data.docCount += 1; });
    expect((await sectionsOf(files)).meta).toBe('invalid');
  });

  const layouts: [string, (l: Record<string, string[]>) => void][] = [
    ['omits a DATA key', (l) => { l.DATA = l.DATA!.filter((k) => k !== 'people'); }],
    ['lists a DATA key with no dataset', (l) => { l.DATA!.push('ghost'); }],
    ['repeats a DATA key', (l) => { l.DATA!.push(l.DATA![0]!); }],
    ['reorders the v5 roots', (l) => { l.roots!.reverse(); }],
    ['omits a root that has a dataset', (l) => { l.roots = l.roots!.filter((r) => r !== 'window.__SCHED__'); }],
    ['drops a split parent', (l) => { delete l['DATA.timeline']; }],
    ['omits a split child', (l) => { l['DATA.lit'] = l['DATA.lit']!.slice(1); }],
    ['adds an ordering for an unsplit dataset', (l) => { l['DATA.matter'] = ['title']; }],
  ];
  it.each(layouts)('marks a source layout that %s invalid', async (_what, edit) => {
    const files = editLayout(await converted('integrity-layout', reconcileMeta), edit);
    const s = await sectionsOf(files);
    expect(s['source-layout']).toBe('invalid');
    expect(s.meta).toBe('integrity-verified');
  });

  it('marks the layout invalid when a registered dataset moves off its registered source path', async () => {
    let files = await converted('integrity-path', reconcileMeta);
    files = editPackage(files, 'datasets/people.json', (env) => { env.provenance.sourcePath = 'DATA.persons'; });
    files = editLayout(files, (l) => { l.DATA = l.DATA!.map((k) => (k === 'people' ? 'persons' : k)); });
    expect((await sectionsOf(files))['source-layout']).toBe('invalid');
  });

  it('marks the layout invalid when a second dataset claims the same source path with the same data', async () => {
    const full = await converted('integrity-duplicate', reconcileMeta);
    const people = JSON.parse(new TextDecoder().decode(full.get('datasets/people.json')!));
    const copy = { ...people, key: 'v5-residual-people-copy', schema: 'opaque@1', required: false };
    const files = new Map(full).set('datasets/v5-residual-people-copy.json', canonicalBytes(copy));
    const resealed = resealFiles(resealFiles(files, (m) => { m.files.push({ path: 'datasets/v5-residual-people-copy.json', role: 'dataset', key: copy.key, kind: copy.kind, schema: copy.schema, required: false, count: copy.count, sha256: '', size: 0 }); m.files.sort((x: { path: string }, y: { path: string }) => (x.path < y.path ? -1 : 1)); }));
    expect((await sectionsOf(resealed))['source-layout']).toBe('invalid');
  });

  it('marks the layout invalid when the META dataset is removed from the package', async () => {
    const full = await converted('integrity-incomplete', reconcileMeta);
    const files = new Map(full);
    files.delete('datasets/meta.json');
    const s = await sectionsOf(resealFiles(files, (m) => { m.files = m.files.filter((f: { key?: string }) => f.key !== 'meta'); }));
    expect(s.meta).toBeUndefined();
    expect(s['source-layout']).toBe('invalid');
  });

  it('keeps an unknown required schema, an integrity schema under another key, and a new META schema unsupported', async () => {
    const files = await converted('integrity-unknown', reconcileMeta);
    const c = accepted(files).candidate;
    const meta = c.dataset('meta')!;
    const unknown = { ...meta, key: 'x-new', schema: 'v5.x-new@1', provenance: { ...meta.provenance, sourcePath: 'window.__X__' } };
    expect((await sectionsOf(files, withDataset(c, unknown)))['x-new']).toBe('unsupported');
    expect((await sectionsOf(files, withDataset(c, { ...meta, key: 'meta-copy' })))['meta-copy']).toBe('unsupported');
    expect((await sectionsOf(files, withDataset(c, { ...meta, schema: 'v5.meta@2' }))).meta).toBe('unsupported');
  });
});

/** A genuinely converted chronology-only source: the optional view roots are omitted, META reconciles (people is 0). */
async function chronologyOnly(tag: string, editMeta?: (meta: Record<string, unknown>) => void): Promise<Map<string, Uint8Array>> {
  const r = synthRoots();
  const rows = r.DATA.chronology as Record<string, string>[];
  const by = (f: string) => { const c: Record<string, number> = {}; for (const x of rows) c[x[f]!] = (c[x[f]!] ?? 0) + 1; return c; };
  const status = by('text_status'), types = by('doc_type');
  r.DATA = { chronology: rows };
  Object.assign(r.META, { docCount: rows.length, people: 0, textNone: status.none ?? 0, textPending: status.pending ?? 0,
    emails: types.email ?? 0, invoices: types.invoice ?? 0, bundles: by('bundle'), docTypes: types });
  editMeta?.(r.META);
  const dir = await tempDir(tag);
  roots.push(dir);
  await writeCaseFolder(dir);
  const html = new TextEncoder().encode(new TextDecoder().decode(synthHtml(r, [], { viewCode: false }))
    .split('\n').filter((line) => !line.startsWith('window.__SCHED__ = ') && !line.startsWith('window.__CASELINES_IDX__ = ')).join('\n'));
  const out = await convertV5({ html, htmlName: 'synthetic.html', caseFolder: dir, caseId: 'synthetic-integrity' });
  if (!out.files) throw new Error('synthetic conversion failed: ' + out.diagnostics.map((d) => d.code).join(','));
  return out.files;
}

describe('a verdict is never claimed from the absence of a count diagnostic', () => {
  it('holds a META.people count that no people record can support, and passes the reconciled zero', async () => {
    const zero = await chronologyOnly('integrity-people-zero');
    expect(Object.keys(await sectionsOf(zero))).toEqual(['chronology', 'meta', 'source-layout']);
    expect(await sectionsOf(zero)).toEqual({ chronology: 'valid', meta: 'integrity-verified', 'source-layout': 'integrity-verified' });
    const files = await chronologyOnly('integrity-people-999', (m) => { m.people = 999; });
    expect(accepted(files).result.counts.V5_META_COUNT_DISAGREEMENT).toBeUndefined();
    const s = await sectionsOf(files);
    expect(s.meta).toBe('invalid');
    expect(s['source-layout']).toBe('integrity-verified');
  });

  it('holds a META.people count when the people records are carried in a form it cannot count', async () => {
    const files = await converted('integrity-people-demoted', (r) => {
      reconcileMeta(r);
      r.DATA.people = [{ name: 7 }];
      r.META.people = 1;
    });
    expect(accepted(files).candidate.dataset('people')).toBeNull();
    expect((await sectionsOf(files)).meta).toBe('invalid');
  });

  it('reconciles every META count from the candidate itself, whatever the diagnostic counts say', async () => {
    const edits: [string, (meta: any) => void][] = [
      ['docCount', (m) => { m.docCount += 1; }], ['textNone', (m) => { m.textNone += 1; }], ['textPending', (m) => { m.textPending += 1; }],
      ['emails', (m) => { m.emails += 1; }], ['invoices', (m) => { m.invoices += 1; }], ['people', (m) => { m.people += 1; }],
      ['a bundle count', (m) => { m.bundles[Object.keys(m.bundles)[0]!] += 1; }], ['a document type count', (m) => { m.docTypes[Object.keys(m.docTypes)[0]!] += 1; }],
      ['a bundle that holds no record', (m) => { m.bundles['Ghost bundle'] = 2; }], ['an omitted bundle', (m) => { delete m.bundles[Object.keys(m.bundles)[0]!]; }],
      ['an omitted document type', (m) => { delete m.docTypes[Object.keys(m.docTypes)[0]!]; }],
    ];
    const good = await converted('integrity-meta-counts', reconcileMeta);
    const a = accepted(good);
    const ok = await renderRequiredSections({ candidate: a.candidate, projection: a.projection, originals: a.originals, counts: {} });
    expect(ok.find((x) => x.key === 'meta')?.state).toBe('integrity-verified');
    for (const [what, edit] of edits) {
      const tampered = accepted(editPackage(good, 'datasets/meta.json', (env) => edit(env.data)));
      const out = await renderRequiredSections({ candidate: tampered.candidate, projection: tampered.projection, originals: tampered.originals, counts: {} });
      expect(out.find((x) => x.key === 'meta')?.state, what).toBe('invalid');
    }
  });
});

describe('a carried META root always receives its exact check or holds the section', () => {
  it('holds malformed META that the converter demoted to an optional opaque dataset', async () => {
    const files = await chronologyOnly('integrity-meta-demoted', (m) => { m.docCount = 'not-a-count'; });
    const a = accepted(files);
    expect(a.candidate.dataset('meta')).toBeNull();
    expect(a.candidate.dataset('v5-residual-meta')?.provenance.sourcePath).toBe('META');
    const s = await sectionsOf(files);
    expect(s['v5-residual-meta']).toBe('unsupported');
    expect(s.chronology).toBe('valid');
    expect(s['source-layout']).toBe('integrity-verified');
    expect(Object.entries(s).filter(([k, v]) => v !== 'valid' && !(v === 'integrity-verified' && (k === 'meta' || k === 'source-layout'))).length).toBeGreaterThan(0);
  });

  it('holds demoted META in a full package too, and in any roundtripping layout', async () => {
    const files = await converted('integrity-meta-demoted-full', (r) => { reconcileMeta(r); r.META.docCount = 'not-a-count'; });
    const s = await sectionsOf(files);
    expect(s['v5-residual-meta']).toBe('unsupported');
    expect(s['source-layout']).toBe('integrity-verified');
    expect(s.meta).toBeUndefined();
  });

  it('checks a META carried by a dataset whose manifest entry is not required', async () => {
    const files = await converted('integrity-meta-optional', reconcileMeta);
    const c = accepted(files).candidate;
    const meta = c.dataset('meta')!;
    expect((await sectionsOf(files, withDataset(c, { ...meta, required: false }))).meta).toBe('integrity-verified');
    expect((await sectionsOf(files, withDataset(c, { ...meta, key: 'meta-hidden', required: false })))['meta-hidden']).toBe('unsupported');
  });

  it('does not require optional roots the source genuinely omits', async () => {
    const s = await sectionsOf(await chronologyOnly('integrity-omitted-roots'));
    expect(Object.keys(s).sort()).toEqual(['chronology', 'meta', 'source-layout']);
  });
});

describe('sign-off accepts integrity-verified only for registered integrity metadata', () => {
  async function snapshot(): Promise<CandidateSnapshot> {
    const w = await world();
    worlds.push(w);
    return (await w.read())!;
  }
  const withSections = (s: CandidateSnapshot, requiredSections: CandidateSnapshot['requiredSections']) => ({ ...s, requiredSections });

  it('clears META and source-layout and pins the state into the material digest', async () => {
    const s = await snapshot();
    const verified = withSections(s, [{ key: 'chronology', state: 'valid' }, { key: 'meta', state: 'integrity-verified' }, { key: 'source-layout', state: 'integrity-verified' }]);
    expect(checkSnapshot(verified)).not.toBeNull();
    expect(signoffBlocker(verified)).toBeNull();
    const failed = withSections(s, [{ key: 'chronology', state: 'valid' }, { key: 'meta', state: 'invalid' }, { key: 'source-layout', state: 'integrity-verified' }]);
    expect(signoffBlocker(failed)).toEqual({ code: 'required-section', detail: ['meta:invalid'] });
    expect(await sha256Canonical(verified)).not.toBe(await sha256Canonical(failed));
  });

  it('never clears a view section or an unknown key with integrity-verified', async () => {
    const s = await snapshot();
    for (const key of ['chronology', 'discovery-schedules', 'caselines-index', 'x-new']) {
      const v = withSections(s, [{ key, state: 'integrity-verified' }]);
      expect(signoffBlocker(v)).toEqual({ code: 'required-section', detail: [`${key}:integrity-verified`] });
    }
  });
});
