// The publication evidence gate for a snapshot v2 candidate (real-export design 2 and 3; U14). One operator request runs one bounded
// build: it verifies the candidate's material again, plans every evidence item from it, and drives U3's engine until the request's wall
// budget is spent or the run is sealed. Nothing here decides sign-off; the items are facts, and `rules.ts` reads them.
//
// What a step verifies, every time, before any item is written. The candidate's link is current and not superseded; the stored version
// is this candidate's; the package files hash to their rows; the stored read model loads under its digest; validation of the package
// under the model's own original claims gives exactly the stored verdict, validator, diagnostics and warnings; the finalized submission
// and that validation give exactly the link's coverage; and the projection equals the stored model. Original bytes are not read here:
// the `original/` items hash every distinct original once per generation (U8).
//
// The plan, in key order (`<kind>/<subject>`, so each kind is one range):
//   error/<fp>        every error fingerprint of the validation (a stored version has none, so normally no item).
//   original/<asset>  one per distinct original the link maps (U8): the asset, its sha256, size and R2 etag as the read found them.
//   preview/<ref>     one per package asset, by U10's policy: held with its reason, or the render outcome of the bytes the viewer shows.
//   section/<key>     each required section: chronology through its native view, META by its own derivation (U12), source-layout by its
//                     contract, every other registered dataset as its records view (U6/U7), and `supplied-references` when citations fail.
//   warning/<fp>      every validator warning, each META disagreement (U12) and each uncited missing original (U10).
// PDF previews come from U9's checker. A step commits only the items before the first preview the checker has not settled, so a step
// never seals a guess; the next step finds the settled documents in their content receipts and renders the next window.
import type { CaseId, ClientId } from '../contracts.ts';
import { contractError } from '../errors.ts';
import { canonicalJson } from '../../../case-package/canonical.ts';
import type { Candidate } from '../../../case-package/candidate.ts';
import { validateHostedPackage } from '../../../case-package/hosted-validation.ts';
import type { Limits } from '../../../case-package/limits.ts';
import { KNOWN_SCHEMAS, REQUIRED_DATASETS } from '../../../case-package/registry.ts';
import { carriesMeta, metaEvidenceItems } from '../../../case-package/meta-integrity.ts';
import { parseStrictJson } from '../../../case-package/strict-json.ts';
import type { PublicationD1Database } from '../../../publication/hosted/d1-publisher.ts';
import { createEvidenceEngine, d1EvidenceStore, type EvidenceBinding, type EvidenceBounds, type EvidenceProducer, type EvidenceRefusal } from '../../../publication/hosted/evidence/index.ts';
import { decodeCursor } from '../../../publication/hosted/evidence/cursor.ts';
import { assetPolicyItems, decideAsset, type AssetPolicyInput, type RenderOutcome } from '../../../publication/hosted/asset-policy.ts';
import { createOriginalsProducer, originalRefs, type OriginalRef } from '../../../publication/hosted/originals-evidence.ts';
import { safePreviewNavigation, safePreviewReason } from '../../../publication/hosted/preview-outcome.ts';
import { d1NativeCandidateRepository } from '../../../results-review/native/repository.ts';
import { inspectPackage } from '../../../results-review/native/package.ts';
import { buildCoverage } from '../../../results-review/native/coverage.ts';
import { submissionSnapshotReader } from '../../../results-review/native/submission-reader.ts';
import { preparePackage, type OriginalFact } from '../../../results/hosted/project.ts';
import { loadVerifiedModel, type LoadedModel } from '../../../results/hosted/model.ts';
import { projectionDifferences, type StagedProjection } from '../../../results/hosted/read-model.ts';
import { resolveOriginalAttributions } from '../../../results/hosted/original-attribution.ts';
import type { CloudR2 } from '../../../storage/cloud/bindings.ts';
import type { StorageBudgets } from '../../../storage/cloud/budgets.ts';
import { caseFolder, originalClaims, type FolderOriginal } from '../../../storage/cloud/original-facts.ts';
import { originalKey, packageKey } from '../../../storage/cloud/keys.ts';
import { verifiedRead } from '../../../storage/cloud/objects.ts';
import { admitVerification } from '../../../storage/cloud/verification.ts';
import type { NativePdfEvidenceChecker, PdfEvidenceOutcome } from '../../../viewer/hosted/render-check-contract.ts';
import { recordsContext, recordsOriginals, recordsSectionState, renderRecords, verifyDatasetBytes } from '../../../views/hosted/records/index.ts';
import type { CandidateImportLink, RequiredOriginalLink } from './alpha-contracts.ts';
import { referencePages } from './publication-material.ts';
import { metaSectionOf, renderRequiredSections } from './required-section-render.ts';

