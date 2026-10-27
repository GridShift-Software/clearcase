// The candidate reader for publication once evidence runs exist (snapshot v2, real-export design 2; U14). A candidate with no evidence run is
// read by the v1 material reader exactly as before. A candidate with one is read as a v2 snapshot of its LATEST generation, built on every read
// from what D1 holds: the link, the stored validation, the revision and the sealed run's SQL counts. Nothing is cached, so a run built again
// (the operator's restart, `evidence-gate.ts`) replaces an older one on the next read, and no older summary is ever served.
//
// Before a snapshot is released the run must be this candidate's: bound to its results version, manifest and stored validator, sealed, and
// covering the link's coverage exactly (`coverage-evidence.ts`). A run still building, or a newer generation still building, answers 503.
import type { AuditSink, CaseId, ClientId, Identity, ResultsVersion } from '../contracts.ts';
import { contractError, isDenial } from '../errors.ts';
import { freeze } from '../data.ts';
import { d1PublicationSnapshotRevision, type PublicationD1Database } from '../../../publication/hosted/d1-publisher.ts';
import type { CandidateReader, CandidateSnapshotV2 } from '../../../publication/hosted/ports.ts';
import { d1EvidenceReader } from '../../../publication/hosted/readiness-evidence.ts';
import { assetBindingOf, checkSnapshotV2, evidenceCount, SNAPSHOT_V2_FORMAT } from '../../../publication/hosted/rules.ts';
import { coverageFault } from '../../../publication/hosted/coverage-evidence.ts';
import { d1NativeCandidateRepository } from '../../../results-review/native/repository.ts';
import { previewGrantCondition, previewGrantRoles } from '../../../tenancy/preview-observation.ts';
import { LAYOUT } from '../../../storage/cloud/gate.ts';
import { latestGeneration } from './evidence-gate.ts';

export interface EvidenceSnapshotOptions {
  /** The same raw client DB the material reader, the evidence store and the publisher use. */
  db: PublicationD1Database;
  clientId: ClientId;
  identity: Identity;
  audit: AuditSink;
  /** The v1 reader, for every candidate that has no evidence run. */
  v1: CandidateReader;
  now(): Date;
}
const integrity = (): never => { throw contractError('integrity'); };
const unavailable = (): never => { throw contractError('storage-unavailable', true); };

