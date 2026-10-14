// The newer builder of the v5 workspace HTML: its generation is recognised, and a dataset whose shape the converter
// does not map is demoted to an opaque residual instead of refusing the case. Every value below is invented.
import { afterAll, describe, expect, it } from 'vitest';
import { DiagSink } from '../../src/lib/case-package/diagnostics.ts';
import { importCandidate } from '../../src/lib/case-package/import.ts';
import { extractV5 } from '../../src/lib/case-package/v5/extract.ts';
import { buildSynth } from './fixtures/build.ts';
import { cleanup, synthHtml, synthRoots } from './fixtures/synth.ts';

type J = Record<string, any>;
const roots: string[] = [];
afterAll(async () => { for (const r of roots) await cleanup(r); });
const datasetKeys = (b: Awaited<ReturnType<typeof buildSynth>>) => b.result.manifest!.files.filter((f) => f.role === 'dataset').map((f) => f.key);

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