const integrity = (): never => { throw contractError('integrity'); };
const unavailable = (): never => { throw contractError('storage-unavailable', true); };
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const count = (n: number, max: number) => Number.isSafeInteger(n) && n >= 0 && n <= max;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const GENERATION = /^[1-9][0-9]{0,8}$/;

type Primary = ReturnType<PublicationD1Database['withSession']>;
type StoredVersion = { verdict: string; validator_version: string; diagnostics_sha256: string; warning_fingerprints: string; manifest_sha256: string; input_revision_id: string; overview: string; package_bytes: number; expected_files: number };

/** The candidate's material as one step verified it. Everything the plan and the records check read comes from here. */
export interface GateMaterial {
  readonly caseId: CaseId;
  readonly candidateId: string;
  readonly link: CandidateImportLink;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly candidate: Candidate;
  readonly validation: Readonly<{ verdict: 'accept' | 'report'; validatorVersion: string; diagnosticsSha256: string; warningFingerprints: readonly string[]; errorFingerprints: readonly string[]; counts: Readonly<Record<string, number>> }>;
  readonly cited: ReadonlySet<string>;
  readonly facts: ReadonlyMap<string, OriginalFact>;
  readonly projection: StagedProjection;
  readonly model: LoadedModel;
  readonly folder: readonly FolderOriginal[];
  readonly caseOriginals: readonly string[];
  readonly mapped: readonly RequiredOriginalLink[];
}

/**
 * The sizes one hosted request uses, for Workers Paid (U1 measured validation at about 0.5 s and readiness at about 0.9 s of CPU for the poc
 * package, against 30 s). A build request drives steps for at most 15 s after its first; a step writes at most 250 items and 512 KiB; the
 * originals step reads 8 at a time and holds at most 16 MiB of them (U8). Publish HEADs each distinct original four at a time and refuses a
 * run of more than 2,000 distinct originals rather than skip any: about 1,689 for a v5-sized case, inside Paid's 10,000 subrequests (U8).
 */
export const EVIDENCE_REQUEST = Object.freeze({
  build: Object.freeze({ bounds: Object.freeze({ itemsPerStep: 250, bytesPerStep: 512 * 1024 }), originals: Object.freeze({ batch: 8, windowBytes: 16 * 1024 * 1024 }), wallMs: 15_000 }),
  comparison: Object.freeze({ batch: 4, limit: 2_000 }),
});

export interface EvidenceGateOptions {
  /** The client's raw D1 (the one import, the ledger and the publisher use), through `first-primary` sessions only. */
  readonly db: PublicationD1Database;
  readonly bucket: CloudR2;
  readonly clientId: ClientId;
  readonly storageBudgets: StorageBudgets;
  /** The importer's complete validation limits (`hostedValidationPolicy`). */
  readonly validationLimits: Limits;
  /** U9's scaled PDF evidence checker. Null holds every build that has a PDF to check: it answers `renderer-unavailable`. */
  readonly pdf: NativePdfEvidenceChecker | null;
  readonly bounds: EvidenceBounds;
  /** Originals read together, and the bytes held at once, by the `original/` step (U8). */
  readonly originals: { readonly batch: number; readonly windowBytes: number };
  /** Wall time one request may spend driving steps after its first. A step that has begun always finishes. */
  readonly wallMs: number;
  readonly now: () => Date;
}

/**
 * The candidate's material, verified for one step. Throws `integrity` when anything stored disagrees and `storage-unavailable` when it
 * cannot be read or the case's verification window is spent. The package files are admitted against that window, as the v1 reader does.
 */
