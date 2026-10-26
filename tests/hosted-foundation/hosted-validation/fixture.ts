// Synthetic bytes only. The offline parity oracle reads these exact bytes from a temp folder.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';
import type { ImportResult } from '../../../src/lib/case-package/candidate.ts';
import { sha256Hex } from '../../../src/lib/case-package/hash.ts';
import { importCandidate } from '../../../src/lib/case-package/import.ts';
import type { Limits } from '../../../src/lib/case-package/limits.ts';
import { contentContradictsType } from '../../../src/lib/case-package/media.ts';
import { foldPath } from '../../../src/lib/case-package/paths.ts';
import { buildPackage } from '../../../src/lib/case-package/writer.ts';
import { validateHostedPackage } from '../../../src/lib/case-package/hosted-validation.ts';
import type { OriginalFacts, OriginalFact } from '../../../src/lib/results/hosted/project.ts';

export const bytes = (s: string) => new TextEncoder().encode(s);
export const pdf = (s: string) => bytes('%PDF-1.4\n% synthetic ' + s + '\n%%EOF\n');
export interface Doc { ref: string; path: string; bytes: Uint8Array }
export function docs(n = 2): Doc[] {
  return Array.from({ length: n }, (_, i) => ({ ref: 'OD-' + String(i + 1).padStart(3, '0'), path: 'DOCS/Letter café ' + i + '.pdf', bytes: pdf(String(i)) }));
}
export function fixture(ds = docs()) {
  const { files } = buildPackage({
    caseId: 'synthetic-hosted-validator', inputKind: 'synthetic',
    sources: [{ role: 'synthetic', name: 'invented source', sha256: sha256Hex(bytes('source')), size: 6 }],
    producer: { name: 'hosted-validator-fixture', version: '1' }, created: '2001-01-01T00:00:00Z',
    datasets: [{
      key: 'chronology', kind: 'generated', schema: 'v5.chronology@1', required: true,
      provenance: { source: 'synthetic', sourcePath: 'DATA.chronology', adapter: 'fixture@1' },
      data: ds.map((d, i) => ({
        ref: d.ref, n: String(i + 1), seq: String(i + 1), date: '2001-01-01', filename: d.path.split('/').at(-1)!,
        subject: 'Invented letter', sender: '', to: '', cc: '', excerpt: '', doc_type: 'other', bundle: '',
        amount: '', also_in: [], text_status: 'extracted', url: '', refs: [], invoice_no: '', size: d.bytes.byteLength, attachments: [],
      })),
    }],
    assets: Object.fromEntries(ds.map((d) => [d.ref, { kind: 'file' as const, path: d.path, sha256: sha256Hex(d.bytes), size: d.bytes.byteLength, mediaType: 'application/pdf', textStatus: 'extracted' as const }])),
  });
  return { files, docs: ds, stored: new Map(ds.map((d) => [d.path, d.bytes])) };
}
/** Test-only full-byte verification and sniffing; not the product adapter's responsibility. */
export function factsFor(ds: Doc[], stored: ReadonlyMap<string, Uint8Array>): Map<string, OriginalFact> {
  const out = new Map<string, OriginalFact>();
  for (const d of ds) {
    // Exact priority is per segment, not a whole-path folded search.
    let real = '';
    let found = true;
    for (const segment of d.path.split('/')) {
      const prefix = real ? real + '/' : '';
      const names = [...new Set([...stored.keys()].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length).split('/')[0]!))];
      const folded = names.filter((n) => foldPath(n) === foldPath(segment));
      const name = names.includes(segment) ? segment : folded.length === 1 ? folded[0]! : null;
      if (name === null) { found = false; break; }
      real = prefix + name;
    }
    if (!found || !stored.has(real)) continue;
    const b = stored.get(real)!;
    out.set(d.ref, { path: real, sha256: sha256Hex(b), size: b.byteLength, mediaType: 'application/pdf', status: real === d.path ? 'verified' : 'case-mismatch', downloadOnly: contentContradictsType('application/pdf', b.subarray(0, 1024)) });
  }
  return out;
}
export async function parity(files: Map<string, Uint8Array>, stored: ReadonlyMap<string, Uint8Array>, originals: OriginalFacts, limits?: Partial<Limits>) {
  const root = await mkdtemp(path.join(tmpdir(), 'cc-hosted-validator-'));
  try {
    for (const [p, b] of stored) {
      await mkdir(path.dirname(path.join(root, p)), { recursive: true });
      await writeFile(path.join(root, p), b);
    }
    const canonical = await importCandidate({ files }, root, { limits, concurrency: 1 });
    const hosted = validateHostedPackage({ files, originals, limits });
    expect(complete(hosted.result)).toEqual(complete(canonical));
    return { canonical, ...hosted };
  } finally { await rm(root, { recursive: true, force: true }); }
}
/** Compare every public result/candidate value, not class-instance equality or just verdicts. */
export function complete(r: ImportResult) {
  const { candidate: c, ...base } = r;
  return {
    ...base,
    candidate: c && {
      caseId: c.caseId, formatVersion: c.formatVersion, resultsVersion: c.resultsVersion, manifestSha256: c.manifestSha256, inputRevisionId: c.inputRevisionId,
      manifest: c.manifest, assets: c.assets, identity: c.identity(),
      files: [...c.snapshot()], datasets: c.datasetKeys().map((k) => [k, c.dataset(k)]),
      originals: c.originalRefs().map((k) => [k, c.original(k)]),
      unavailable: Object.keys(c.assets).sort().map((k) => [k, c.isUnavailable(k)]),
    },
  };
}