export function createEvidenceSnapshotReader(o: EvidenceSnapshotOptions): CandidateReader | null {
  if (!o?.db?.withSession || !o.clientId || !o.identity || typeof o.audit?.append !== 'function' || typeof o.v1?.read !== 'function' || typeof o.now !== 'function') return null;
  const { db, clientId, identity, audit, now } = o;
  const evidence = d1EvidenceReader(db);

  async function authority(caseId: CaseId) {
    if (identity.clientId !== clientId) throw contractError('wrong-client');
    if (identity.kind !== 'verified') throw contractError('unauthenticated');
    if (identity.principal.kind !== 'staff') throw contractError('forbidden');
    await identity.checkRevocation();
    await identity.authorize({ caseId, operation: 'read-preview' });
  }
  // The grant rows the admitted read-preview decision read, as one primary statement after every other await (as the v1 reader does).
  async function observe(caseId: CaseId) {
    if (identity.kind !== 'verified') throw contractError('unauthenticated');
    await identity.checkRevocation();
    const { issuer, subject, kind } = identity.principal;
    const row = await db.withSession('first-primary').prepare(`SELECT (EXISTS (SELECT 1 FROM rs_storage_identity i JOIN rs_case c ON c.case_id = ? WHERE i.singleton = 1 AND i.client_id = ? AND i.layout = ?)
      AND ${previewGrantCondition('bound')}) AS ok`)
      .bind(caseId, clientId, LAYOUT, clientId, caseId, issuer, subject, kind, ...previewGrantRoles, now().toISOString())
      .first<{ ok: number }>().catch(() => { throw contractError('identity-unavailable', true); });
    if (row?.ok !== 1) throw contractError('forbidden');
  }
  async function record(caseId: CaseId, candidateId: string, version: ResultsVersion | null, outcome: 'succeeded' | 'failed' | 'denied' | 'refused') {
    const event = {
      eventId: crypto.randomUUID(), actor: identity.kind === 'verified'
        ? { kind: 'verified' as const, principal: identity.principal, sessionId: identity.sessionId }
        : { kind: 'anonymous' as const, principal: null, sessionId: null },
      action: outcome === 'succeeded' ? 'publication.material.read.intent' : 'publication.material.read', object: { kind: 'candidate', id: candidateId, caseId }, version, outcome, at: now().toISOString(),
    };
    if ((await audit.append(event)).eventId !== event.eventId) return unavailable();
  }

  return { async read(input) {
    const scope = Object.freeze({ ...input });
    if (scope.clientId !== clientId) throw contractError('wrong-client');
    // Authority precedes every metadata read, including whether a run exists. The v1 reader then makes its own audited decision.
    try { await authority(scope.caseId); } catch (e) { await record(scope.caseId, scope.candidateId, null, isDenial(e) ? 'denied' : 'failed'); throw e; }
    const primary = db.withSession('first-primary');
    const latest = await latestGeneration(primary, scope);
    if (!latest) return o.v1.read(scope);
    let rv: ResultsVersion | null = null;
    try {
      const revision = await d1PublicationSnapshotRevision(db, scope);
      if (revision === null) { await record(scope.caseId, scope.candidateId, null, 'refused'); return null; }
      if (!latest.complete) return unavailable();
      const linked = await d1NativeCandidateRepository(primary).candidate(scope);
      if (!linked || !linked.current || linked.supersededBy !== null) return integrity();
      const link = linked.link, pin = link.candidate;
      rv = pin.resultsVersion;
      if (link.clientId !== clientId || link.caseId !== scope.caseId || pin.clientId !== clientId || pin.caseId !== scope.caseId || pin.candidateId !== scope.candidateId
        || linked.candidateId !== scope.candidateId || link.coverage?.policy !== 'exact-required-file-set/1') return integrity();
      const version = await primary.prepare("SELECT verdict, validator_version, diagnostics_sha256, manifest_sha256, input_revision_id FROM rs_results_version WHERE version_id = ? AND case_id = ? AND state = 'stored'")
        .bind(rv, scope.caseId).first<{ verdict: 'accept' | 'report' | 'reject'; validator_version: string; diagnostics_sha256: string; manifest_sha256: string; input_revision_id: string }>();
      if (!version || version.manifest_sha256 !== pin.manifestSha256 || version.input_revision_id !== pin.packageInputRevisionId) return integrity();
      // The run must be bound to exactly this candidate's version and stored validation; the summary then checks its seal.
      const run = await primary.prepare('SELECT client_id, case_id, results_version, manifest_sha256, validator_version FROM pub_evidence_run WHERE candidate_id = ? AND generation = ?')
        .bind(scope.candidateId, latest.generation).first<{ client_id: string; case_id: string; results_version: string; manifest_sha256: string; validator_version: string }>();
      if (!run || run.client_id !== clientId || run.case_id !== scope.caseId || run.results_version !== rv || run.manifest_sha256 !== pin.manifestSha256
        || run.validator_version !== version.validator_version) return integrity();
      const summary = await evidence.summary({ ...scope, generation: latest.generation });
      if (!summary) return integrity();
      const snapshot: CandidateSnapshotV2 = {
        format: SNAPSHOT_V2_FORMAT,
        link: { linkId: link.linkId, clientId, caseId: scope.caseId, submissionRevisionId: link.submissionRevisionId, submissionManifestSha256: link.submissionManifestSha256, candidate: pin },
        preparedBy: { issuer: link.operator.issuer, subject: link.operator.subject }, snapshotRevision: revision,
        validation: { verdict: version.verdict, validatorVersion: version.validator_version, diagnosticsSha256: version.diagnostics_sha256 },
        evidence: { generation: latest.generation, root: summary.root, items: summary.items, groups: summary.groups, newWarnings: summary.newWarnings },
      };
      const checked = checkSnapshotV2(snapshot);
      if (!checked) return integrity();
      const claim = { clientId, caseId: scope.caseId, candidateId: scope.candidateId, generation: latest.generation, root: summary.root, resultsVersion: rv, manifestSha256: pin.manifestSha256 };
      const fault = await coverageFault(evidence, claim, link.coverage,
        { original: evidenceCount(checked, 'original'), preview: evidenceCount(checked, 'preview'), warning: evidenceCount(checked, 'warning') }, assetBindingOf(checked));
      if (fault) return integrity();
      if (await d1PublicationSnapshotRevision(db, scope) !== revision) return integrity();
      const still = await latestGeneration(primary, scope);
      if (!still || still.generation !== latest.generation || still.root !== summary.root) return integrity();
      await record(scope.caseId, scope.candidateId, rv, 'succeeded');
      await observe(scope.caseId);
      return freeze(checked);
    } catch (e) {
      await record(scope.caseId, scope.candidateId, rv, isDenial(e) ? 'denied' : 'failed');
      throw e;
    }
  } };
}
