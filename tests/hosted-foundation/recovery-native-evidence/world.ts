// SYNTHETIC: genuine intake, native stager, import/correction service, repositories, authorizer and audit sink.
// Only D1 (SQLite) and R2 stream transports and the already-authenticated synthetic request are doubles.
import { world, CASE, CLIENT, now, auditViewers, auditViewKey, type World } from '../recovery-native-adapters/world.ts';
import { buildFixture, pdf } from '../../results-review/native/fixtures.ts';
import { BUDGETS, QUOTAS, submit, submissionOp } from '../storage/fixture.ts';
import { createHostedCandidateStager } from '../../../src/lib/server/runtime/hosted/candidate-stager.ts';
import { createNativeResultsImport } from '../../../src/lib/results-review/native/service.ts';
import { d1NativeCandidateRepository } from '../../../src/lib/results-review/native/repository.ts';
import { submissionSnapshotReader } from '../../../src/lib/results-review/native/submission-reader.ts';
import { d1SubmissionRepository, revisionIdOf } from '../../../src/lib/submissions/repository.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import type { HostedCandidateStagerOptions } from '../../../src/lib/server/runtime/hosted/candidate-stager.ts';
import type { AuditReadGate } from '../../../src/lib/audit/index.ts';
// Shared fixture composition explicitly provisions a separate audit view even for the malformed-lineage fixture.
// Otherwise the now-correct pre-read check would deny that test before it could exercise strict lineage validation.
export { auditViewers, auditViewKey };
export const AUDIT_GATE: Pick<AuditReadGate, 'caseAudit'> = { async caseAudit(a) { if (!auditViewers.has(auditViewKey(a))) throw contractError('forbidden'); } };
export const POLICY = { maxLineageRows: 5000, maxLineageBytes: 2 << 20, audit: AUDIT_GATE };
export const req = { caseId: CASE, exportId: 'native-e1', includeUserWork: true };
export async function nativeWorld(correction = false, isolated = false, path = 'folder/source.pdf') {
  const w = await world(isolated, true, true);
  w.options.limits.maxManifestBytes = 4 << 20;
  w.db.exec(`INSERT INTO tenant_case_grants (grant_id, client_id, scope, case_id, issuer, subject, principal_kind, role, slot, state, version, created_operation_id, request, created_by_issuer, created_by_subject, created_at)
    VALUES ('operator', ?, 'case', ?, ?, ?, 'staff', 'operator', 'operator', 'active', 1, 'operator-grant-op', '{}', ?, 'provisioner', ?)`, CLIENT, CASE, w.identity.principal!.issuer, w.identity.principal!.subject, w.identity.principal!.issuer, now().toISOString());
  const docs = [{ ref: 'OD-001', path, bytes: pdf('native recovery') }];
  await submit(w, CASE, docs);
  const revisionId = revisionIdOf(submissionOp(CASE, docs[0]!.ref));
  const pkg = buildFixture({ caseId: CASE, docs });
  const authorizeOperate: HostedCandidateStagerOptions['authorizeOperate'] = async (a) => {
    if (a.clientId !== CLIENT) throw contractError('forbidden');
    await w.identity.checkRevocation();
    await w.authorizer.authorizeCapability({ caseId: a.caseId, principal: a.principal, sessionId: a.sessionId, capability: 'operate' });
    await w.identity.checkRevocation();
  };
  const ports = createHostedCandidateStager({ bindings: w, clientId: CLIENT, identity: w.identity, audit: w.options.audit, authorizeOperate, budgets: BUDGETS, quotas: QUOTAS, now });
  const repository = d1NativeCandidateRepository(w.db), submissions = submissionSnapshotReader(d1SubmissionRepository(w.db));
  const service = createNativeResultsImport({ ...ports, clientId: CLIENT, budget: { maxRequestBytes: 8 << 20, maxFiles: 64, maxFileBytes: 1 << 20, maxPackageBytes: 4 << 20 }, authorizeOperate, repository, submissions, audit: w.options.audit, now })!;
  const admitted = await service.admit({ identity: w.identity, caseId: CASE, access: 'write' });
  const imported = await service.importPackage(admitted, { operationId: 'native-import', submissionRevisionId: revisionId, files: pkg.files });
  if (imported.kind !== 'linked') throw new Error(JSON.stringify(imported));
  let current = imported.candidate;
  if (correction) {
    const out = await service.correct(admitted, { operationId: 'native-correction', candidateId: current.candidateId, reason: 'Correct synthetic title', replacements: [{ key: 'matter', data: { title: 'Corrected title', short: 'M', forum: 'High Court', storyline: [], strategy: [] } }] });
    if (out.kind !== 'linked') throw new Error(JSON.stringify(out));
    current = out.candidate;
  }
  w.publish(current.link.candidate.resultsVersion);
  auditViewers.add(auditViewKey({ principal: w.identity.principal!, sessionId: w.identity.sessionId!, caseId: CASE }));
  // Explicit live version entitlement: real operator grant AND exact stored/case ownership/withdrawal.
  // This is fixture composition of the parent policy hook, not a provider acceptance claim or a case-read waiver.
  w.options.nativeEvidence = { ...POLICY, visibility: {
    kind: 'current-policy',
    async isVisible(q) {
      if (q.identity !== w.identity || q.caseId !== CASE) return false;
      try {
        await authorizeOperate({ clientId: CLIENT, caseId: CASE, principal: w.identity.principal!, sessionId: w.identity.sessionId! });
        const row = await w.db.prepare(`SELECT v.version_id FROM rs_results_version v WHERE v.case_id = ? AND v.version_id = ? AND v.state = 'stored'
          AND NOT EXISTS (SELECT 1 FROM rs_version_withdrawal WHERE version_id = v.version_id)`).bind(CASE, q.resultsVersion).first();
        await w.identity.checkRevocation();
        return !!row;
      } catch { return false; }
    },
  } };
  return { ...w, pkg, revisionId, imported: imported.candidate, current, service, admitted, repository, submissions };
}
export type NativeWorld = Awaited<ReturnType<typeof nativeWorld>>;
export const request = req;
export type { World };
