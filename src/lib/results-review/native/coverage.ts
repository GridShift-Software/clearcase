// The exact-required-file-set policy (`exact-required-file-set/1`), as a pure function over the package's asset index, the
// finalized submission and the validator's own ORIG_CASE_MISMATCH diagnostics. It never hashes, never rewrites a package
// value and never invents a warning: a fact it cannot map leaves the candidate private and unlinked.
import { foldPath } from '../../case-package/paths.ts';
import type { Asset } from '../../case-package/schema.ts';
import type { FinalizedSubmissionSnapshot, ImportLinkCoverage, RequiredOriginalLink } from '../../server/runtime/hosted/alpha-contracts.ts';
import { sha256 as brandSha } from '../../server/runtime/ids.ts';
import type { CaseMismatchDiagnostic } from './ports.ts';

export type UnlinkedCode =
  | 'required-original-unmatched' | 'required-original-ambiguous' | 'required-original-fingerprint-mismatch'
  | 'conflicting-required-facts' | 'submitted-file-unmapped' | 'submitted-file-multiply-mapped'
  | 'case-mismatch-warning-missing' | 'case-mismatch-warning-unknown' | 'unexpected-case-mismatch-warning' | 'unaccounted-case-mismatch-warning';
export interface UnlinkedReason { readonly code: UnlinkedCode; readonly subject?: string }
export type CoverageResult = { ok: true; coverage: ImportLinkCoverage } | { ok: false; reasons: readonly UnlinkedReason[] };

const FINGERPRINT = /^[0-9a-f]{32}$/;
const MAX_REASONS = 50;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function buildCoverage(i: {
  assets: Readonly<Record<string, Asset>>;
  submission: FinalizedSubmissionSnapshot;
  caseMismatch: readonly CaseMismatchDiagnostic[];
  warningFingerprints: readonly string[];
}): CoverageResult {
  const reasons: UnlinkedReason[] = [];
  const reason = (code: UnlinkedCode, subject?: string) => { if (!reasons.some((r) => r.code === code && r.subject === subject)) reasons.push(subject === undefined ? { code } : { code, subject }); };

  // The distinct required file facts: ref aliases of one (path, sha256, size) share a fact and all stay recorded.
  const facts = new Map<string, { path: string; sha256: string; size: number; refs: string[] }>();
  const factsOfPath = new Map<string, Set<string>>();
  const unavailable: ImportLinkCoverage['unavailableOriginals'][number][] = [];
  for (const ref of Object.keys(i.assets).sort(cmp)) {
    const a = i.assets[ref];
    if (a.kind === 'file') {
      const key = `${a.path}\u0000${a.sha256}\u0000${a.size}`;
      const f = facts.get(key) ?? { path: a.path, sha256: a.sha256, size: a.size, refs: [] };
      f.refs.push(ref);
      facts.set(key, f);
      factsOfPath.set(a.path, (factsOfPath.get(a.path) ?? new Set()).add(key));
    } else if (a.kind === 'missing') unavailable.push({ kind: 'missing', ref, path: a.path });
    else unavailable.push({ kind: 'embedded', ref, parentRef: a.parentRef });
  }
  for (const [path, keys] of factsOfPath) if (keys.size > 1) reason('conflicting-required-facts', path);
  const ordered = [...facts.values()].sort((a, b) => cmp(a.path, b.path) || cmp(a.sha256, b.sha256));
  // Two different package paths that fold to one name cannot be told apart by the exact-name-first rule.
  const folds = new Map<string, Set<string>>();
  for (const f of ordered) folds.set(foldPath(f.path), (folds.get(foldPath(f.path)) ?? new Set()).add(f.path));
  for (const [, paths] of folds) if (paths.size > 1) for (const p of paths) reason('required-original-ambiguous', p);

  const files = i.submission.manifest.files;
  const literal = new Map<string, typeof files[number][]>(), folded = new Map<string, typeof files[number][]>();
  for (const f of files) {
    literal.set(f.path, [...(literal.get(f.path) ?? []), f]);
    folded.set(foldPath(f.path), [...(folded.get(foldPath(f.path)) ?? []), f]);
  }

  // The validator's warnings, by ref.
  const known = new Set(i.warningFingerprints);
  const warned = new Map<string, string[]>();
  for (const w of i.caseMismatch) {
    if (!FINGERPRINT.test(w.fingerprint) || !known.has(w.fingerprint)) reason('case-mismatch-warning-unknown', w.ref);
    warned.set(w.ref, [...(warned.get(w.ref) ?? []), w.fingerprint]);
  }

  const mapped: RequiredOriginalLink[] = [], used = new Map<string, number>(), mappedRefs = new Set<string>();
  for (const f of ordered) {
    let file: typeof files[number] | undefined, match: 'literal' | 'case-nfc-unique' = 'literal';
    const exact = literal.get(f.path);
    if (exact) file = exact[0];
    else {
      const hits = folded.get(foldPath(f.path)) ?? [];
      if (hits.length === 0) { reason('required-original-unmatched', f.path); continue; }
      if (hits.length > 1) { reason('required-original-ambiguous', f.path); continue; }
      file = hits[0];
      match = 'case-nfc-unique';
    }
    used.set(file.path, (used.get(file.path) ?? 0) + 1);
    if (file.sha256 !== f.sha256 || file.size !== f.size) { reason('required-original-fingerprint-mismatch', f.path); continue; }
    for (const r of f.refs) mappedRefs.add(r);
    const base = { packageRefs: [...f.refs], packagePath: f.path, storedPath: file.path, submissionAssetId: file.assetId, sha256: brandSha(f.sha256), size: f.size };
    const prints = [...new Set(f.refs.flatMap((r) => warned.get(r) ?? []))].sort(cmp);
    if (match === 'literal') {
      if (prints.length > 0) reason('unexpected-case-mismatch-warning', f.path);
      mapped.push({ ...base, pathMatch: 'literal' });
    } else {
      if (f.refs.some((r) => !warned.has(r))) reason('case-mismatch-warning-missing', f.path);
      if (prints.length > 0) mapped.push({ ...base, pathMatch: 'case-nfc-unique', preservedWarning: { code: 'ORIG_CASE_MISMATCH', fingerprints: prints as [string, ...string[]] } });
    }
  }
  for (const [path, n] of used) if (n > 1) reason('submitted-file-multiply-mapped', path);
  for (const f of files) if (!used.has(f.path)) reason('submitted-file-unmapped', f.path);
  for (const ref of warned.keys()) if (!mappedRefs.has(ref)) reason('unaccounted-case-mismatch-warning', ref);

  if (reasons.length > 0) return { ok: false, reasons: reasons.slice(0, MAX_REASONS) };
  unavailable.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.ref, b.ref));
  return { ok: true, coverage: { policy: 'exact-required-file-set/1', mappedOriginals: mapped, unavailableOriginals: unavailable } };
}
