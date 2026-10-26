// The hosted-safe projector: the canonical read model of a results package, derived from the package bytes alone. It is
// the Workers-safe counterpart of local-case/project.server.ts `project()` (which imports the Node-only case-package
// barrel and reads the case folder). It imports only pure case-package modules.
//
// What it derives is everything the package states: the chronology rows, the asset index, the seed rows, the per-document
// state, the attachment routes and the overview. The one thing it cannot derive from the bytes is what the importing side
// saw of each original, so that is an explicit input: `OriginalFacts`, read by the caller from the case's own verified D1
// association and R2 object (storage/cloud/original-facts.ts). A file asset with a fact is taken as that fact says
// (`verified` or `case-mismatch`, download-only or not); one without is `unavailable`, exactly as the local project()
// reports an original the case folder does not hold. A claimed status is never an input: see docs/hosted-foundation/storage.md.
import { Candidate } from '../../case-package/candidate.ts';
import { canonicalJson } from '../../case-package/canonical.ts';
import { DiagSink } from '../../case-package/diagnostics.ts';
import { withLimits } from '../../case-package/limits.ts';
import { readCandidate } from '../../case-package/reader.ts';
import { isPathKey } from '../../case-package/refs.ts';
import { validateSnapshot } from '../../case-package/validate.ts';
import type { StagedAsset, StagedDocument, StagedProjection, StagedSeed } from './read-model.ts';

type Mapping = ConstructorParameters<typeof Candidate>[0]['originals'] extends Map<string, infer M> ? M : never;
export type PackageProjection = { ok: true; projection: StagedProjection; counts: Readonly<Record<string, number>> } | { ok: false; problems: string[] };
/** A file asset as the package's asset index states it: the fingerprint an original must have. */
export interface FileAssetClaim { key: string; path: string; sha256: string; size: number; mediaType: string }
/** One verified original (local-case's `OriginalMapping`): the real name, the fingerprint it matched, and what its bytes sniff as. */
export interface OriginalFact { path: string; sha256: string; size: number; mediaType: string; status: 'verified' | 'case-mismatch'; downloadOnly: boolean }
/** Verified originals by asset key. A file asset with no entry is unavailable. */
export type OriginalFacts = ReadonlyMap<string, OriginalFact>;
export type PreparedPackage = { ok: true; fileAssets: readonly FileAssetClaim[]; project(facts: OriginalFacts): PackageProjection } | { ok: false; problems: string[] };

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const optStr = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const heads = (xs: unknown) => (Array.isArray(xs) ? xs.map((x) => ({ h: str((x as { h?: unknown }).h), t: str((x as { t?: unknown }).t) })) : []);

/** Validates `files` (already verified against their identity by the caller) once; `project(facts)` then projects them. Never touches a disk. */
export function preparePackage(files: ReadonlyMap<string, Uint8Array>): PreparedPackage {
  const L = withLimits(undefined);
  const sink = new DiagSink(L.diagnosticsPerCode);
  const own = new Map([...files].map(([path, bytes]) => [path, new Uint8Array(bytes)] as const));
  const pkg = validateSnapshot({ files: own, present: new Map([...own].map(([path, bytes]) => [path, bytes.byteLength] as const)), transport: 'memory' }, sink, L);
  if (!pkg || sink.errors > 0) return { ok: false, problems: sink.finish(new Set()).filter((d) => d.severity === 'error').slice(0, 20).map((d) => `${d.code}: ${d.message}`) };
  const fileAssets: FileAssetClaim[] = [];
  for (const [key, a] of Object.entries(pkg.assets)) if (a.kind === 'file') fileAssets.push({ key, path: a.path, sha256: a.sha256, size: a.size, mediaType: a.mediaType });
  const counts = Object.fromEntries([...sink.counts].sort(([a], [b]) => (a < b ? -1 : 1)));
  return { ok: true, fileAssets, project: (facts) => projectWith(pkg, facts, counts) };
}

/** Prepares and projects in one step, for a caller that already holds its facts. */
export function projectPackage(files: ReadonlyMap<string, Uint8Array>, facts: OriginalFacts): PackageProjection {
  const prepared = preparePackage(files);
  return prepared.ok ? prepared.project(facts) : prepared;
}

