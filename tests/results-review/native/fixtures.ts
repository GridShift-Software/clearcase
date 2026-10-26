// Synthetic fixtures for the native private candidate import tests. Every byte is invented here; no case material is read.
// The package builder, the validator (importCandidate over a temporary case folder) and the byte verifier are the REAL
// case-package library; only storage, identity and the original store are unit doubles (doubles.ts).
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildPackage } from '../../../src/lib/case-package/writer.ts';
import { importCandidate } from '../../../src/lib/case-package/import.ts';
import { sha256Hex } from '../../../src/lib/case-package/hash.ts';

const utf8 = (s: string) => new TextEncoder().encode(s);
export const pdf = (tag: string) => utf8(`%PDF-1.4\n% SYNTHETIC ONLY ${tag}\n%%EOF\n`);
export const shaOf = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export interface Doc { ref: string; path: string; bytes: Uint8Array }
export interface PackageOptions {
  caseId?: string; tag?: string; docs: readonly Doc[];
  /** extra asset entries: aliases (same path under another ref), missing and embedded entries */
  assets?: Record<string, unknown>;
  matter?: { title: string };
  /** the path an asset claims, when it differs from where the document is stored (case/NFC variants) */
  indexedPath?: Record<string, string>;
}

/** A valid results package: a chronology (generated) and a matter (authored) dataset plus the asset index. */
export function buildFixture(o: PackageOptions) {
  const caseId = o.caseId ?? 'case-a', tag = o.tag ?? 'pkg';
  const rows = o.docs.map((d, i) => ({
    n: String(i + 1), ref: d.ref, date: `2001-01-0${i + 1}`, filename: d.path.split('/').pop()!, subject: `Synthetic ${tag} ${i + 1}`, sender: '', to: '', cc: '',
    excerpt: '', doc_type: 'other', bundle: '', amount: '', also_in: [], text_status: 'pending', url: '', refs: [], invoice_no: '', size: d.bytes.byteLength, seq: String(i + 1), attachments: [],
  }));
  const assets: Record<string, unknown> = {};
  for (const d of o.docs) assets[d.ref] = { kind: 'file', path: o.indexedPath?.[d.ref] ?? d.path, sha256: sha256Hex(d.bytes), size: d.bytes.byteLength, mediaType: 'application/pdf', textStatus: 'pending' };
  Object.assign(assets, o.assets ?? {});
  const prov = (sourcePath: string) => ({ source: 'synthetic-native', sourcePath, adapter: 'native-fixture@0' });
  const { manifest, files } = buildPackage({
    caseId, caseLabel: `Synthetic ${tag}`, inputKind: 'synthetic-native',
    // the converter input is HTML, never the PDFs: the identity here must not equal any submitted file digest
    sources: [{ role: 'synthetic-html', name: 'workspace.html', sha256: sha256Hex(utf8(`html-${tag}`)), size: 100 + tag.length }],
    producer: { name: 'native-fixture', version: '1' }, created: '2001-01-01T00:00',
    datasets: [
      { key: 'chronology', kind: 'generated', schema: 'v5.chronology@1', required: true, provenance: prov('DATA.chronology'), data: rows },
      { key: 'matter', kind: 'authored', schema: 'v5.matter@1', required: true, provenance: prov('DATA.matter'), data: { title: o.matter?.title ?? 'Matter', short: 'M', forum: 'High Court', storyline: [{ h: 'Background', t: 'Synthetic.' }], strategy: [] } },
    ],
    assets: assets as never,
  });
  return { manifest, files, docs: o.docs, caseId };
}
export type Fixture = ReturnType<typeof buildFixture>;

export const asText = (files: ReadonlyMap<string, Uint8Array>) => Object.fromEntries([...files].map(([p, b]) => [p, new TextDecoder().decode(b)]));
export const fromText = (obj: Record<string, string>) => new Map(Object.entries(obj).map(([p, t]) => [p, utf8(t)]));

export interface ValidatedCandidate {
  verdict: 'accept' | 'report'; validatorVersion: string; diagnosticsSha256: string; warningFingerprints: readonly string[];
  caseMismatch: readonly { ref: string; fingerprint: string }[];
  resultsVersion: string; manifestSha256: string; inputRevisionId: string;
}
export type Validation = { ok: true; value: ValidatedCandidate } | { ok: false; codes: string[] };

/** The real validator: `importCandidate` over a temporary case folder holding exactly the given submitted files. */
export async function validateAgainst(files: ReadonlyMap<string, Uint8Array>, folder: ReadonlyMap<string, Uint8Array>): Promise<Validation> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cc-native-'));
  try {
    for (const [p, bytes] of folder) { await mkdir(path.join(dir, path.dirname(p)), { recursive: true }); await writeFile(path.join(dir, p), bytes); }
    const r = await importCandidate({ files }, dir);
    if (r.verdict === 'reject') return { ok: false, codes: r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code) };
    const c = r.candidate;
    return { ok: true, value: {
      verdict: r.verdict, validatorVersion: r.validatorVersion, diagnosticsSha256: r.diagnosticsSha256, warningFingerprints: r.warningFingerprints,
      caseMismatch: r.diagnostics.filter((d) => d.code === 'ORIG_CASE_MISMATCH').map((d) => ({ ref: d.subject!, fingerprint: d.fingerprint })),
      resultsVersion: c.resultsVersion, manifestSha256: c.manifestSha256, inputRevisionId: c.inputRevisionId,
    } };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
