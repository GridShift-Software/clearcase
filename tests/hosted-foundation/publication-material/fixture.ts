// Synthetic component fixtures. SQLite and MemoryR2 are transport doubles; the SQL schemas, byte checks, canonical
// validator, staging, immutable native repository and Svelte SSR page below are real. Checker success is a UNIT DOUBLE,
// never renderer acceptance. Identity/audit are explicit doubles, not Clerk or the production audit sink.
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { SqliteD1, MemoryR2 } from '../storage/doubles.ts';
import { BUDGETS, QUOTAS } from '../storage/fixture.ts';
import { buildPackage } from '../../../src/lib/case-package/writer.ts';
import { LIMITS } from '../../../src/lib/case-package/limits.ts';
import { sha256Hex } from '../../../src/lib/case-package/hash.ts';
import { canonicalText } from '../../../src/lib/case-package/canonical.ts';
import { validateHostedPackage } from '../../../src/lib/case-package/hosted-validation.ts';
import { preparePackage } from '../../../src/lib/results/hosted/project.ts';
import { readOriginalFacts } from '../../../src/lib/storage/cloud/original-facts.ts';
import { createResultsStaging } from '../../../src/lib/storage/cloud/staging.ts';
import { createOriginalIntake } from '../../../src/lib/storage/cloud/intake.ts';
import { d1SubmissionRepository } from '../../../src/lib/submissions/repository.ts';
import { buildCoverage } from '../../../src/lib/results-review/native/coverage.ts';
import { d1NativeCandidateRepository } from '../../../src/lib/results-review/native/repository.ts';
import { candidateAuditEvent } from '../../../src/lib/results-review/native/audit.ts';
import { buildCorrection, inspectPackage } from '../../../src/lib/results-review/native/package.ts';
import { id, resultsVersion, sha256 } from '../../../src/lib/server/runtime/ids.ts';
import type { AuditEvent, CaseOperation, Identity } from '../../../src/lib/server/runtime/contracts.ts';
import type { CandidateImportLink } from '../../../src/lib/server/runtime/hosted/alpha-contracts.ts';
import type { NativePreviewRenderChecker } from '../../../src/lib/viewer/hosted/render-check-contract.ts';
import { createPublicationMaterialReader, type PublicationMaterialOptions } from '../../../src/lib/server/runtime/hosted/publication-material.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';

