// Verification of a supplied results package, and the minimal authored correction. Nothing here rewrites a supplied package:
// `inspectPackage` only reads, and `buildCorrection` derives a NEW package by replacing the data of existing authored
// datasets, keeping every other file's bytes (generated datasets, the asset index) exactly as stored.
import Value from 'typebox/value';
import { canonicalBytes } from '../../case-package/canonical.ts';
import { resultsVersionOf, sha256Hex } from '../../case-package/hash.ts';
import { checkRelPath } from '../../case-package/paths.ts';
import { AssetIndex, DatasetEnvelope, type Asset, type Manifest } from '../../case-package/schema.ts';
import { decodeUtf8Strict, isObject, parseStrictJson, type JsonValue } from '../../case-package/strict-json.ts';
import { verifyCandidateBytes } from '../../case-package/verify-bytes.ts';
import type { ChangeFact } from './ports.ts';

export interface InspectedPackage {
  files: ReadonlyMap<string, Uint8Array>;
  manifest: Manifest;
  manifestSha256: string;
  resultsVersion: string;
  inputRevisionId: string;
  assets: Readonly<Record<string, Asset>>;
}
export type Inspection = { ok: true; value: InspectedPackage } | { ok: false; code: 'package-invalid' | 'wrong-case'; detail: readonly string[] };
const bad = (...detail: string[]): Inspection => ({ ok: false, code: 'package-invalid', detail });

/**
 * Checks the exact bytes against the library's own byte verifier (membership, sizes, sha256, strict manifest schema with no
 * unknown fields, recomputed inputRevision.id and resultsVersion), then that the package names this very case (never a
 * slug-to-case guess) and carries exactly one well-formed asset index. The identity it returns is recomputed from the bytes.
 */
export function inspectPackage(files: ReadonlyMap<string, Uint8Array>, caseId: string): Inspection {
  const manifestBytes = files.get('manifest.json');
  if (!manifestBytes) return bad('manifest.json is not supplied');
  let manifest: unknown;
  try { manifest = parseStrictJson(decodeUtf8Strict(manifestBytes)); } catch { return bad('manifest.json is not strict JSON'); }
  if (!isObject(manifest) || typeof manifest.resultsVersion !== 'string') return bad('manifest.json is not a supported manifest');
  const manifestSha256 = sha256Hex(manifestBytes);
  const verdict = verifyCandidateBytes(files, { resultsVersion: manifest.resultsVersion, manifestSha256 });
  if (!verdict.ok) return bad(...verdict.problems.slice(0, 20));
  const m = manifest as unknown as Manifest;
  if (m.case.id !== caseId) return { ok: false, code: 'wrong-case', detail: ['the package names another case'] };
  const index = m.files.filter((f) => f.role === 'assets');
  if (index.length !== 1) return bad('the package needs exactly one asset index');
  let assets: unknown;
  try { assets = parseStrictJson(decodeUtf8Strict(files.get(index[0].path)!)); } catch { return bad('the asset index is not strict JSON'); }
  if (!Value.Check(AssetIndex, assets)) return bad('the asset index does not match its schema');
  return { ok: true, value: { files, manifest: m, manifestSha256, resultsVersion: m.resultsVersion, inputRevisionId: m.inputRevision.id, assets: (assets as { assets: Record<string, Asset> }).assets } };
}

/** Request-side path rule for a supplied package file: the library's own relative-path check. */
export const packagePathOk = (p: string): boolean => checkRelPath(p).ok;

const countOf = (data: unknown): number => (Array.isArray(data) ? data.length : data !== null && typeof data === 'object' ? Object.keys(data).length : 1);
const DATASET_KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const CORRECTION_PRODUCER = Object.freeze({ name: 'clearcase-operator-correction', version: '1' });

export type Correction =
  | { ok: true; files: Map<string, Uint8Array>; changes: ChangeFact[] }
  | { ok: false; code: 'invalid-correction' | 'no-change'; detail: readonly string[] };

/**
 * A new package from `base` with the data of existing AUTHORED datasets replaced. Generated datasets, the asset index and
 * every other file keep their stored bytes; the manifest takes the changed files' sha256, size and count, a new
 * resultsVersion (the library formula), `parent` = the base resultsVersion and the correction time as `created`. The
 * inputRevision, case and extensions are unchanged. Whether the new data is valid is the validator's call, not this one's.
 */
export function buildCorrection(base: InspectedPackage, replacements: readonly { key: string; data: JsonValue }[], createdIso: string): Correction {
  const bad = (code: 'invalid-correction' | 'no-change', ...detail: string[]): Correction => ({ ok: false, code, detail });
  const seen = new Set<string>();
  const files = new Map(base.files);
  const entries = new Map(base.manifest.files.map((f) => [f.path, { ...f }]));
  const changes: ChangeFact[] = [];
  for (const r of replacements) {
    if (!DATASET_KEY.test(r.key) || seen.has(r.key)) return bad('invalid-correction', `dataset key ${r.key.slice(0, 64)} is invalid or repeated`);
    seen.add(r.key);
    const entry = base.manifest.files.find((f) => f.role === 'dataset' && f.key === r.key);
    if (!entry) return bad('invalid-correction', `${r.key} is not a dataset of this package`);
    if (entry.kind !== 'authored') return bad('invalid-correction', `${r.key} is a generated dataset; only authored datasets are corrected`);
    const oldBytes = files.get(entry.path)!;
    let envelope: unknown;
    try { envelope = parseStrictJson(decodeUtf8Strict(oldBytes)); } catch { return bad('invalid-correction', `${r.key} cannot be read`); }
    if (!Value.Check(DatasetEnvelope, envelope)) return bad('invalid-correction', `${r.key} is not a dataset envelope`);
    let bytes: Uint8Array;
    try { bytes = canonicalBytes({ ...(envelope as object), count: countOf(r.data), data: r.data }); } catch { return bad('invalid-correction', `${r.key} data is not canonical JSON`); }
    const sha256 = sha256Hex(bytes);
    if (sha256 === entry.sha256 && bytes.byteLength === entry.size) continue;
    files.set(entry.path, bytes);
    entries.set(entry.path, { ...entry, count: countOf(r.data), sha256, size: bytes.byteLength });
    changes.push({ path: entry.path, before: { sha256: entry.sha256, size: entry.size }, after: { sha256, size: bytes.byteLength } });
  }
  if (changes.length === 0) return bad('no-change', 'the corrected data equals the stored data');
  const list = [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest: Manifest = {
    ...base.manifest,
    resultsVersion: resultsVersionOf({ formatVersion: base.manifest.formatVersion, caseId: base.manifest.case.id, inputRevisionId: base.inputRevisionId, files: list }),
    parent: base.resultsVersion,
    producer: { ...CORRECTION_PRODUCER },
    created: createdIso,
    files: list,
  };
  files.set('manifest.json', canonicalBytes(manifest));
  changes.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { ok: true, files, changes };
}