export async function verifiedMaterial(o: Pick<EvidenceGateOptions, 'db' | 'bucket' | 'clientId' | 'storageBudgets' | 'validationLimits' | 'now'>, scope: { caseId: CaseId; candidateId: string }): Promise<GateMaterial> {
  const b = o.storageBudgets, limits = o.validationLimits, primary = o.db.withSession('first-primary') as Primary;
  const linked = await d1NativeCandidateRepository(primary).candidate({ clientId: o.clientId, ...scope });
  if (!linked || !linked.current || linked.supersededBy !== null) return integrity();
  const link = linked.link, pin = link.candidate, rv = pin.resultsVersion;
  if (link.clientId !== o.clientId || link.caseId !== scope.caseId || pin.clientId !== o.clientId || pin.caseId !== scope.caseId || pin.candidateId !== scope.candidateId
    || linked.candidateId !== scope.candidateId || link.coverage?.policy !== 'exact-required-file-set/1' || !Array.isArray(link.coverage.mappedOriginals)) return integrity();
  const version = await primary.prepare("SELECT verdict, validator_version, diagnostics_sha256, warning_fingerprints, manifest_sha256, input_revision_id, overview, package_bytes, expected_files FROM rs_results_version WHERE version_id = ? AND case_id = ? AND state = 'stored'")
    .bind(rv, scope.caseId).first<StoredVersion>();
  if (!version || version.manifest_sha256 !== pin.manifestSha256 || version.input_revision_id !== pin.packageInputRevisionId) return integrity();
  if (!count(version.expected_files, b.maxPackageFiles) || !count(version.package_bytes, b.maxPackageBytes)) return unavailable();
  const rows = await primary.prepare('SELECT path, sha256, size, object_key FROM rs_package_file WHERE version_id = ? ORDER BY path LIMIT ?')
    .bind(rv, b.maxPackageFiles + 1).all<{ path: string; sha256: string; size: number; object_key: string }>();
  if (rows.results.length !== version.expected_files) return integrity();
  let total = 0;
  for (const f of rows.results) {
    if (!count(f.size, b.maxPackageFileBytes) || f.object_key !== packageKey(rv, f.sha256)) return integrity();
    total += f.size;
  }
  if (total !== version.package_bytes) return integrity();
  if (await admitVerification({ db: primary, budgets: b }, scope.caseId, { objects: rows.results.length, bytes: total }, o.now().getTime()) !== 'admitted') return unavailable();
  const files = new Map<string, Uint8Array>();
  for (const f of rows.results) {
    const r = await verifiedRead(o.bucket, f.object_key, f, b.maxPackageFileBytes);
    if (r.kind === 'missing' || r.kind === 'changed') return integrity();
    if (r.kind !== 'ok') return unavailable();
    files.set(f.path, r.bytes);
  }
  const inspected = inspectPackage(files, scope.caseId);
  if (!inspected.ok || inspected.value.resultsVersion !== rv || inspected.value.manifestSha256 !== pin.manifestSha256 || inspected.value.inputRevisionId !== pin.packageInputRevisionId) return integrity();
  const prepared = preparePackage(files);
  if (!prepared.ok) return integrity();
  // The stored model's own claims about each original, under its digest. They were checked against the bytes at import; the bytes
  // themselves are hashed again by the `original/` items, so a step reads none of them.
  const model = await loadVerifiedModel(primary, rv);
  const claims = originalClaims(model.assets);
  if (!claims) return integrity();
  const indexed = new Map(prepared.fileAssets.map((a) => [a.key, a]));
  const facts = new Map<string, OriginalFact>();
  for (const c of claims) {
    const a = indexed.get(c.key);
    if (!a || a.sha256 !== c.sha256 || a.size !== c.size || facts.has(c.key)) return integrity();
    facts.set(c.key, { path: c.realPath, sha256: c.sha256, size: c.size, mediaType: a.mediaType, status: c.status, downloadOnly: c.downloadOnly });
  }
  const validated = validateHostedPackage({ files, originals: facts, limits });
  const result = validated.result;
  if (result.verdict === 'reject' || result.errorFingerprints.length || !result.candidate) return integrity();
  if (result.verdict !== version.verdict || result.validatorVersion !== version.validator_version || result.diagnosticsSha256 !== version.diagnostics_sha256
    || !same(result.warningFingerprints, [...(parseStrictJson(version.warning_fingerprints) as string[])].sort())) return integrity();
  // The link's coverage, rebuilt from the verified package and the finalized submission: never from what any run holds (U8 contract).
  const submission = await submissionSnapshotReader(primary).finalized({ clientId: o.clientId, caseId: scope.caseId, revisionId: link.submissionRevisionId });
  if (submission.state !== 'finalized' || submission.storedManifestSha256 !== link.submissionManifestSha256) return integrity();
  const coverage = buildCoverage({ assets: inspected.value.assets, submission, caseMismatch: validated.caseMismatch, warningFingerprints: result.warningFingerprints });
  if (!coverage.ok || !same(coverage.coverage, link.coverage)) return integrity();
  const projected = prepared.project(facts);
  if (!projected.ok) return integrity();
  if (projectionDifferences({ documents: model.docs, assets: model.assets, seeds: model.seeds,
    chronologyJson: JSON.stringify(model.docs.map((d) => JSON.parse(d.list_json))), overview: version.overview, expect: projected.projection.expect }, projected.projection).length) return integrity();
  const folder = await caseFolder(primary, o.clientId, scope.caseId);
  const own = await primary.prepare('SELECT asset_id FROM rs_case_original WHERE case_id = ? ORDER BY asset_id').bind(scope.caseId).all<{ asset_id: string }>();
  return Object.freeze({
    caseId: scope.caseId, candidateId: scope.candidateId, link, files, candidate: result.candidate, cited: validated.cited, facts, model, folder,
    caseOriginals: own.results.map((r) => r.asset_id), mapped: link.coverage.mappedOriginals, projection: projected.projection,
    validation: { verdict: result.verdict, validatorVersion: result.validatorVersion, diagnosticsSha256: result.diagnosticsSha256,
      warningFingerprints: result.warningFingerprints, errorFingerprints: result.errorFingerprints, counts: result.counts },
  }) as GateMaterial;
}

