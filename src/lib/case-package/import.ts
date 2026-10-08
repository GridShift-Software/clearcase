// importCandidate: package source + case folder -> immutable ImportResult.
// The case folder is required and opened read-only; nothing is written anywhere. A rejected,
// cancelled or timed-out import returns diagnostics only, never a candidate.
import { Candidate, VALIDATOR_VERSION, type ImportResult } from './candidate.ts';
import { DiagSink, diagnosticsDigest } from './diagnostics.ts';
import { withLimits, type Limits } from './limits.ts';
import { Interrupted, openCaseFolder, verifyOriginals, type OriginalMapping, type Progress } from './originals.ts';
import type { Asset } from './schema.ts';
import { snapshotSource, type PackageSource } from './source.ts';
import { validateSnapshot, type ValidatedPackage } from './validate.ts';

export interface ImportOptions {
  limits?: Partial<Limits>;
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
  /** fingerprints annotated as known in the diagnostics (canActivate decides independently) */
  trustedBaseline?: Iterable<string>;
  /** parallel hashing of originals (default 4) */
  concurrency?: number;
}

const sorted = (s: Iterable<string>): string[] => [...s].sort();

export async function importCandidate(source: PackageSource, caseFolder: string, options: ImportOptions = {}): Promise<ImportResult> {
  const L = withLimits(options.limits);
  const sink = new DiagSink(L.diagnosticsPerCode);
  const deadline = Date.now() + L.validationDeadlineMs;
  const check = () => {
    if (options.signal?.aborted) throw new Interrupted('IMPORT_ABORTED');
    if (Date.now() > deadline) throw new Interrupted('IMPORT_DEADLINE');
  };
  let pkg: ValidatedPackage | null = null;
  let mapping = new Map<string, OriginalMapping>();
  let unavailable = new Set<string>();
  try {
    check();
    options.onProgress?.({ phase: 'snapshot', done: 0, total: 0, bytesDone: 0, bytesTotal: 0 });
    const snap = await snapshotSource(source, L, sink).catch((e: NodeJS.ErrnoException) => {
      sink.add('PKG_SOURCE_INVALID', `the package source cannot be read (${e.code ?? 'error'})`);
      return null;
    });
    check();
    if (snap) {
      options.onProgress?.({ phase: 'validate', done: 0, total: snap.files.size, bytesDone: 0, bytesTotal: 0 });
      pkg = validateSnapshot(snap, sink, L, check);
      check();
    }
    if (pkg && sink.errors === 0) {
      const root = await openCaseFolder(caseFolder, sink);
      if (root) {
        ({ mapping, unavailable } = await verifyOriginals(root, pkg.assets, sink, { limits: L, signal: options.signal, deadline, concurrency: options.concurrency ?? 4, onProgress: options.onProgress }));
        flagCitedUnavailable(pkg, unavailable, sink);
      }
    }
    check();
  } catch (e) {
    if (!(e instanceof Interrupted)) {
      // never let crafted input escape as an exception: reject with a diagnostic instead
      pkg = null;
      sink.add('PKG_UNPROCESSABLE', `unexpected failure: ${String((e as Error)?.message ?? 'error').slice(0, 200)}`);
    } else sink.add(e.code, e.code === 'IMPORT_DEADLINE' ? `validation did not finish within ${L.validationDeadlineMs} ms; nothing was stored` : 'the import was cancelled; nothing was stored');
  }
  const diagnostics = sink.finish(new Set(options.trustedBaseline ?? []));
  const counts = Object.fromEntries([...sink.counts].sort(([a], [b]) => (a < b ? -1 : 1)));
  const warningFingerprints = sorted(sink.warningFingerprints);
  const base = {
    diagnostics,
    diagnosticsSha256: diagnosticsDigest(VALIDATOR_VERSION, diagnostics, counts, warningFingerprints),
    validatorVersion: VALIDATOR_VERSION,
    counts,
    warningFingerprints,
    errorFingerprints: sorted(sink.errorFingerprints),
  };
  if (!pkg || sink.errors > 0) return freeze({ ...base, verdict: 'reject', candidate: null });
  const candidate = new Candidate({ ...pkg, originals: mapping, unavailable });
  return freeze({ ...base, verdict: sink.count('warning') > 0 ? 'report' : 'accept', candidate });
}

/** A cited document whose root original is unavailable stays visibly flagged. */
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

/** The result is immutable: its arrays, counts and diagnostics are frozen (the candidate freezes itself). */
function freeze<T extends ImportResult>(r: T): T {
  for (const d of r.diagnostics) Object.freeze(d);
  Object.freeze(r.diagnostics);
  Object.freeze(r.counts);
  Object.freeze(r.warningFingerprints);
  Object.freeze(r.errorFingerprints);
  return Object.freeze(r);
}
