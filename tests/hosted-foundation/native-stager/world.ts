// Synthetic SQL/R2 adapters over the real schemas, real intake, validator, staging and native link repository.
import { readFileSync } from 'node:fs';
import { createHostedCandidateStager, type HostedCandidateStagerOptions } from '../../../src/lib/server/runtime/hosted/candidate-stager.ts';
import { fixture, docs, pdf, type Doc } from '../hosted-validation/fixture.ts';
import { buildFixture } from '../../results-review/native/fixtures.ts';
import { BUDGETS, QUOTAS, deployment, ids, submit, submissionOp } from '../storage/fixture.ts';
import { id, resultsVersion } from '../../../src/lib/server/runtime/ids.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import type { AuditEvent, Identity, SessionId } from '../../../src/lib/server/runtime/contracts.ts';
import type { StageRequest } from '../../../src/lib/results-review/native/ports.ts';
import { submissionSnapshotReader } from '../../../src/lib/results-review/native/submission-reader.ts';
import { d1SubmissionRepository, revisionIdOf } from '../../../src/lib/submissions/repository.ts';
import { d1NativeCandidateRepository } from '../../../src/lib/results-review/native/repository.ts';
import { createNativeResultsImport } from '../../../src/lib/results-review/native/service.ts';
import { validateHostedPackage } from '../../../src/lib/case-package/hosted-validation.ts';

export { docs, pdf };
export const caseId = id('case', 'synthetic-hosted-validator');
export const now = () => new Date('2001-01-01T00:00:00Z');
export function world(ds: Doc[] = docs(1), authored = false) {
  const dep = deployment(ids.clientA, [caseId, ids.caseB]);
  dep.db.sqlite.exec(readFileSync(new URL('../../../src/lib/results-review/native/migrations/0001_native_candidate_import.sql', import.meta.url), 'utf8'));
  const pkg = authored ? buildFixture({ caseId, docs: ds }) : fixture(ds);
  const events: AuditEvent[] = [];
  const state = { allowed: true, revoked: false, auditFails: false, onAudit: null as null | (() => void | Promise<void>) };
  const identity: Identity = {
    kind: 'verified', principal: { issuer: 'synthetic', subject: 'staff', kind: 'staff' }, sessionId: 'synthetic-session' as SessionId, clientId: ids.clientA,
    async checkRevocation() { if (state.revoked) throw contractError('invalid-session'); },
    async authorize() { throw new Error('client published visibility must not be used'); },
  };
  const authorizeOperate: HostedCandidateStagerOptions['authorizeOperate'] = async (a) => {
    if (!state.allowed || a.clientId !== ids.clientA || a.caseId !== caseId) throw contractError('forbidden');
  };
  const audit: HostedCandidateStagerOptions['audit'] = { async append(e) {
    if (state.auditFails) throw contractError('audit-unavailable', true);
    events.push(e);
    await state.onAudit?.();
    return { eventId: e.eventId };
  } };
  const config: HostedCandidateStagerOptions = { bindings: dep, clientId: ids.clientA, budgets: { ...BUDGETS, maxDocuments: 5000 }, quotas: { ...QUOTAS }, identity, authorizeOperate, audit, now };
  const ports = createHostedCandidateStager(config);
  const submissions = submissionSnapshotReader(d1SubmissionRepository(dep.db));
  const repository = d1NativeCandidateRepository(dep.db);
  async function upload(path = ds[0].path, bytes = ds[0].bytes, ref = 'selected', target = caseId, commit = true) {
    await submit(dep, target, [{ path, bytes, ref }], { commit });
    return revisionIdOf(submissionOp(target, ref));
  }
  async function request(revisionId: string): Promise<StageRequest> {
    const submission = await submissions.finalized({ clientId: ids.clientA, caseId, revisionId });
    if (submission.state !== 'finalized') throw new Error('fixture submission not finalized');
    const r = validateHostedPackage({ files: pkg.files, originals: new Map() }).result;
    if (r.verdict === 'reject') throw new Error('invalid synthetic package: ' + r.diagnostics.map((d) => d.code));
    return { clientId: ids.clientA, caseId, operationId: 'synthetic-stage', files: pkg.files, identity: { resultsVersion: resultsVersion(r.candidate.resultsVersion), manifestSha256: r.candidate.manifestSha256 }, submission };
  }
  async function linked(revisionId: string) {
    const service = createNativeResultsImport({ ...ports, clientId: ids.clientA, budget: { maxRequestBytes: 8 << 20, maxFiles: BUDGETS.maxPackageFiles, maxFileBytes: BUDGETS.maxPackageFileBytes, maxPackageBytes: BUDGETS.maxPackageBytes }, authorizeOperate, submissions, repository, audit, now })!;
    const token = await service.admit({ identity, caseId, access: 'write' });
    const out = await service.importPackage(token, { operationId: 'synthetic-linked', submissionRevisionId: revisionId, files: pkg.files });
    if (out.kind !== 'linked') throw new Error('fixture link refused: ' + JSON.stringify(out));
    return { service, token, candidate: out.candidate };
  }
  return { ...dep, pkg, config, ports, state, events, identity, repository, submissions, upload, request, linked };
}