export const CLIENT = id('client', 'client-a'), CASE = id('case', 'case-a');
export const NOW = '2026-10-25T11:00:00.000Z';
export const utf8 = (s: string) => new TextEncoder().encode(s);
/** A genuinely well-formed one-page synthetic PDF, though the UNIT checker double below does not render it. */
export function pdf() {
  let text = '%PDF-1.4\n';
  const offsets = [0];
  for (const body of ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream']) {
    offsets.push(text.length); text += `${offsets.length - 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = text.length;
  text += 'xref\n0 5\n0000000000 65535 f \n' + offsets.slice(1).map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
  return utf8(text + `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
export class PrimaryD1 extends SqliteD1 {
  sessions: string[] = [];
  withSession(constraint: 'first-primary') { this.sessions.push(constraint); return this; }
}
export async function world(o: { fold?: boolean; textStatus?: 'none' | 'extracted'; section?: boolean; page?: number; missing?: boolean; alias?: boolean; mediaType?: string; settled?: boolean } = {}) {
  const db = new PrimaryD1(), bucket = new MemoryR2();
  for (const p of ['tenancy/migrations/0001_tenant_case_grants.sql', 'tenancy/migrations/0002_tenant_grant_operations.sql',
    'results-review/native/migrations/0001_native_candidate_import.sql', 'publication/hosted/migrations/0001_publication_ledger.sql',
    'publication/hosted/migrations/0002_atomic_publication.sql']) db.sqlite.exec(readFileSync(`src/lib/${p}`, 'utf8'));
  db.exec("INSERT INTO rs_storage_identity VALUES (1, ?, 'clearcase.rs/1')", CLIENT);
  db.exec('INSERT INTO rs_case VALUES (?, ?)', CASE, 'Synthetic only');
  bucket.setRaw('identity/client.json', utf8(JSON.stringify({ client_id: CLIENT })));
  const bytes = pdf(), hash = sha256Hex(bytes), storedPath = 'DOCS/Letter.pdf', indexedPath = o.fold ? 'docs/letter.pdf' : storedPath;
  const ctx = { bindings: { db, bucket }, clientId: CLIENT, budgets: BUDGETS, quotas: QUOTAS, authorize: async () => {}, now: () => new Date(NOW) };
  const originals = createOriginalIntake(ctx), submissions = d1SubmissionRepository(db);
  const operationId = 'synthetic-upload', assetId = 'sub-synthetic-upload';
  const input = { clientId: CLIENT, caseId: CASE, operationId, assetId, path: storedPath, filename: 'Letter.pdf', mediaType: 'application/pdf' as const,
    size: bytes.byteLength, sha256: hash, principal: { issuer: 'synthetic', subject: 'uploader' }, at: NOW };
  await submissions.declare(input);
  expect((await originals.declare({ ...input })).kind).toBe('declared');
  expect((await originals.put({ caseId: CASE, operationId, bytes })).kind).toBe('stored');
  await submissions.markStored(input);
  await submissions.reserveRevision(input);
  expect((await originals.finalize({ caseId: CASE, operationId })).kind).toBe('finalized');
  const manifest = await submissions.commitRevision(input);
  const storedManifestSha256 = sha256(canonicalHash(manifest));
  const refs = o.alias ? ['OD-001', 'OD-002'] : ['OD-001'];
  const textStatus = o.textStatus ?? 'extracted', mediaType = o.mediaType ?? 'application/pdf';
  const built = buildPackage({
    caseId: CASE, inputKind: 'synthetic', sources: [{ role: 'synthetic', name: 'invented', sha256: hash, size: bytes.byteLength }],
    producer: { name: 'synthetic', version: '1' }, created: NOW,
    datasets: [{ key: 'chronology', kind: 'generated', schema: 'v5.chronology@1', required: true,
      provenance: { source: 'synthetic', sourcePath: 'DATA.chronology', adapter: 'test@1' },
      data: refs.map((ref) => ({ ref, n: '1', seq: '1', date: '2001-01-01', filename: 'Letter.pdf', subject: 'Invented <script> content',
        sender: '', to: '', cc: '', excerpt: o.page !== undefined ? `See [[OD-001#p${o.page}]]` : '', doc_type: 'other', bundle: '', amount: '', also_in: [],
        text_status: textStatus, url: '', refs: [], invoice_no: '', size: bytes.byteLength, attachments: [] })),
    }, ...(o.section ? [{ key: 'risk-matrix', kind: 'authored' as const, schema: 'v5.risk-matrix@1', required: true,
      provenance: { source: 'synthetic', sourcePath: 'DATA.riskMatrix', adapter: 'test@1' }, data: [] }] : [])],
    assets: Object.fromEntries([...refs.map((ref) => [ref, { kind: 'file' as const, path: indexedPath, sha256: hash, size: bytes.byteLength, mediaType, textStatus }]),
      ...(o.missing ? [['OD-003', { kind: 'missing' as const, path: 'missing.pdf', mediaType: 'application/pdf', textStatus: 'pending' as const }]] : [])]),
  });
  const prepared = preparePackage(built.files); if (!prepared.ok) throw new Error(JSON.stringify(prepared));
  const facts = await readOriginalFacts({ db, bucket, budgets: BUDGETS, clientId: CLIENT }, CASE, prepared.fileAssets);
  if (facts.kind !== 'ok') throw new Error('fixture originals');
  const validation = validateHostedPackage({ files: built.files, originals: facts.facts, limits: LIMITS });
  if (validation.result.verdict === 'reject') throw new Error(JSON.stringify(validation.result.diagnostics));
  const c = validation.result.candidate, rv = resultsVersion(c.resultsVersion);
  const projected = prepared.project(facts.facts); if (!projected.ok) throw new Error('fixture projection');
  expect((await createResultsStaging(ctx).stage({ caseId: CASE, operationId: 'stage-one', files: built.files,
    identity: { resultsVersion: rv, manifestSha256: c.manifestSha256 }, validation: validation.result, projection: projected.projection })).kind).toBe('stored');
  const submission = { state: 'finalized' as const, manifest, storedManifestSha256, storedManifestBytes: utf8(canonicalText(manifest)).byteLength };
  const coverage = buildCoverage({ assets: c.assets, submission, caseMismatch: validation.caseMismatch, warningFingerprints: validation.result.warningFingerprints });
  if (!coverage.ok) throw new Error(JSON.stringify(coverage));
  const link: CandidateImportLink = { format: 'clearcase.candidate-import-link/1', linkId: 'link-synthetic', clientId: CLIENT, caseId: CASE,
    submissionRevisionId: manifest.revisionId, submissionManifestSha256: storedManifestSha256,
    candidate: { clientId: CLIENT, caseId: CASE, candidateId: 'cand-synthetic', resultsVersion: rv,
      manifestSha256: sha256(c.manifestSha256), packageInputRevisionId: id('input-revision', c.inputRevisionId) }, coverage: coverage.coverage,
    operator: { kind: 'staff', issuer: 'synthetic', subject: 'preparer' }, linkedAt: NOW,
    attribution: 'manual-operator-link-not-processing-proof', state: 'private-candidate-linked' };
  const repository = d1NativeCandidateRepository(db), scope = { clientId: CLIENT, caseId: CASE, candidateId: link.candidate.candidateId };
  await repository.claim({ ...scope, operationId: 'import-one', kind: 'import', operator: link.operator, requestSha256: hash,
    submissionRevisionId: manifest.revisionId, baseCandidateId: null, at: NOW });
  await repository.record({ ...scope, operationId: 'import-one', origin: 'import', parentCandidateId: null, link, correction: null,
    auditEvent: await candidateAuditEvent({ origin: 'import', candidateId: scope.candidateId, link }, id('session', 'prepare-session')) });
  if (o.settled !== false) await repository.settleAudit(await repository.auditIntent(scope));
  const state = { session: true, grant: true, audit: true, authorityHook: null as (() => void) | null, auditHook: null as (() => void) | null };
  const events: AuditEvent[] = [], calls: CaseOperation[] = [], checkerCalls: Parameters<NativePreviewRenderChecker['verify']>[0][] = [];
  const identity: Identity = { clientId: CLIENT, kind: 'verified', principal: { issuer: 'synthetic', subject: 'distinct-reviewer', kind: 'staff' }, sessionId: id('session', 'review-session'),
    async checkRevocation() { if (!state.session) throw contractError('invalid-session'); },
    async authorize(a) { calls.push(a.operation); state.authorityHook?.(); if (!state.grant || a.caseId !== CASE || a.operation !== 'read-preview') throw contractError('forbidden'); } };
  const checker: NativePreviewRenderChecker = { async verify(a) { checkerCalls.push(a); return { state: 'rendered', rendererVersion: 'UNIT-DOUBLE-NOT-ACCEPTANCE', pages: 1, reason: null }; } };
  const options: PublicationMaterialOptions = { db, bucket, clientId: CLIENT, identity, storageBudgets: BUDGETS, validationLimits: { ...LIMITS }, renderChecker: checker,
    audit: { async append(e) { state.auditHook?.(); if (!state.audit) throw contractError('audit-unavailable'); events.push(e); return { eventId: e.eventId }; } }, now: () => new Date(NOW) };
  const verifiedFacts = facts.facts;
  async function supersede() {
    const inspected = inspectPackage(built.files, CASE); if (!inspected.ok) throw new Error('fixture inspect');
    const correction = buildCorrection(inspected.value, [{ key: 'risk-matrix', data: [{ issue: 'Synthetic correction', likelihood: 'low', impact: 'low', mitigation: 'Reviewed' }] }], NOW);
    if (!correction.ok) throw new Error('use section fixture for a genuine authored correction');
    const fresh = validateHostedPackage({ files: correction.files, originals: verifiedFacts, limits: LIMITS });
    if (fresh.result.verdict === 'reject') throw new Error('fixture correction rejected');
    const prep = preparePackage(correction.files); if (!prep.ok) throw new Error('fixture correction package');
    const projection = prep.project(verifiedFacts); if (!projection.ok) throw new Error('fixture correction projection');
    const next = fresh.result.candidate;
    expect((await createResultsStaging(ctx).stage({ caseId: CASE, operationId: 'stage-two', files: correction.files,
      identity: { resultsVersion: resultsVersion(next.resultsVersion), manifestSha256: next.manifestSha256 },
      validation: fresh.result, projection: projection.projection })).kind).toBe('stored');
    const nextLink: CandidateImportLink = { ...link, linkId: 'link-corrected', candidate: { ...link.candidate,
      candidateId: 'cand-corrected', resultsVersion: resultsVersion(next.resultsVersion), manifestSha256: sha256(next.manifestSha256) } };
    await repository.claim({ ...scope, operationId: 'correct-two', kind: 'correction', operator: link.operator, requestSha256: sha256Hex(utf8('correction')),
      submissionRevisionId: manifest.revisionId, baseCandidateId: scope.candidateId, at: NOW });
    await repository.record({ ...scope, operationId: 'correct-two', origin: 'correction', parentCandidateId: scope.candidateId, link: nextLink,
      correction: { reason: 'Synthetic correction', operator: link.operator, at: NOW, changes: correction.changes },
      auditEvent: await candidateAuditEvent({ origin: 'correction', candidateId: nextLink.candidate.candidateId, link: nextLink }, id('session', 'prepare-session')) });
    const nextScope = { ...scope, candidateId: nextLink.candidate.candidateId };
    await repository.settleAudit(await repository.auditIntent(nextScope));
    return nextScope;
  }
  return { db, bucket, options, read: () => createPublicationMaterialReader(options)!.read(scope), scope, rv, link, validation, events, calls, checkerCalls, checker, state, supersede,
    close: () => db.sqlite.close() };
}
const canonicalHash = (m: unknown) => sha256Hex(utf8(canonicalText(m)));