/** The originals the link maps, one per distinct submission asset, as U8's refs; checked against the case folder they are read from. */
export function mappedOriginalRefs(m: Pick<GateMaterial, 'mapped' | 'folder'>): OriginalRef[] {
  const byAsset = new Map<string, OriginalRef>();
  for (const x of m.mapped) {
    const known = byAsset.get(x.submissionAssetId);
    if (known && (known.sha256 !== x.sha256 || known.size !== x.size)) return integrity();
    byAsset.set(x.submissionAssetId, { assetId: x.submissionAssetId, sha256: x.sha256, size: x.size });
  }
  const refs = [...byAsset.values()].sort((a, b) => cmp(a.assetId, b.assetId));
  // The same refs through U8's own reader of the folder: each finalized, under its content key, with the recorded size.
  const folder = originalRefs(m.folder.filter((f) => byAsset.has(f.assetId)), refs);
  if (!same(folder, refs)) return integrity();
  return refs;
}

/** The records page the client route serves for one dataset, and its section state. The route builds the same context (`recordsOriginals`). */
export function gateRecords(m: Pick<GateMaterial, 'caseId' | 'candidate' | 'files' | 'model' | 'folder' | 'caseOriginals'>, key: string): { html: string; state: 'records-rendered' | 'invalid' } {
  const entries = m.candidate.manifest.files.filter((f) => f.role === 'dataset' && f.key === key);
  const bytes = entries.length === 1 ? m.files.get(entries[0]!.path) : undefined;
  if (!bytes) return { html: '', state: 'invalid' };
  const context = recordsContext(m.caseId, recordsOriginals(resolveOriginalAttributions(m.model, m.folder), m.caseOriginals));
  try {
    const dataset = verifyDatasetBytes(entries[0]!, bytes), rendered = renderRecords(dataset, context);
    return { html: rendered.html, state: recordsSectionState(dataset, rendered, context) };
  } catch { return { html: '', state: 'invalid' }; }
}

