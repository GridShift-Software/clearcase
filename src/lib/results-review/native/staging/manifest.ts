import Value from 'typebox/value';
import { inputRevisionId, resultsVersionOf, sha256Hex } from '../../../case-package/hash.ts';
import { FORMAT, FORMAT_VERSION, Manifest } from '../../../case-package/schema.ts';
import { decodeUtf8Strict, isObject, parseStrictJson } from '../../../case-package/strict-json.ts';
import { packagePathOk } from '../package.ts';
import { STRUCTURED_FILES } from './steps.ts';

export interface ManifestListing {
  readonly manifest: Manifest;
  readonly manifestSha256: string;
  /** The listed files only; `manifest.json` itself is the session's manifest object. */
  readonly files: ReadonlyMap<string, { sha256: string; size: number }>;
  readonly listedBytes: number;
}
export type ManifestCheck = { ok: true; value: ManifestListing } | { ok: false; code: 'package-invalid' | 'wrong-case' | 'too-large'; detail: readonly string[] };
export interface ManifestLimits { maxFiles: number; maxFileBytes: number; maxPackageBytes: number; maxBatchBytes: number }

const bad = (code: 'package-invalid' | 'wrong-case' | 'too-large', ...detail: string[]): ManifestCheck => ({ ok: false, code, detail });

/**
 * Checks a manifest on its own, before any file is sent: strict JSON, the committed schema, both recomputed identities, the case,
 * and the budget (files, bytes, and that every file fits one batch). It cannot know that the listed files exist; each batch is
 * verified against these entries and `inspectPackage` checks the whole package again at completion.
 */
export function checkManifest(bytes: Uint8Array, caseId: string, limits: ManifestLimits): ManifestCheck {
  if (bytes.byteLength > limits.maxFileBytes) return bad('too-large', 'manifest.json is larger than this deployment accepts');
  let parsed: unknown;
  try { parsed = parseStrictJson(decodeUtf8Strict(bytes)); } catch { return bad('package-invalid', 'manifest.json is not strict JSON'); }
  if (!isObject(parsed) || parsed.format !== FORMAT || parsed.formatVersion !== FORMAT_VERSION || !Value.Check(Manifest, parsed)) return bad('package-invalid', 'manifest.json is not a supported manifest');
  const m = parsed as unknown as Manifest;
  if (inputRevisionId(m.inputRevision.sources) !== m.inputRevision.id) return bad('package-invalid', 'inputRevision.id does not match its sources');
  if (resultsVersionOf({ formatVersion: m.formatVersion, caseId: m.case.id, inputRevisionId: m.inputRevision.id, files: m.files }) !== m.resultsVersion) return bad('package-invalid', 'recomputed resultsVersion differs from the manifest');
  if (m.case.id !== caseId) return bad('wrong-case', 'the package names another case');
  if (m.files.length + 1 > limits.maxFiles) return bad('too-large', 'the package has more files than this deployment accepts');
  const files = new Map<string, { sha256: string; size: number }>();
  let listedBytes = 0;
  for (const f of m.files) {
    if (f.path === 'manifest.json' || files.has(f.path) || !packagePathOk(f.path)) return bad('package-invalid', `${f.path.slice(0, 200)}: not a unique, safe, listed package path`);
    if (f.size > limits.maxFileBytes) return bad('too-large', `${f.path.slice(0, 200)}: larger than a package file may be here`);
    if (f.size > limits.maxBatchBytes) return bad('too-large', `${f.path.slice(0, 200)}: larger than one batch can carry (${limits.maxBatchBytes} bytes)`);
    listedBytes += f.size;
    files.set(f.path, { sha256: f.sha256, size: f.size });
  }
  if (listedBytes + bytes.byteLength > limits.maxPackageBytes) return bad('too-large', 'the package is larger than this deployment accepts');
  if (m.files.filter((f) => f.role === 'assets').length !== 1) return bad('package-invalid', 'the package needs exactly one asset index');
  // A step loads every non-preview file at once, so their number is held to what a package may have before any is read.
  if (m.files.filter((f) => f.role !== 'preview').length + 1 > STRUCTURED_FILES) return bad('too-large', `the package lists more datasets than a package may have (${STRUCTURED_FILES - 2})`);
  return { ok: true, value: { manifest: m, manifestSha256: sha256Hex(bytes), files, listedBytes } };
}
