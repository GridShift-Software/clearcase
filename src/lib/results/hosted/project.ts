// The hosted-safe projector: the canonical read model of a results package, derived from the package bytes alone. It is
// the Workers-safe counterpart of local-case/project.server.ts `project()` (which imports the Node-only case-package
// barrel and reads the case folder). It imports only pure case-package modules.
//
// What it derives is everything the package states: the chronology rows, the asset index, the seed rows, the per-document
// state, the attachment routes and the overview. The one fact it cannot derive is what the importing machine saw on disk.
// Every file asset is taken at its indexed path, size, SHA-256 and media type, status `verified`, not download-only: the
// bytes themselves are checked later, on every delivery, against the original the client uploaded. A projection that
// records a case-mismatched original or a download-only one (facts only a case folder can show) therefore differs from
// this one and is refused (`inconsistent-projection`); see docs/hosted-foundation/storage.md.
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

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const optStr = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const heads = (xs: unknown) => (Array.isArray(xs) ? xs.map((x) => ({ h: str((x as { h?: unknown }).h), t: str((x as { t?: unknown }).t) })) : []);

/** Validates `files` (already verified against their identity by the caller) and projects them. Never touches a disk. */
export function projectPackage(files: ReadonlyMap<string, Uint8Array>): PackageProjection {
  const L = withLimits(undefined);
  const sink = new DiagSink(L.diagnosticsPerCode);
  const own = new Map([...files].map(([path, bytes]) => [path, new Uint8Array(bytes)] as const));
  const pkg = validateSnapshot({ files: own, present: new Map([...own].map(([path, bytes]) => [path, bytes.byteLength] as const)), transport: 'memory' }, sink, L);
  if (!pkg || sink.errors > 0) return { ok: false, problems: sink.finish(new Set()).filter((d) => d.severity === 'error').slice(0, 20).map((d) => `${d.code}: ${d.message}`) };
  const originals = new Map<string, Mapping>();
  const unavailable = new Set<string>();
  for (const [key, a] of Object.entries(pkg.assets)) {
    if (a.kind === 'file') originals.set(key, { ref: key, path: a.path, sha256: a.sha256, size: a.size, mediaType: a.mediaType, status: 'verified', downloadOnly: false } as Mapping);
    else if (a.kind === 'missing') unavailable.add(key);
  }
  const candidate = new Candidate({ ...pkg, originals, unavailable });
  const counts = Object.fromEntries([...sink.counts].sort(([a], [b]) => (a < b ? -1 : 1)));

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