/** Every required section of a v2 candidate, in key order, as `section/` observations. */
export async function gateSections(m: GateMaterial): Promise<{ key: string; observation: Record<string, unknown> }[]> {
  const c = m.candidate, out = new Map<string, Record<string, unknown>>();
  const v1 = await renderRequiredSections({ candidate: c, projection: m.projection, counts: m.validation.counts,
    originals: new Map(m.mapped.flatMap((x) => x.packageRefs.map((ref) => [ref, x.submissionAssetId] as const))) });
  for (const s of v1) {
    // A registered dataset with no native view is shown as its complete records view (ADR-0013), never called `valid`.
    const env = c.dataset(s.key);
    const state = s.state === 'unsupported' && env && KNOWN_SCHEMAS.has(env.schema) ? gateRecords(m, s.key).state : s.state;
    out.set(s.key, { kind: 'section', key: s.key, state });
  }
  // META by its own derivation (U12): the gate's items are the only META evidence the rules ever read.
  const meta = metaSectionOf({ candidate: c, validation: m.validation, counts: m.validation.counts });
  if (meta) for (const item of metaEvidenceItems(meta)) if (item.observation.kind === 'section') out.set('meta', item.observation);
  const pages = referencePages(c);
  if (['CITE_UNRESOLVED', 'CITE_TARGET_NO_ORIGINAL', 'CITE_TOKEN_INVALID', 'ASSET_NOT_INDEXED'].some((code) => (m.validation.counts[code] ?? 0) > 0)
    || [...pages.keys()].some((ref) => !c.assets[ref])) out.set('supplied-references', { kind: 'section', key: 'supplied-references', state: 'invalid' });
  return [...out].sort(([a], [b]) => cmp(a, b)).map(([key, observation]) => ({ key: `section/${key}`, observation }));
}

/** One PDF the checker must settle before its preview item is written: the bytes the viewer would show and the pages cited in them. */
interface PdfDocument { readonly assetId: string; readonly sha256: string; readonly size: number; readonly citedPages: readonly number[]; read(): Promise<Uint8Array> }
type Entry =
  | { readonly key: string; readonly kind: 'fixed'; readonly observation: Record<string, unknown> }
  | { readonly key: string; readonly kind: 'original' }
  | { readonly key: string; readonly kind: 'pdf'; readonly input: AssetPolicyInput; readonly document: PdfDocument }
  | { readonly key: string; readonly kind: 'section' };

