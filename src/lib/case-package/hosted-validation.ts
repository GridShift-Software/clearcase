// Pure adapter for already verified hosted originals. This does not read or prove an
// original, authorize an import, select submission links, stage a candidate or publish.
import type { OriginalFact, OriginalFacts } from '../results/hosted/project.ts';
import { Candidate, VALIDATOR_VERSION, type ImportResult } from './candidate.ts';
import { DiagSink, diagnosticsDigest, fingerprint, type At } from './diagnostics.ts';
import { withLimits, type Limits } from './limits.ts';
import type { OriginalMapping } from './originals.ts';
import { checkRelPath, foldPath, isReservedPath } from './paths.ts';
import type { Asset, FileAsset } from './schema.ts';
import { decodeUtf8Strict, escapePointer, isObject, parseStrictJson } from './strict-json.ts';
import type { HeldFile } from './source.ts';
import { validateSnapshot, type ValidatedPackage } from './validate.ts';

export interface HostedValidationInput {
  files: ReadonlyMap<string, Uint8Array>;
  /** Only caller-verified, case-scoped D1/R2 facts; never request/package claims. */
  originals: OriginalFacts;
  limits?: Partial<Limits>;
  /**
   * Previews carried as the facts their storage check produced, not as bytes, so a stepped import need not hold them. A held
   * path must not also be in `files`. The candidate lists these paths but holds no bytes for them.
   */
  held?: ReadonlyMap<string, HeldFile>;
}
export interface HostedValidation {
  result: ImportResult;
  /** Uncapped canonical ORIG_CASE_MISMATCH identities, for exact original lineage. */
  caseMismatch: readonly { ref: string; fingerprint: string }[];
}

export function validateHostedPackage({ files, originals, limits, held }: HostedValidationInput): HostedValidation {
  const L = withLimits(limits);
  const sink = new DiagSink(L.diagnosticsPerCode);
  let pkg: ValidatedPackage | null = null;
  const mapping = new Map<string, OriginalMapping>();
  const unavailable = new Set<string>();
  const caseMismatch: { ref: string; fingerprint: string }[] = [];
  try {
    const snap = snapshotMemory(files, L, sink, held);
    if (snap) pkg = validateSnapshot(snap, sink, L);
    if (pkg && sink.errors === 0) {
      applyOriginalFacts(pkg.assets, originals, L, sink, mapping, unavailable, caseMismatch);
      flagCitedUnavailable(pkg, unavailable, sink);
    }
  } catch (e) {
    pkg = null;
    sink.add('PKG_UNPROCESSABLE', `unexpected failure: ${String((e as Error)?.message ?? 'error').slice(0, 200)}`);
  }
  let result: ImportResult;
  try {
    const base = summarise(sink);
    result = !pkg || sink.errors > 0
      ? { ...base, verdict: 'reject', candidate: null }
      : { ...base, verdict: sink.count('warning') > 0 ? 'report' : 'accept', candidate: new Candidate({ ...pkg, originals: mapping, unavailable }) };
  } catch (e) {
    const failed = new DiagSink(L.diagnosticsPerCode);
    failed.add('PKG_UNPROCESSABLE', `unexpected failure: ${String((e as Error)?.message ?? 'error').slice(0, 200)}`);
    result = { ...summarise(failed), verdict: 'reject', candidate: null };
    caseMismatch.length = 0;
  }
  for (const d of result.diagnostics) Object.freeze(d);
  Object.freeze(result.diagnostics);
  Object.freeze(result.counts);
  Object.freeze(result.warningFingerprints);
  Object.freeze(result.errorFingerprints);
  return Object.freeze({
    result: Object.freeze(result),
    caseMismatch: Object.freeze(caseMismatch.sort((a, b) => a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0).map((x) => Object.freeze(x))),
  });
}

