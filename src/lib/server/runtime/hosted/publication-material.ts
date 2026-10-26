// Request-scoped publication material. No provider composition, pointer writer, correction/operate reader or lock.
import type { AuditSink, CaseId, ClientId, Identity, ResultsVersion } from '../contracts.ts';
import { contractError, isDenial } from '../errors.ts';
import { freeze } from '../data.ts';
import { canonicalJson } from '../../../case-package/canonical.ts';
import { LIMITS, type Limits } from '../../../case-package/limits.ts';
import { validateHostedPackage } from '../../../case-package/hosted-validation.ts';
import { CITATION_TOKEN, parseCitationToken } from '../../../case-package/refs.ts';
import { parseStrictJson } from '../../../case-package/strict-json.ts';
import type { Candidate } from '../../../case-package/candidate.ts';
import { d1PublicationSnapshotRevision, type PublicationD1Database } from '../../../publication/hosted/d1-publisher.ts';
import type { CandidateReader, CandidateSnapshot, RequiredPreviewState } from '../../../publication/hosted/ports.ts';
import { isPreviewRenderStage, safePreviewNavigation, safePreviewReason, type PreviewNavigationObservation, type PreviewReasonCode, type PreviewRenderStage } from '../../../publication/hosted/preview-outcome.ts';
import { d1NativeCandidateRepository } from '../../../results-review/native/repository.ts';
import { inspectPackage } from '../../../results-review/native/package.ts';
import { buildCoverage } from '../../../results-review/native/coverage.ts';
import { submissionSnapshotReader } from '../../../results-review/native/submission-reader.ts';
import { GRANT_ROLES, permits } from '../../../tenancy/grants.ts';
import { LAYOUT } from '../../../storage/cloud/gate.ts';
import { preparePackage } from '../../../results/hosted/project.ts';
import { loadVerifiedModel } from '../../../results/hosted/model.ts';
import { projectionDifferences } from '../../../results/hosted/read-model.ts';
import { storageAccess } from '../../../storage/cloud/access.ts';
import type { CloudR2 } from '../../../storage/cloud/bindings.ts';
import { budgetsConsistent, type StorageBudgets } from '../../../storage/cloud/budgets.ts';
import { readOriginalFacts } from '../../../storage/cloud/original-facts.ts';
import { originalKey, packageKey } from '../../../storage/cloud/keys.ts';
import { verifiedRead } from '../../../storage/cloud/objects.ts';
import { admitVerification } from '../../../storage/cloud/verification.ts';
import type { FinalizedSubmissionSnapshot, RequiredOriginalLink } from './alpha-contracts.ts';
import type { NativePreviewRenderChecker } from '../../../viewer/hosted/render-check-contract.ts';
import { renderRequiredSections } from './required-section-render.ts';

export interface PublicationMaterialOptions {
  /** The SAME raw client DB used by native import and the atomic publisher, provisioned through publication 0003.
   * Never a replica session. The parent installs migrations; requests execute no DDL. */
  db: PublicationD1Database;
  bucket: CloudR2;
  clientId: ClientId;
  identity: Identity;
  audit: AuditSink;
  storageBudgets: StorageBudgets;
  /** All canonical validation limits, matching the importer's configuration. No deployment-budget defaults. */
  validationLimits: Limits;
  /** Internal source-owned implementation only. Null holds every file preview; it does not fabricate rendering. */
  renderChecker: NativePreviewRenderChecker | null;
  now(): Date;
}
const integrity = (): never => { throw contractError('integrity'); };
const unavailable = (): never => { throw contractError('storage-unavailable', true); };
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const count = (n: number, max: number) => Number.isSafeInteger(n) && n >= 0 && n <= max;
function fingerprints(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((x) => typeof x === 'string' && /^[0-9a-f]{32}$/.test(x))
    || new Set(value).size !== value.length) return integrity();
  return [...value].sort();
}
type Primary = ReturnType<PublicationD1Database['withSession']>;
const PREVIEWERS = GRANT_ROLES.filter((r) => permits(r, 'read-preview'));
type FileRow = { path: string; sha256: string; size: number; object_key: string };
type StoredVersion = {
  version_id: ResultsVersion; case_id: CaseId; state: string; manifest_sha256: string; input_revision_id: string;
  verdict: string; validator_version: string; diagnostics_sha256: string; warning_fingerprints: string;
  expected_documents: number; expected_assets: number; expected_seeds: number; expected_files: number; package_bytes: number; overview: string;
};