/** What a v2 candidate's evidence will hold, in key order, with the PDFs that still need U9's checker. Sections are listed by key only. */
export async function evidencePlan(m: GateMaterial, o: Pick<EvidenceGateOptions, 'bucket' | 'storageBudgets'>): Promise<{ entries: Entry[]; refs: OriginalRef[]; sections: () => Promise<Map<string, Record<string, unknown>>> }> {
  const c = m.candidate, refs = mappedOriginalRefs(m), pages = referencePages(c), binding = { resultsVersion: c.resultsVersion, manifestSha256: c.manifestSha256,
    validatorVersion: m.validation.validatorVersion, diagnosticsSha256: m.validation.diagnosticsSha256 };
  const entries: Entry[] = m.validation.errorFingerprints.map((fp) => ({ key: `error/${fp}`, kind: 'fixed', observation: { kind: 'error', fingerprint: fp } }));
  for (const r of refs) entries.push({ key: `original/${r.assetId}`, kind: 'original' });
  const inputs: AssetPolicyInput[] = Object.entries(c.assets).sort(([a], [b]) => cmp(a, b)).map(([ref, asset]) => ({
    assetId: ref, kind: asset.kind, mediaType: asset.kind === 'file' ? asset.mediaType : '', cited: m.cited.has(ref),
    supplied: asset.kind === 'file' && m.facts.has(ref), preview: asset.kind === 'file' && !!asset.preview, render: null,
  }));
  const pdfs = new Map<string, PdfDocument>();
  for (const input of inputs) {
    const asset = c.assets[input.assetId]!;
    if (asset.kind !== 'file' || decideAsset(input).policy !== 'viewable') continue;
    // The bytes the viewer shows: a PDF original as it is, otherwise the declared PDF preview of it (U11). An image is shown as it is and
    // has no checker yet, so its preview item stays `pending` and holds sign-off.
    const cited = [...(pages.get(input.assetId) ?? [])];
    if (asset.mediaType === 'application/pdf') {
      pdfs.set(input.assetId, { assetId: input.assetId, sha256: asset.sha256, size: asset.size, citedPages: cited,
        read: () => readObject(o, originalKey(asset.sha256), asset.sha256, asset.size) });
    } else if (asset.preview) {
      const p = asset.preview, bytes = m.files.get(p.path);
      if (!bytes) return integrity();
      pdfs.set(input.assetId, { assetId: input.assetId, sha256: p.sha256, size: p.size, citedPages: [], read: async () => bytes });
    }
  }
  const policy = assetPolicyItems(inputs, { binding, warningFingerprints: m.validation.warningFingerprints });
  const warnings = new Map<string, Record<string, unknown>>(m.validation.warningFingerprints.map((fp) => [`warning/${fp}`, { kind: 'warning', fingerprint: fp }]));
  for (const item of policy) {
    if (item.key.startsWith('warning/')) { if (warnings.has(item.key)) return integrity(); warnings.set(item.key, item.observation); continue; }
    const input = inputs.find((x) => x.assetId === item.observation.assetId)!, document = pdfs.get(input.assetId);
    entries.push(document && item.observation.state === 'pending' ? { key: item.key, kind: 'pdf', input, document } : { key: item.key, kind: 'fixed', observation: item.observation });
  }
  const meta = metaSectionOf({ candidate: c, validation: m.validation, counts: m.validation.counts });
  if (meta) for (const item of metaEvidenceItems(meta)) if (item.key.startsWith('warning/')) { if (warnings.has(item.key)) return integrity(); warnings.set(item.key, item.observation); }
  // Section keys are needed before their states, so a step can tell how far it may go without rendering any view. The views render
  // once per request, on the first section asked for, and must give exactly these keys.
  const keys = sectionKeys(m);
  let sections: Promise<Map<string, Record<string, unknown>>> | null = null;
  const sectionsOf = () => sections ??= gateSections(m).then((s) => {
    if (!same(s.map((x) => x.key), keys.map((k) => `section/${k}`))) return integrity();
    return new Map(s.map((x) => [x.key, x.observation]));
  });
  for (const key of keys) entries.push({ key: `section/${key}`, kind: 'section' });
  for (const [key, observation] of [...warnings].sort(([a], [b]) => cmp(a, b))) entries.push({ key, kind: 'fixed', observation });
  entries.sort((a, b) => cmp(a.key, b.key));
  for (let i = 1; i < entries.length; i++) if (entries[i - 1]!.key === entries[i]!.key) return integrity();
  return { entries, refs, sections: sectionsOf };
}

/**
 * The keys `gateSections` gives, without rendering: `renderRequiredSections`' own rule (the required datasets and every META carrier), META
 * when it has its derivation, and `supplied-references` when citations fail. The producer checks the rendered keys against these.
 */
function sectionKeys(m: GateMaterial): string[] {
  const c = m.candidate, pages = referencePages(c);
  const keys = new Set<string>([...REQUIRED_DATASETS, ...c.manifest.files.filter((f) => f.required).map((f) => f.key ?? f.path),
    ...c.datasetKeys().filter((k) => carriesMeta(c.dataset(k)!))]);
  if (metaSectionOf({ candidate: c, validation: m.validation, counts: m.validation.counts })) keys.add('meta');
  if (['CITE_UNRESOLVED', 'CITE_TARGET_NO_ORIGINAL', 'CITE_TOKEN_INVALID', 'ASSET_NOT_INDEXED'].some((code) => (m.validation.counts[code] ?? 0) > 0)
    || [...pages.keys()].some((ref) => !c.assets[ref])) keys.add('supplied-references');
  return [...keys].sort(cmp);
}

async function readObject(o: Pick<EvidenceGateOptions, 'bucket' | 'storageBudgets'>, key: string, sha256: string, size: number): Promise<Uint8Array> {
  const r = await verifiedRead(o.bucket, key, { sha256, size }, o.storageBudgets.maxBufferedObjectBytes);
  if (r.kind !== 'ok') throw new Error('original unavailable');
  return r.bytes;
}

