// The META section of snapshot v2 on genuine converter-generated packages and the canonical validator's own output: the gate's
// derivation must agree with the validator warning for warning, and the v1 renderer must still call the same META invalid.
import { afterAll, describe, expect, it } from 'vitest';
import { buildSynth, editPackage } from '../../case-package/fixtures/build.ts';
import { cleanup } from '../../case-package/fixtures/synth.ts';
import { validateHostedPackage } from '../../../src/lib/case-package/hosted-validation.ts';
import { preparePackage, type OriginalFacts } from '../../../src/lib/results/hosted/project.ts';
import { metaSectionOf, renderRequiredSections } from '../../../src/lib/server/runtime/hosted/required-section-render.ts';

const roots: string[] = [];
afterAll(async () => { for (const r of roots) await cleanup(r); });

async function validated(tag: string, edit?: (meta: Record<string, any>) => void) {
  const b = await buildSynth(tag);
  roots.push(b.root);
  const files = edit ? editPackage(b.files, 'datasets/meta.json', (env) => edit(env.data)) : b.files;
  const prepared = preparePackage(files);
  if (!prepared.ok) throw new Error(prepared.problems.join('; '));
  const facts: OriginalFacts = new Map(prepared.fileAssets.map((f) => [f.key, { path: f.path, sha256: f.sha256, size: f.size, mediaType: f.mediaType, status: 'verified' as const, downloadOnly: false }]));
  const { result } = validateHostedPackage({ files, originals: facts });
  expect(result.errorFingerprints).toEqual([]);
  const projected = prepared.project(facts);
  if (!projected.ok) throw new Error(projected.problems.join('; '));
  return { result, candidate: result.candidate!, projection: projected.projection, originals: new Map(prepared.fileAssets.map((f) => [f.key, `asset-${f.key}`])) };
}
const section = (v: Awaited<ReturnType<typeof validated>>) => metaSectionOf({ candidate: v.candidate, counts: v.result.counts,
  validation: { validatorVersion: v.result.validatorVersion, diagnosticsSha256: v.result.diagnosticsSha256, warningFingerprints: v.result.warningFingerprints } });
const v1State = async (v: Awaited<ReturnType<typeof validated>>) =>
  (await renderRequiredSections({ candidate: v.candidate, projection: v.projection, originals: v.originals, counts: v.result.counts })).find((s) => s.key === 'meta')?.state;
const warned = (v: Awaited<ReturnType<typeof validated>>) => v.result.diagnostics.filter((d) => d.code === 'V5_META_COUNT_DISAGREEMENT');

describe('META section v2 against the canonical validator', () => {
  it('finds the validator\'s own two disagreements, warning for warning, while v1 still calls the META invalid', async () => {
    const v = await validated('meta-v2-sample');
    expect(v.result.counts.V5_META_COUNT_DISAGREEMENT).toBe(2);
    const s = section(v)!;
    expect(s.state).toBe('disagrees');
    if (s.state !== 'disagrees') return;
    expect(s.disagreements.map((d) => [d.subject, d.carried, d.derived]).sort()).toEqual([['META.emails', 1, 2], ['META.textNone', 1, 2]]);
    expect(s.disagreements.map((d) => d.diagnostic).sort()).toEqual(warned(v).map((d) => d.fingerprint).sort());
    expect(s.disagreements.map((d) => d.subject).sort()).toEqual(warned(v).map((d) => d.subject).sort());
    expect(await v1State(v)).toBe('invalid');
  });

  it('follows the validator through tallies: a wrong key, an absent key, a key with no records, and keys that need escaping', async () => {
    const v = await validated('meta-v2-tallies', (m) => {
      m.bundles = { Original: 4, Correspondence: 3, 'a/b~c': 3, '2024': 4 };
      m.docTypes = { SLA: 1, invoice: 1, other: 2, email: 2, statement: 1, Ghost: 1 };
    });
    const s = section(v)!;
    expect(warned(v).map((d) => d.subject).sort()).toEqual(['META.bundles["2024"]', 'META.bundles["Correspondence"]', 'META.bundles["Supplementary"]', 'META.bundles["a/b~c"]', 'META.docTypes["Ghost"]', 'META.emails', 'META.textNone']);
    expect(s.state).toBe('disagrees');
    if (s.state !== 'disagrees') return;
    expect(s.disagreements.map((d) => d.diagnostic).sort()).toEqual(warned(v).map((d) => d.fingerprint).sort());
    expect(s.disagreements.find((d) => d.subject === 'META.bundles["Supplementary"]')).toMatchObject({ carried: null, derived: 1 });
    expect(s.disagreements.find((d) => d.subject === 'META.docTypes["Ghost"]')).toMatchObject({ carried: 1, derived: 0 });
  });

  it('verifies a reconciled META, and finds a tampered total as a disagreement the validator also reports', async () => {
    const exact = (m: Record<string, any>) => Object.assign(m, { textNone: 2, emails: 2 });
    const ok = await validated('meta-v2-ok', exact);
    expect(ok.result.counts.V5_META_COUNT_DISAGREEMENT).toBeUndefined();
    expect(section(ok)).toEqual({ state: 'integrity-verified' });
    expect(await v1State(ok)).toBe('integrity-verified');
    const tampered = await validated('meta-v2-tampered', (m) => { exact(m); m.docCount += 1; });
    expect(warned(tampered).map((d) => d.subject)).toEqual(['META.docCount']);
    const s = section(tampered)!;
    expect(s.state === 'disagrees' && s.disagreements.map((d) => [d.subject, d.carried, d.derived])).toEqual([['META.docCount', 8, 7]]);
    expect(await v1State(tampered)).toBe('invalid');
  });

  it('holds a validator warning the records do not explain, and a validation that does not list the disagreement', async () => {
    const v = await validated('meta-v2-unexplained');
    const bare = { candidate: v.candidate, counts: v.result.counts };
    const validation = { validatorVersion: v.result.validatorVersion, diagnosticsSha256: v.result.diagnosticsSha256 };
    expect(metaSectionOf({ ...bare, validation: { ...validation, warningFingerprints: [] } })).toEqual({ state: 'invalid' });
    expect(metaSectionOf({ ...bare, counts: { ...v.result.counts, V5_META_COUNT_DISAGREEMENT: 3 }, validation: { ...validation, warningFingerprints: v.result.warningFingerprints } })).toEqual({ state: 'invalid' });
    const exact = await validated('meta-v2-unexplained-ok', (m) => Object.assign(m, { textNone: 2, emails: 2 }));
    expect(metaSectionOf({ candidate: exact.candidate, counts: { V5_META_COUNT_DISAGREEMENT: 1 }, validation: { ...validation, warningFingerprints: exact.result.warningFingerprints } })).toEqual({ state: 'invalid' });
  });

  it('is not derived for a candidate with no registered META', async () => {
    const v = await validated('meta-v2-none');
    const meta = v.candidate.dataset('meta')!;
    expect(section({ ...v, candidate: Object.assign(Object.create(v.candidate), { dataset: (k: string) => (k === 'meta' ? { ...meta, schema: 'opaque@1' } : v.candidate.dataset(k)) }) })).toBeNull();
  });
});
