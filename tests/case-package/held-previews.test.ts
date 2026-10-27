// A stepped import checks each preview's bytes where they are stored (size, SHA-256, PDF header) and then hands the validator only
// those facts. This holds the validator, the byte verifier and the projector to answering exactly as they do with the bytes.
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/lib/case-package/hash.ts';
import { validateHostedPackage } from '../../src/lib/case-package/hosted-validation.ts';
import { verifyCandidateBytes } from '../../src/lib/case-package/verify-bytes.ts';
import { buildPackage } from '../../src/lib/case-package/writer.ts';
import { inspectPackage } from '../../src/lib/results-review/native/package.ts';
import { preparePackage, type OriginalFact } from '../../src/lib/results/hosted/project.ts';
import { readModelDigest } from '../../src/lib/results/hosted/read-model.ts';

const utf8 = (s: string) => new TextEncoder().encode(s);
const pdf = (tag: string) => utf8(`%PDF-1.4\n% synthetic ${tag}\n%%EOF\n`);
const ORIGINAL = pdf('original');

function build(previews: ReadonlyMap<string, Uint8Array>, claim: (path: string, bytes: Uint8Array) => { path: string; sha256: string; size: number } = (path, bytes) => ({ path, sha256: sha256Hex(bytes), size: bytes.byteLength })) {
  const refs = ['OD-001', 'OD-002', 'OD-003'];
  const paths = [...previews.keys()];
  const { files } = buildPackage({
    caseId: 'synthetic-held', inputKind: 'synthetic', sources: [{ role: 'synthetic', name: 'invented', sha256: sha256Hex(utf8('source')), size: 6 }],
    producer: { name: 'held-fixture', version: '1' }, created: '2001-01-01T00:00:00Z',
    datasets: [{ key: 'chronology', kind: 'generated', schema: 'v5.chronology@1', required: true, provenance: { source: 'synthetic', sourcePath: 'DATA.chronology', adapter: 'fixture@1' },
      data: refs.map((ref, i) => ({ ref, n: String(i + 1), seq: String(i + 1), date: '2001-01-01', filename: 'a.pdf', subject: 'Invented', sender: '', to: '', cc: '', excerpt: '', doc_type: 'other', bundle: '', amount: '', also_in: [], text_status: 'extracted', url: '', refs: [], invoice_no: '', size: ORIGINAL.byteLength, attachments: [] })) }],
    assets: Object.fromEntries(refs.map((ref, i) => [ref, { kind: 'file' as const, path: 'DOCS/a.pdf', sha256: sha256Hex(ORIGINAL), size: ORIGINAL.byteLength, mediaType: 'application/pdf', textStatus: 'extracted' as const,
      ...(paths[i] ? { preview: { ...claim(paths[i]!, previews.get(paths[i]!)!), originalSha256: sha256Hex(ORIGINAL) } } : {}) }])),
    previews,
  });
  return files;
}
const originals = new Map<string, OriginalFact>(['OD-001', 'OD-002', 'OD-003'].map((ref) => [ref, { path: 'DOCS/a.pdf', sha256: sha256Hex(ORIGINAL), size: ORIGINAL.byteLength, mediaType: 'application/pdf', status: 'verified', downloadOnly: false }]));

/** The package split as a stepped import holds it: every non-preview file as bytes, each preview as the facts its storage check produced. */
function split(files: ReadonlyMap<string, Uint8Array>, manifestPreviews: readonly string[]) {
  const held = new Map<string, { size: number; sha256: string; pdf: boolean }>();
  const kept = new Map(files);
  for (const p of manifestPreviews) {
    const b = files.get(p)!;
    held.set(p, { size: b.byteLength, sha256: sha256Hex(b), pdf: b.length >= 5 && new TextDecoder().decode(b.subarray(0, 5)) === '%PDF-' });
    kept.delete(p);
  }
  return { kept, held };
}
const summary = (r: ReturnType<typeof validateHostedPackage>) => ({
  verdict: r.result.verdict, digest: r.result.diagnosticsSha256, counts: r.result.counts, warnings: r.result.warningFingerprints, errors: r.result.errorFingerprints, caseMismatch: r.caseMismatch,
  codes: r.result.diagnostics.map((d) => `${d.code}:${d.file ?? ''}:${d.subject ?? ''}`),
  paths: r.result.candidate?.paths() ?? null,
});