/** A settled checker outcome as the render outcome U10's policy writes. A `pending` outcome is not settled and is never written. */
function renderOf(x: PdfEvidenceOutcome): RenderOutcome | null {
  if (x.state === 'pending') return null;
  if (x.state === 'rendered') return { state: 'rendered' };
  const navigation = safePreviewNavigation(x.navigation);
  return { state: 'failed', reasonCode: safePreviewReason(x.reason), ...(x.stage && { stage: x.stage }), ...(navigation && { navigation }) };
}

export type EvidenceBuildOutcome =
  /** Items were committed and the run is not sealed yet. Call again. */
  | { readonly state: 'building'; readonly generation: string; readonly items: number; readonly planned: number }
  /** No item could be committed because the next preview waits for U9's checker. `reason` says why the checker stopped, if it did. Call again. */
  | { readonly state: 'rendering'; readonly generation: string; readonly remaining: number; readonly reason: string | null }
  | { readonly state: 'complete'; readonly generation: string; readonly root: string }
  /** Another request holds this run's lease. Call again after it ends. */
  | { readonly state: 'leased'; readonly generation: string }
  /** The engine refused the build; the generation cannot be completed and needs a restart. */
  | { readonly state: 'refused'; readonly generation: string; readonly reason: EvidenceRefusal }
  /** Nothing can render the candidate's PDFs here (no Browser binding or no `pdfEvidenceBudget`): nothing was written. */
  | { readonly state: 'renderer-unavailable'; readonly generation: string };

export interface EvidenceBuilder {
  /**
   * One bounded build request for one candidate. `restart` begins a new generation after the latest, which supersedes it for readiness
   * (the only way to replace a sealed or stuck run); otherwise the latest generation is continued, and a sealed one is reported as it is.
   */
  step(a: { caseId: CaseId; candidateId: string; restart: boolean; leaseId: string }): Promise<EvidenceBuildOutcome>;
}

/** The latest evidence generation of a candidate on this client's database, or null when it has none. */
export async function latestGeneration(primary: Primary, a: { clientId: string; caseId: string; candidateId: string }) {
  const row = await primary.prepare(`SELECT generation, state, client_id, case_id, evidence_root FROM pub_evidence_run WHERE candidate_id = ?
    ORDER BY CAST(generation AS INTEGER) DESC LIMIT 1`).bind(a.candidateId).first<{ generation: string; state: string; client_id: string; case_id: string; evidence_root: string | null }>();
  if (!row) return null;
  if (row.client_id !== a.clientId || row.case_id !== a.caseId || !GENERATION.test(row.generation)) return integrity();
  return { generation: row.generation, complete: row.state === 'complete', root: row.evidence_root };
}