// Match source.ts's memory transport, without importing its filesystem/ZIP capabilities.
// Presence and bounds precede copying; only manifest-listed bytes enter the snapshot.
function snapshotMemory(input: ReadonlyMap<string, Uint8Array>, L: Limits, sink: DiagSink, held?: ReadonlyMap<string, HeldFile>) {
  const present = new Map<string, number>();
  const all = new Map<string, Uint8Array>();
  let total = 0;
  for (const [p, b] of input) {
    if (!(b instanceof Uint8Array)) { sink.add('PKG_SOURCE_INVALID', 'every value must be a Uint8Array', { subject: String(p).slice(0, 200) }); return null; }
    const v = checkRelPath(p);
    if (!v.ok) { sink.add(v.traversal ? 'PKG_PATH_TRAVERSAL' : 'PKG_PATH_INVALID', v.reason, { subject: String(p).slice(0, 200) }); continue; }
    present.set(p, b.byteLength);
    all.set(p, b);
    total += b.byteLength;
    if (present.size > L.packageFiles) { sink.add('PKG_TOO_MANY_FILES', `more than ${L.packageFiles} files`); return null; }
    if (total > L.packageBytes) { sink.add('PKG_TOO_LARGE', `more than ${L.packageBytes} bytes`); return null; }
  }
  for (const [p, h] of held ?? []) {
    if (all.has(p)) { sink.add('PKG_SOURCE_INVALID', 'a held file must not also be supplied as bytes', { subject: String(p).slice(0, 200) }); return null; }
    const v = checkRelPath(p);
    if (!v.ok) { sink.add(v.traversal ? 'PKG_PATH_TRAVERSAL' : 'PKG_PATH_INVALID', v.reason, { subject: String(p).slice(0, 200) }); continue; }
    present.set(p, h.size);
    total += h.size;
    if (present.size > L.packageFiles) { sink.add('PKG_TOO_MANY_FILES', `more than ${L.packageFiles} files`); return null; }
    if (total > L.packageBytes) { sink.add('PKG_TOO_LARGE', `more than ${L.packageBytes} bytes`); return null; }
  }
  const files = new Map<string, Uint8Array>();
  const copy = (p: string, max: number) => { const b = all.get(p); if (b && b.byteLength <= max) files.set(p, new Uint8Array(b)); };
  copy('manifest.json', L.manifestBytes);
  const manifest = files.get('manifest.json');
  if (manifest) {
    let listed: string[] = [];
    try {
      const m = parseStrictJson(decodeUtf8Strict(manifest));
      if (isObject(m) && Array.isArray(m.files)) listed = m.files.flatMap((f) => isObject(f) && typeof f.path === 'string' && checkRelPath(f.path).ok ? [f.path] : []);
    } catch { /* validateSnapshot diagnoses malformed JSON. */ }
    for (const p of new Set(listed)) if (p !== 'manifest.json') copy(p, L.fileBytes);
  }
  return { files, present, transport: 'memory' as const, ...(held ? { held } : {}) };
}

function assetAt(ref: string, a: FileAsset): At {
  return { file: 'assets.json', pointer: `/assets/${escapePointer(ref)}/path`, subject: ref, identity: `${a.sha256}\u0000${a.size}\u0000${a.path}` };
}

// OriginalFacts contains positive proofs only. A missing, malformed or inconsistent fact
// asserts no availability. Case/NFC uniqueness and byte sniffing are the caller's proofs,
// not something this adapter can reconstruct from the package or the fact's presence.
function usableFact(f: OriginalFact | undefined, a: FileAsset): f is OriginalFact {
  return !!f && typeof f.path === 'string' && checkRelPath(f.path).ok && !isReservedPath(f.path)
    && typeof f.sha256 === 'string' && /^[0-9a-f]{64}$/.test(f.sha256)
    && Number.isSafeInteger(f.size) && f.size >= 0 && f.mediaType === a.mediaType && typeof f.downloadOnly === 'boolean'
    && (f.status === 'verified' ? f.path === a.path : f.status === 'case-mismatch' && f.path !== a.path && foldPath(f.path) === foldPath(a.path));
}