/** Null means configuration is unavailable. Authority is checked on every read, not at construction. */
export function createPublicationMaterialReader(options: PublicationMaterialOptions): CandidateReader | null {
  if (!options?.db?.withSession || !options.bucket || !options.clientId || !options.identity || !options.audit?.append
    || !options.storageBudgets || !budgetsConsistent(options.storageBudgets) || typeof options.now !== 'function'
    || !options.validationLimits || !Object.keys(LIMITS).every((k) => {
      const n = options.validationLimits[k as keyof Limits]; return Number.isSafeInteger(n) && n > 0;
    })) return null;
  const { db, bucket, clientId, identity, audit, renderChecker, now } = options;
  const b = Object.freeze({ ...options.storageBudgets }), limits = Object.freeze({ ...options.validationLimits });

  async function authority(caseId: CaseId) {
    if (identity.clientId !== clientId) throw contractError('wrong-client');
    if (identity.kind !== 'verified') throw contractError('unauthenticated');
    if (identity.principal.kind !== 'staff') throw contractError('forbidden');
    await identity.checkRevocation();
    // Read-preview is intentionally NOT operate: a separately granted publisher/reviewer can read this candidate.
    await identity.authorize({ caseId, operation: 'read-preview' });
  }
  /** Read-preview as it stands now, unaudited: the live session, then the grant rows the admitted decision read, as one
   * statement on the primary (tenancy/operate-observation.ts's condition for this operation). authority() stays the audited
   * decision, made once when a read is admitted; the principal it admitted is immutable, its grant is not. */
  async function observe(primary: Primary, caseId: CaseId) {
    if (identity.kind !== 'verified') throw contractError('unauthenticated');
    await identity.checkRevocation();
    const { issuer, subject, kind } = identity.principal;
    const row = await primary.prepare(`SELECT (EXISTS (SELECT 1 FROM rs_storage_identity i JOIN rs_case c ON c.case_id = ? WHERE i.singleton = 1 AND i.client_id = ? AND i.layout = ?)
      AND EXISTS (SELECT 1 FROM tenant_case_grants g WHERE g.client_id = ? AND g.scope = 'case' AND g.case_id = ? AND g.issuer = ? AND g.subject = ?
        AND g.principal_kind = ? AND g.state = 'active' AND g.revoked_at IS NULL AND g.role IN (${PREVIEWERS.map(() => '?').join(', ')})
        AND (g.expires_at IS NULL OR julianday(g.expires_at) > julianday(?)))) AS ok`)
      .bind(caseId, clientId, LAYOUT, clientId, caseId, issuer, subject, kind, ...PREVIEWERS, now().toISOString())
      .first<{ ok: number }>().catch(() => { throw contractError('identity-unavailable', true); });
    if (row?.ok !== 1) throw contractError('forbidden');
  }
  async function record(caseId: CaseId, candidateId: string, version: ResultsVersion | null, outcome: 'succeeded' | 'failed' | 'denied' | 'refused') {
    const event = {
      eventId: crypto.randomUUID(), actor: identity.kind === 'verified'
        ? { kind: 'verified' as const, principal: identity.principal, sessionId: identity.sessionId }
        : { kind: 'anonymous' as const, principal: null, sessionId: null },
      // A successful append records release INTENT, not completed disclosure. Later checks can still refuse.
      action: outcome === 'succeeded' ? 'publication.material.read.intent' : 'publication.material.read', object: { kind: 'candidate', id: candidateId, caseId }, version, outcome, at: now().toISOString(),
    };
    if ((await audit.append(event)).eventId !== event.eventId) return unavailable();
  }
  async function admit(primary: Primary, caseId: CaseId, objects: number, bytes: number) {
    if (!count(objects, b.maxVerifyObjects) || !count(bytes, b.maxVerifyBytes)) return unavailable();
    if (await admitVerification({ db: primary, budgets: b }, caseId, { objects, bytes }, now().getTime()) !== 'admitted') return unavailable();
  }
  async function readBytes(row: { object_key: string; size: number; sha256: string }, max: number) {
    const r = await verifiedRead(bucket, row.object_key, row, max);
    if (r.kind === 'missing' || r.kind === 'changed') return integrity();
    if (r.kind !== 'ok') return unavailable();
    return r.bytes;
  }

  /** A single exact finalized revision, not an unbounded list of the case's submissions. */
  async function submission(primary: Primary, caseId: CaseId, revisionId: string): Promise<FinalizedSubmissionSnapshot> {
    // One statement, as the importer reads it. Its rows are this case's files, already counted against maxVerifyObjects.
    const s = await submissionSnapshotReader(primary).finalized({ clientId, caseId, revisionId });
    if (s.state !== 'finalized' || s.manifest.clientId !== clientId || s.manifest.caseId !== caseId || s.manifest.revisionId !== revisionId
      || !count(s.manifest.files.length, limits.assets)) return integrity();
    return s;
  }

  /** A baseline is accepted CURRENT publication evidence, never package data or a missing-port fallback. */
  async function baseline(primary: Primary, caseId: CaseId): Promise<{ token: string; warnings: string[] }> {
    const p = await primary.prepare('SELECT state, version_id FROM rs_publication WHERE case_id = ?')
      .bind(caseId).first<{ state: string; version_id: string }>();
    const rows = await primary.prepare('SELECT fingerprint FROM rs_trusted_fingerprint WHERE case_id = ? ORDER BY fingerprint LIMIT ?')
      .bind(caseId, limits.jsonValues + 1).all<{ fingerprint: string }>();
    if (rows.results.length > limits.jsonValues) return unavailable();
    const trusted = fingerprints(rows.results.map((r) => r.fingerprint));
    if (!p) {
      if (trusted.length) return integrity();
      return { token: canonicalJson({ publication: null, trusted }), warnings: trusted };
    }
    const owned = await primary.prepare("SELECT 1 AS x FROM rs_results_version WHERE version_id = ? AND case_id = ? AND state = 'stored'")
      .bind(p.version_id, caseId).first();
    if (!owned) return integrity();
    if (p.state === 'withdrawn') {
      const withdrawn = await primary.prepare('SELECT 1 AS x FROM rs_version_withdrawal WHERE version_id = ? AND case_id = ?')
        .bind(p.version_id, caseId).first();
      if (!withdrawn) return integrity();
      return { token: canonicalJson({ publication: p, trusted }), warnings: [] };
    }
    if (p.state !== 'published') return integrity();
    const accepted = await primary.prepare(`SELECT s.warning_fingerprints, v.warning_fingerprints AS stored_warnings, r.intent_json
      FROM pub_apply_receipt r JOIN pub_operation o ON o.operation_id = r.operation_id AND o.client_id = r.client_id AND o.case_id = r.case_id
      JOIN pub_signoff s ON s.signoff_id = o.signoff_id AND s.client_id = o.client_id AND s.case_id = o.case_id
      JOIN rs_results_version v ON v.version_id = o.results_version AND v.case_id = o.case_id AND v.state = 'stored'
      WHERE r.client_id = ? AND r.case_id = ? AND o.kind = 'publish' AND o.state = 'audited' AND s.state = 'audited'
        AND o.results_version = ? AND s.results_version = o.results_version
        AND NOT EXISTS (SELECT 1 FROM rs_version_withdrawal w WHERE w.version_id = v.version_id)
      ORDER BY r.applied_at DESC, r.operation_id DESC LIMIT 1`)
      .bind(clientId, caseId, p.version_id).first<{ warning_fingerprints: string; stored_warnings: string; intent_json: string }>();
    if (!accepted) return integrity();
    const warnings = fingerprints(parseStrictJson(accepted.warning_fingerprints));
    if (!same(warnings, trusted) || !same(warnings, fingerprints(parseStrictJson(accepted.stored_warnings)))) return integrity();
    return { token: canonicalJson({ publication: p, trusted, accepted }), warnings };
  }

  return {
    async read(input): Promise<CandidateSnapshot | null> {
      const scope = Object.freeze({ ...input });
      let rv: ResultsVersion | null = null;
      // Authority, initial primary-session/revision faults, absence and all material work share one audited lifecycle.
      try {
        if (scope.clientId !== clientId) throw contractError('wrong-client');
        await authority(scope.caseId);
        const revision = await d1PublicationSnapshotRevision(db, scope);
        if (revision === null) {
          await record(scope.caseId, scope.candidateId, null, 'refused');
          await authority(scope.caseId);
          return null;
        }
        const primary = db.withSession('first-primary');
        const open = storageAccess({ bindings: { db: primary, bucket }, clientId, budgets: b }, 'storage-unavailable');
        const candidates = d1NativeCandidateRepository(primary);
        const storage = await open();
        const linked = await candidates.candidate(scope);
        if (!linked || !linked.current || linked.supersededBy !== null) return integrity();
        const link = linked.link, pin = link.candidate;
        rv = pin.resultsVersion;
        if (link.clientId !== clientId || link.caseId !== scope.caseId || pin.clientId !== clientId || pin.caseId !== scope.caseId
          || pin.candidateId !== scope.candidateId || linked.candidateId !== scope.candidateId) return integrity();
        const version = await primary.prepare('SELECT * FROM rs_results_version WHERE version_id = ? AND case_id = ? AND state = \'stored\'')
          .bind(rv, scope.caseId).first<StoredVersion>();
        if (!version || version.manifest_sha256 !== pin.manifestSha256 || version.input_revision_id !== pin.packageInputRevisionId) return integrity();
        if (!count(version.expected_documents, b.maxDocuments) || !count(version.expected_assets, limits.assets)
          || !count(version.expected_seeds, limits.jsonValues) || !count(version.expected_files, b.maxPackageFiles)
          || !count(version.package_bytes, b.maxPackageBytes)) return unavailable();
        // Bound the existing model/folder helpers before they buffer rows. Actual row counts, not claimed expectations.
        const n = await primary.prepare(`SELECT EXISTS (SELECT 1 FROM rs_case WHERE case_id = ?) AS known,
          (SELECT COUNT(*) FROM rs_document WHERE version_id = ?) AS documents, (SELECT COUNT(*) FROM rs_asset WHERE version_id = ?) AS assets,
          (SELECT COUNT(*) FROM rs_seed WHERE version_id = ?) AS seeds, (SELECT COUNT(*) FROM rs_case_original WHERE case_id = ?) AS originals,
          (SELECT COUNT(*) FROM submissions_file WHERE case_id = ?) AS submitted`).bind(scope.caseId, rv, rv, rv, scope.caseId, scope.caseId)
          .first<{ known: number; documents: number; assets: number; seeds: number; originals: number; submitted: number }>();
        if (!n || n.known !== 1) return integrity();
        if (!count(n.documents, b.maxDocuments) || !count(n.assets, limits.assets) || !count(n.seeds, limits.jsonValues)
          || !count(n.originals, b.maxVerifyObjects) || !count(n.submitted, b.maxVerifyObjects)) return unavailable();
        const files = await primary.prepare('SELECT path, sha256, size, object_key FROM rs_package_file WHERE version_id = ? ORDER BY path LIMIT ?')
          .bind(rv, b.maxPackageFiles + 1).all<FileRow>();
        if (files.results.length !== version.expected_files || files.results.length > b.maxPackageFiles) return integrity();
        let total = 0;
        for (const f of files.results) {
          if (!count(f.size, b.maxPackageFileBytes) || f.object_key !== packageKey(rv, f.sha256)) return integrity();
          total += f.size;
        }
        if (total !== version.package_bytes || !count(total, b.maxPackageBytes)) return integrity();
        if (link.coverage.policy !== 'exact-required-file-set/1' || !Array.isArray(link.coverage.mappedOriginals)) return integrity();
        const mapped: readonly RequiredOriginalLink[] = link.coverage.mappedOriginals;
        const unique = new Map<string, number>();
        let previewObjects = 0, previewBytes = 0;
        for (const m of mapped) {
          if (!count(m.size, b.maxBufferedObjectBytes) || !Array.isArray(m.packageRefs) || m.packageRefs.length === 0) return integrity();
          if (unique.has(m.sha256) && unique.get(m.sha256) !== m.size) return integrity();
          unique.set(m.sha256, m.size);
          previewObjects += m.packageRefs.length; previewBytes += m.size * m.packageRefs.length;
        }
        const oldBaseline = await baseline(primary, scope.caseId);
        // One complete per-read plan before any protected R2 byte. Facts hash each distinct object; the checker gets
        // another verified read per package ref. Non-PDF/no-checker paths conservatively reserve that work too.
        await admit(primary, scope.caseId, files.results.length + unique.size + previewObjects,
          total + [...unique.values()].reduce((n, size) => n + size, 0) + previewBytes);
        const bytes = new Map<string, Uint8Array>();
        for (const f of files.results) bytes.set(f.path, await readBytes(f, b.maxPackageFileBytes));
        const inspected = inspectPackage(bytes, scope.caseId);
        if (!inspected.ok || inspected.value.resultsVersion !== rv || inspected.value.manifestSha256 !== pin.manifestSha256
          || inspected.value.inputRevisionId !== pin.packageInputRevisionId) return integrity();
        const prepared = preparePackage(bytes);
        if (!prepared.ok) return integrity();
        // Check the previously admitted exact link plan against the real package before any original read.
        const byRef = new Map(mapped.flatMap((m) => m.packageRefs.map((ref) => [ref, m] as const)));
        if (byRef.size !== prepared.fileAssets.length) return integrity();
        for (const f of prepared.fileAssets) {
          const m = byRef.get(f.key);
          if (!m || m.packagePath !== f.path || m.sha256 !== f.sha256 || m.size !== f.size || !count(f.size, b.maxBufferedObjectBytes)) return integrity();
          if (unique.get(f.sha256) !== f.size) return integrity();
        }
        const originals = await readOriginalFacts(storage, scope.caseId, prepared.fileAssets, mapped);
        if (originals.kind !== 'ok') return integrity();
        const validated = validateHostedPackage({ files: bytes, originals: originals.facts, limits });
        const result = validated.result;
        if (result.verdict === 'reject' || result.errorFingerprints.length || !result.candidate) return integrity();
        // The storage schema has no error-fingerprint column. Only a genuine fresh accepted canonical result proves [];
        // every persisted validation field, including the complete warning set, must match that result exactly.
        if (result.verdict !== version.verdict || result.validatorVersion !== version.validator_version
          || result.diagnosticsSha256 !== version.diagnostics_sha256
          || !same(result.warningFingerprints, fingerprints(parseStrictJson(version.warning_fingerprints)))) return integrity();
        const submitted = await submission(primary, scope.caseId, link.submissionRevisionId);
        if (submitted.storedManifestSha256 !== link.submissionManifestSha256) return integrity();
        const coverage = buildCoverage({ assets: inspected.value.assets, submission: submitted, caseMismatch: validated.caseMismatch, warningFingerprints: result.warningFingerprints });
        if (!coverage.ok || !same(coverage.coverage, link.coverage)) return integrity();
        const projected = prepared.project(originals.facts);
        if (!projected.ok) return integrity();
        const model = await loadVerifiedModel(primary, rv);
        if (projectionDifferences({ documents: model.docs, assets: model.assets, seeds: model.seeds,
          chronologyJson: JSON.stringify(model.docs.map((d) => JSON.parse(d.list_json))), overview: version.overview, expect: projected.projection.expect }, projected.projection).length) return integrity();
        const requiredSections = [...await renderRequiredSections({ candidate: result.candidate, projection: projected.projection, counts: result.counts,
          originals: new Map(mapped.flatMap((m) => m.packageRefs.map((ref) => [ref, m.submissionAssetId] as const))) })];
        const requiredPreviews: { assetId: string; state: RequiredPreviewState; reasonCode?: PreviewReasonCode; stage?: PreviewRenderStage; navigation?: PreviewNavigationObservation }[] = [];
        const pagesByRef = referencePages(result.candidate);
        // Canonical uncapped counts cover ALL structured citations (including schema-specific arrays), not only
        // the capped diagnostic list. Missing indexed assets also make supplied targets unopenable, even when the
        // register contains the ref. The inline scan covers generated datasets and file-level tokens.
        // This is separate mandatory display evidence, NOT a retagged warning or an invented diagnostic fingerprint.
        if (['CITE_UNRESOLVED', 'CITE_TARGET_NO_ORIGINAL', 'CITE_TOKEN_INVALID', 'ASSET_NOT_INDEXED']
          .some((code) => (result.counts[code] ?? 0) > 0)
          || [...pagesByRef.keys()].some((ref) => !result.candidate!.assets[ref])) {
          requiredSections.push({ key: 'supplied-references', state: 'invalid' });
        }
        for (const [ref, asset] of Object.entries(result.candidate.assets).sort(([a], [b]) => a.localeCompare(b))) {
          let state: RequiredPreviewState = 'pending';
          let reasonCode: PreviewReasonCode | undefined, stage: PreviewRenderStage | undefined, navigation: PreviewNavigationObservation | undefined;
          const fact = originals.facts.get(ref);
          if (asset.kind === 'file' && asset.mediaType === 'application/pdf' && fact && !fact.downloadOnly && renderChecker) {
            // Same original bytes and pagination, not an unproved conversion. All source/asset refs remain unchanged.
            await observe(primary, scope.caseId);
            const data = await readBytes({ object_key: originalKey(asset.sha256), size: asset.size, sha256: asset.sha256 }, b.maxBufferedObjectBytes);
            const checked = await renderChecker.verify({ ...scope, resultsVersion: rv, assetId: ref, bytes: data, sha256: asset.sha256, mediaType: asset.mediaType });
            state = checked.state === 'failed' ? 'failed' : 'pending';
            if (checked.state === 'rendered' && typeof checked.rendererVersion === 'string' && checked.rendererVersion.trim()
              && Number.isSafeInteger(checked.pages) && checked.pages! > 0 && checked.reason === null) {
              state = (pagesByRef.get(ref) ?? []).every((p) => p <= checked.pages!) ? 'rendered' : 'failed';
              if (state === 'failed') reasonCode = 'page-reference-out-of-range';
            } else {
              // Only fixed source literals pass: a raw exception, URL, session or provider string becomes the generic code.
              reasonCode = safePreviewReason(checked.reason);
              if (isPreviewRenderStage(checked.stage)) stage = checked.stage;
              navigation = safePreviewNavigation(checked.navigation);
            }
          }
          requiredPreviews.push({ assetId: ref, state, ...(reasonCode && { reasonCode }), ...(stage && { stage }), ...(navigation && { navigation }) });
        }
        if (await d1PublicationSnapshotRevision(db, scope) !== revision) return integrity();
        await record(scope.caseId, scope.candidateId, rv, 'succeeded');
        if ((await baseline(primary, scope.caseId)).token !== oldBaseline.token) return integrity();
        // ALL awaited package/fact/model/render/audit work is inside these real D1 revision observations.
        if (await d1PublicationSnapshotRevision(db, scope) !== revision) return integrity();
        // Post-await release authority is a distinct observation after every other await, not a Clerk/D1 lock. The parent
        // owns the final coherent sign-off fence if a D1 material writer races this last external-authority check.
        await observe(primary, scope.caseId);
        return freeze({ link: { linkId: link.linkId, clientId, caseId: scope.caseId, submissionRevisionId: link.submissionRevisionId,
          submissionManifestSha256: link.submissionManifestSha256, candidate: pin }, preparedBy: { issuer: link.operator.issuer, subject: link.operator.subject },
          snapshotRevision: revision, validation: { verdict: result.verdict, validatorVersion: result.validatorVersion, diagnosticsSha256: result.diagnosticsSha256,
            errorFingerprints: result.errorFingerprints, warningFingerprints: result.warningFingerprints }, trustedBaseline: oldBaseline.warnings, requiredSections, requiredPreviews });
      } catch (e) {
        // Failure releases no snapshot. Audit failure is itself a refusal; never replace it with a successful read.
        // Do not depend on another metadata read here: the initial transport itself may be broken.
        await record(scope.caseId, scope.candidateId, rv, isDenial(e) ? 'denied' : 'failed');
        throw e;
      }
    },
  };
}

/** Canonical validation already bounded and checked these values. Page assertions additionally require actual renderer
 * page counts. No clamp, renumbering, generated pagination or mutation of supplied references is permitted. */
function referencePages(candidate: Candidate): ReadonlyMap<string, readonly number[]> {
  const pages = new Map<string, Set<number>>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const m of value.matchAll(new RegExp(CITATION_TOKEN.source, 'g'))) {
        const token = parseCitationToken(m[1].trim());
        if (!token) return integrity();
        const found = pages.get(token.ref) ?? new Set<number>();
        if (token.page !== null) found.add(token.page);
        pages.set(token.ref, found);
      }
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  for (const key of candidate.datasetKeys()) visit(candidate.dataset(key)?.data);
  return new Map([...pages].map(([ref, found]) => [ref, [...found].sort((a, b) => a - b)]));
}