export function createEvidenceBuilder(o: EvidenceGateOptions): EvidenceBuilder {
  return { async step({ caseId, candidateId, restart, leaseId }) {
    const primary = o.db.withSession('first-primary') as Primary, scope = { caseId, candidateId };
    const latest = await latestGeneration(primary, { clientId: o.clientId, ...scope });
    const generation = !latest ? '1' : restart ? String(Number(latest.generation) + 1) : latest.generation;
    // A sealed run is reported as it is; only a restart replaces it. The readiness read verifies it, not this answer.
    if (latest?.complete && !restart && latest.root) return { state: 'complete', generation, root: latest.root };
    const store = d1EvidenceStore(o.db);
    const m = await verifiedMaterial(o, scope);
    const pin = m.link.candidate;
    const plan = await evidencePlan(m, o);
    const pdfEntries = plan.entries.filter((e): e is Extract<Entry, { kind: 'pdf' }> => e.kind === 'pdf');
    if (pdfEntries.length && !o.pdf) return { state: 'renderer-unavailable', generation };
    const binding: EvidenceBinding = { candidateId, generation, clientId: o.clientId, caseId, resultsVersion: pin.resultsVersion, manifestSha256: pin.manifestSha256,
      validatorVersion: m.validation.validatorVersion, rendererVersion: o.pdf?.rendererVersion ?? 'no-pdf-renderer' };
    const facts = await store.inspect(binding);
    if (facts && facts.state === 'complete' && facts.root) return { state: 'complete', generation, root: facts.root };
    const position = () => store.inspect(binding).then((f) => (f?.cursor ? decodeCursor(f.cursor).producer : null));
    let after = await position();

    // U9: the next window of PDFs after the cursor, settled once for this request. Receipts make a document settled in an earlier
    // request cost one D1 read here; a window holds at most the checker's maxDocumentsPerStep.
    const outcomes = new Map<string, PdfEvidenceOutcome>();
    let stopped: string | null = null;
    const ahead = pdfEntries.filter((e) => after === null || e.key > after);
    if (ahead.length && o.pdf) {
      const step = await o.pdf.step({ clientId: o.clientId, caseId, candidateId, resultsVersion: pin.resultsVersion, documents: ahead.map((e) => e.document) });
      for (const x of step.outcomes) outcomes.set(x.assetId, x);
      stopped = step.stopped;
    }
    const settledObservation = (e: Extract<Entry, { kind: 'pdf' }>) => {
      const x = outcomes.get(e.input.assetId), render = x ? renderOf(x) : null;
      return render ? assetPolicyItems([{ ...e.input, render }], { binding: { resultsVersion: pin.resultsVersion, manifestSha256: pin.manifestSha256,
        validatorVersion: m.validation.validatorVersion, diagnosticsSha256: m.validation.diagnosticsSha256 }, warningFingerprints: m.validation.warningFingerprints })[0]!.observation : null;
    };
    const index = new Map(plan.entries.map((e, i) => [e.key, i]));
    const originals = createOriginalsProducer({ refs: async () => plan.refs, bucket: o.bucket, batch: o.originals.batch, windowBytes: o.originals.windowBytes,
      maxObjectBytes: o.storageBudgets.maxBufferedObjectBytes });
    const producer: EvidenceProducer = async (cursor) => {
      const from = cursor === null ? 0 : (index.get(cursor) ?? integrity()) + 1;
      const e = plan.entries[from];
      if (!e) return { done: true };
      if (e.kind === 'original') {
        const next = await originals(cursor?.startsWith('original/') ? cursor.slice('original/'.length) : null);
        if (next.done || next.key !== e.key) return integrity();
        return { done: false, key: e.key, nextCursor: e.key, observation: next.observation };
      }
      const observation = e.kind === 'fixed' ? e.observation : e.kind === 'section' ? (await plan.sections()).get(e.key) : settledObservation(e);
      // Bounded by `settled` below, so an unsettled entry is never asked for; reaching one is a fault, not a guess.
      if (!observation) return integrity();
      return { done: false, key: e.key, nextCursor: e.key, observation };
    };
    // How many entries after the cursor are settled now: every entry is, except a PDF preview whose outcome this request does not hold.
    const settled = (cursor: string | null) => {
      let n = 0;
      for (let i = cursor === null ? 0 : (index.get(cursor) ?? integrity()) + 1; i < plan.entries.length && n < o.bounds.itemsPerStep; i++, n++) {
        const e = plan.entries[i]!;
        if (e.kind === 'pdf' && !settledObservation(e)) break;
      }
      return n;
    };
    const started = Date.now();
    let written = 0;
    // The lease is this request's only: released however the request ends, so the operator's next request continues at once.
    try {
    for (let first = true; first || Date.now() - started < o.wallMs; first = false) {
      const n = settled(after), done = after !== null && (index.get(after) ?? integrity()) === plan.entries.length - 1;
      if (n === 0 && !done && plan.entries.length > 0) {
        return written > 0 ? { state: 'building', generation, items: written, planned: plan.entries.length }
          : { state: 'rendering', generation, remaining: ahead.filter((e) => !settledObservation(e)).length, reason: stopped };
      }
      const engine = createEvidenceEngine({ binding, store, producer, clock: () => o.now().getTime(), leaseId, leaseMs: Math.max(o.wallMs, 1) + 60_000,
        bounds: { itemsPerStep: Math.max(1, n), bytesPerStep: o.bounds.bytesPerStep } });
      const result = await engine.step();
      if (result.kind === 'complete') return { state: 'complete', generation, root: result.root };
      if (result.kind === 'leased') return { state: 'leased', generation };
      if (result.kind === 'refused') return { state: 'refused', generation, reason: result.reason };
      written += result.items;
      after = await position();
    }
    return { state: 'building', generation, items: written, planned: plan.entries.length };
    } finally { await store.release?.(binding, leaseId).catch(() => undefined); }
  } };
}