function applyOriginalFacts(
  assets: Record<string, Asset>, facts: OriginalFacts, L: Limits, sink: DiagSink,
  mapping: Map<string, OriginalMapping>, unavailable: Set<string>, caseMismatch: { ref: string; fingerprint: string }[],
): void {
  const located = new Map<string, OriginalFact>();
  const unique = new Map<string, { sha256: string; size: number; ambiguous: boolean }>();
  for (const [ref, a] of Object.entries(assets)) {
    if (a.kind === 'missing') unavailable.add(ref);
    if (a.kind !== 'file') continue;
    const f = facts.get(ref);
    if (!usableFact(f, a)) continue;
    located.set(ref, f);
    const prev = unique.get(f.path);
    if (prev) prev.ambiguous ||= prev.sha256 !== f.sha256 || prev.size !== f.size;
    else unique.set(f.path, { sha256: f.sha256, size: f.size, ambiguous: false });
  }
  for (const [ref, a] of Object.entries(assets)) {
    if (a.kind !== 'file') continue;
    const f = located.get(ref);
    const at = assetAt(ref, a);
    if (!f || unique.get(f.path)!.ambiguous) {
      located.delete(ref);
      unavailable.add(ref);
      sink.add('ORIG_MISSING', 'original not found in the selected case folder; the document stays flagged as missing', at);
    } else if (f.size > L.originalBytes) sink.add('ORIG_TOO_LARGE', `original is ${f.size} bytes, above the ${L.originalBytes}-byte bound`, at);
    else if (f.size !== a.size) sink.add('ORIG_FINGERPRINT_MISMATCH', `size ${f.size} differs from the indexed ${a.size}`, at);
  }
  const totalBytes = [...unique.values()].filter((f) => !f.ambiguous).reduce((n, f) => n + f.size, 0);
  if (totalBytes > L.originalsTotalBytes) sink.add('ORIG_TOTAL_TOO_LARGE', `referenced originals total ${totalBytes} bytes, above the ${L.originalsTotalBytes}-byte bound`);
  if (sink.has('ORIG_TOO_LARGE') || sink.has('ORIG_TOTAL_TOO_LARGE')) return;
  for (const [ref, a] of Object.entries(assets)) {
    if (a.kind !== 'file') continue;
    const f = located.get(ref);
    if (!f || f.size !== a.size) continue;
    const at = assetAt(ref, a);
    if (f.sha256 !== a.sha256) { sink.add('ORIG_FINGERPRINT_MISMATCH', 'sha256 differs from the asset index', at); continue; }
    if (f.status === 'case-mismatch') {
      sink.add('ORIG_CASE_MISMATCH', 'found only by a case- or normalisation-insensitive match; the real on-disk name is recorded', at);
      caseMismatch.push({ ref, fingerprint: fingerprint('ORIG_CASE_MISMATCH', at) });
    }
    if (f.downloadOnly) sink.add('ORIG_MEDIA_MISMATCH', `content does not look like ${a.mediaType}; it will only be offered as a download`, at);
    mapping.set(ref, { ref, path: f.path, sha256: f.sha256, size: f.size, mediaType: f.mediaType, status: f.status, downloadOnly: f.downloadOnly });
  }
}

// Keep import.ts's citation/root policy, including embedded descendants and deduplication.
function flagCitedUnavailable(pkg: ValidatedPackage, unavailable: Set<string>, sink: DiagSink): void {
  const rootOf = (ref: string): string => {
    let r = ref;
    for (let d = 0; d <= 4; d++) { const a: Asset | undefined = pkg.assets[r]; if (!a?.parentRef) return r; r = a.parentRef; }
    return r;
  };
  const seen = new Set<string>();
  for (const c of pkg.citations) {
    if (seen.has(c.ref) || !pkg.assets[c.ref]) continue;
    if (unavailable.has(rootOf(c.ref)) || pkg.assets[c.ref]?.kind === 'missing') {
      seen.add(c.ref);
      sink.add('CITE_TARGET_NO_ORIGINAL', `${c.ref} is cited but its original is unavailable`, { subject: c.ref });
    }
  }
}

function summarise(sink: DiagSink) {
  const diagnostics = sink.finish();
  const counts = Object.fromEntries([...sink.counts].sort(([a], [b]) => a < b ? -1 : 1));
  const warningFingerprints = [...sink.warningFingerprints].sort();
  return {
    diagnostics,
    diagnosticsSha256: diagnosticsDigest(VALIDATOR_VERSION, diagnostics, counts, warningFingerprints),
    validatorVersion: VALIDATOR_VERSION,
    counts,
    warningFingerprints,
    errorFingerprints: [...sink.errorFingerprints].sort(),
  };
}