describe('previews carried by their checked facts', () => {
  const previews = new Map([['previews/a.pdf', pdf('a')], ['previews/b.pdf', pdf('b with more bytes in it')]]);

  it('validates a package to the same result as with the preview bytes, and lists the same files', () => {
    const files = build(previews), { kept, held } = split(files, [...previews.keys()]);
    const full = validateHostedPackage({ files, originals }), lean = validateHostedPackage({ files: kept, originals, held });
    expect(full.result.verdict).not.toBe('reject');
    expect(summary(lean)).toEqual(summary(full));
    expect(lean.result.candidate!.paths()).toContain('previews/a.pdf');
    expect(kept.has('previews/a.pdf')).toBe(false);
  });

  it('verifies the bytes the same way, and refuses a held fact that disagrees with the manifest', () => {
    const files = build(previews), { kept, held } = split(files, [...previews.keys()]);
    const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')!)) as { resultsVersion: string };
    const identity = { resultsVersion: manifest.resultsVersion, manifestSha256: sha256Hex(files.get('manifest.json')!) };
    expect(verifyCandidateBytes(files, identity)).toEqual({ ok: true, problems: [] });
    expect(verifyCandidateBytes(kept, identity, held)).toEqual({ ok: true, problems: [] });
    expect(verifyCandidateBytes(kept, identity).ok).toBe(false);
    for (const lie of [{ size: held.get('previews/a.pdf')!.size + 1 }, { sha256: '0'.repeat(64) }]) {
      const bad = new Map(held).set('previews/a.pdf', { ...held.get('previews/a.pdf')!, ...lie });
      expect(verifyCandidateBytes(kept, identity, bad).ok).toBe(false);
    }
    // A held path the manifest does not list is as unexpected as an extra file.
    expect(verifyCandidateBytes(kept, identity, new Map(held).set('previews/extra.pdf', { size: 5, sha256: '1'.repeat(64), pdf: true })).ok).toBe(false);
  });

  it('inspects a package to the same identity and asset index', () => {
    const files = build(previews), { kept, held } = split(files, [...previews.keys()]);
    const full = inspectPackage(files, 'synthetic-held'), lean = inspectPackage(kept, 'synthetic-held', held);
    expect(full.ok && lean.ok).toBe(true);
    if (full.ok && lean.ok) {
      expect(lean.value.resultsVersion).toBe(full.value.resultsVersion);
      expect(lean.value.manifestSha256).toBe(full.value.manifestSha256);
      expect(lean.value.assets).toEqual(full.value.assets);
    }
    expect(inspectPackage(kept, 'synthetic-held').ok).toBe(false);
  });

  it('projects the same read model', async () => {
    const files = build(previews), { kept, held } = split(files, [...previews.keys()]);
    const a = preparePackage(files), b = preparePackage(kept, held);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const full = a.project(originals), lean = b.project(originals);
    expect(full.ok && lean.ok).toBe(true);
    if (full.ok && lean.ok) {
      expect(lean.projection.expect).toEqual(full.projection.expect);
      expect(await readModelDigest(lean.projection)).toBe(await readModelDigest(full.projection));
    }
  });

  it('rejects a preview that is not a PDF with the same diagnostics', () => {
    const files = build(new Map([['previews/a.pdf', utf8('<html>not a pdf</html>')], ['previews/b.pdf', pdf('b')]]));
    const { kept, held } = split(files, ['previews/a.pdf', 'previews/b.pdf']);
    const full = validateHostedPackage({ files, originals }), lean = validateHostedPackage({ files: kept, originals, held });
    expect(full.result.verdict).toBe('reject');
    expect(full.result.diagnostics.map((d) => d.code)).toContain('PKG_PREVIEW_INVALID');
    expect(summary(lean)).toEqual(summary(full));
  });

  it('rejects a preview whose bytes are not the manifest\'s with the same diagnostics', () => {
    const files = build(previews, (path, bytes) => ({ path, sha256: sha256Hex(bytes), size: bytes.byteLength }));
    const tampered = new Map(files).set('previews/a.pdf', pdf('a changed'));
    const { kept, held } = split(tampered, [...previews.keys()]);
    const full = validateHostedPackage({ files: tampered, originals }), lean = validateHostedPackage({ files: kept, originals, held });
    expect(full.result.diagnostics.map((d) => d.code)).toContain('PKG_FILE_HASH_MISMATCH');
    expect(summary(lean)).toEqual(summary(full));
  });

  it('does not let a held fact stand in for a file the manifest lists as something else', () => {
    const files = build(previews), { kept } = split(files, [...previews.keys()]);
    const held = new Map([['datasets/chronology.json', { size: files.get('datasets/chronology.json')!.byteLength, sha256: sha256Hex(files.get('datasets/chronology.json')!), pdf: true }]]);
    const lean = validateHostedPackage({ files: new Map([...kept].filter(([p]) => p !== 'datasets/chronology.json')), originals, held });
    expect(lean.result.verdict).toBe('reject');
  });
});