function projectWith(pkg: NonNullable<ReturnType<typeof validateSnapshot>>, facts: OriginalFacts, counts: Readonly<Record<string, number>>): PackageProjection {
  const originals = new Map<string, Mapping>();
  const unavailable = new Set<string>();
  for (const [key, a] of Object.entries(pkg.assets)) {
    const fact = facts.get(key);
    if (a.kind === 'file' && fact) originals.set(key, { ref: key, path: fact.path, sha256: fact.sha256, size: fact.size, mediaType: fact.mediaType, status: fact.status, downloadOnly: fact.downloadOnly } as Mapping);
    else if (a.kind === 'file' || a.kind === 'missing') unavailable.add(key);
  }
  const candidate = new Candidate({ ...pkg, originals, unavailable });

  const r = readCandidate(candidate);
  const documents: StagedDocument[] = [];
  const list: Record<string, unknown>[] = [];
  (r.chronology as readonly unknown[]).forEach((value, ord) => {
    const raw = value as Record<string, unknown>;
    const ref = str(raw.ref);
    const s = r.documentState(ref);
    const selfRoute = () => {
      const route = r.resolveAttachment(ref);
      return route ? { route: route.route, parentRef: route.parentRef, reason: route.route === 'unavailable' ? route.reason : null, via: route.route === 'unavailable' ? null : route.original.ref } : null;
    };
    const state = s
      ? { file: s.file, preview: s.preview, text: s.text, mediaType: s.mediaType, flags: [...s.flags],
          original: s.original ? { path: s.original.path, sha256: s.original.sha256, size: s.original.size, mediaType: s.original.mediaType, status: s.original.status, downloadOnly: s.original.downloadOnly } : null,
          self: selfRoute() }
      : { file: 'blocked', preview: 'none', text: 'unknown', mediaType: null, flags: ['not-indexed'], original: null, self: null };
    const attachments = r.attachmentsOf(ref).map((a) => {
      const route = r.resolveAttachment(a.key);
      return { key: a.key, member: a.member, ordinal: a.ordinal, mediaType: a.mediaType, kind: a.kind, route: route === null ? 'unavailable' : route.route, reason: route?.route === 'unavailable' ? route.reason : null, via: route && route.route !== 'unavailable' ? route.original.ref : null };
    });
    documents.push({ ref, ord, row_json: canonicalJson(raw), state_json: JSON.stringify(state), attachments_json: JSON.stringify(attachments) });
    list.push({
      ref, ord, date: str(raw.date), dateType: optStr(raw.date_type), dateSource: optStr(raw.date_source),
      docType: str(raw.doc_type), bundle: str(raw.bundle), subject: str(raw.subject), filename: str(raw.filename),
      sender: str(raw.sender), to: str(raw.to), excerpt: str(raw.excerpt), amount: str(raw.amount),
      alsoIn: Array.isArray(raw.also_in) ? raw.also_in.map(str) : [], url: str(raw.url), textStatus: str(raw.text_status),
      parentRef: optStr(raw.pr) ?? candidate.assets[ref]?.parentRef ?? null,
      file: state.file, preview: state.preview, attachments: attachments.length,
    });
  });
  documents.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));

  const assets: StagedAsset[] = Object.keys(candidate.assets).sort().map((key) => {
    const a = candidate.assets[key]!;
    const o = candidate.original(key);
    const status = o ? o.status : a.kind === 'embedded' ? 'embedded' : a.kind === 'missing' ? 'missing' : 'unavailable';
    return {
      key, kind: a.kind, indexed_path: a.kind === 'embedded' ? null : a.path, parent_ref: a.parentRef ?? null,
      member: a.kind === 'embedded' ? a.member : null, ordinal: a.kind === 'embedded' ? a.ordinal : null,
      media_type: a.mediaType, text_status: a.textStatus, real_path: o?.path ?? null, sha256: o?.sha256 ?? null, size: o?.size ?? null,
      status, download_only: o?.downloadOnly ? 1 : 0,
    };
  });
  const seeds: StagedSeed[] = r.seeds().map((s, ord) => ({ ord, dataset_key: s.datasetKey, seed_id: s.seedId, seed_sha256: s.seedSha256, record_json: canonicalJson(s.record) }));

  const dated = list.map((x) => x.date as string).filter((d) => d !== '').sort();
  const matter = r.dataset<{ title?: unknown; short?: unknown; forum?: unknown; storyline?: unknown; strategy?: unknown }>('matter');
  const meta = r.sourceMeta as Record<string, unknown> | null;
  const quantum = r.dataset<Record<string, unknown>>('quantum');
  const contra = r.dataset<Record<string, unknown>>('contradictions');
  const docAssets = assets.filter((a) => !isPathKey(a.key));
  const tally = (s: string) => docAssets.filter((a) => a.status === s).length;
  const overview = {
    caseId: candidate.caseId, caseLabel: candidate.manifest.case.label ?? null, resultsVersion: candidate.resultsVersion, inputRevisionId: candidate.inputRevisionId,
    inputKind: candidate.manifest.inputRevision.kind, created: candidate.manifest.created, producer: `${candidate.manifest.producer.name} ${candidate.manifest.producer.version}`,
    counts: r.derivedCounts(),
    dates: { min: dated[0] ?? null, max: dated.at(-1) ?? null, undated: list.length - dated.length },
    originals: { verified: tally('verified'), caseMismatch: tally('case-mismatch'), missing: tally('missing') + tally('unavailable'), embedded: tally('embedded'), downloadOnly: docAssets.filter((a) => a.download_only).length },
    sourceClaims: meta ? Object.fromEntries(Object.entries(meta).filter(([, v]) => typeof v === 'number' || typeof v === 'string').sort(([a], [b]) => (a < b ? -1 : 1))) : {},
    diagnostics: { ...counts },
    quantum: quantum ? { headlineDue: str(quantum.headline_due), headlineRef: str(quantum.headline_ref), headlineDate: str(quantum.headline_date), invoiceCount: typeof quantum.invoiceCount === 'number' ? quantum.invoiceCount : null } : null,
    contradictions: contra && typeof contra.total === 'number' && typeof contra.highCount === 'number' ? { total: contra.total, highCount: contra.highCount } : null,
    matter: matter ? { title: str(matter.title), short: str(matter.short), forum: str(matter.forum), storyline: heads(matter.storyline), strategy: heads(matter.strategy) } : null,
  };
  return {
    ok: true, counts,
    projection: { documents, assets, seeds, chronologyJson: JSON.stringify(list), overview: JSON.stringify(overview), expect: { documents: documents.length, assets: assets.length, seeds: seeds.length, files: candidate.paths().length } },
  };
}
