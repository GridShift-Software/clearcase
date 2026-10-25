// Source-owned component checks, NOT native acceptance. Identity and SQLite/R2 transports are explicit doubles;
// request composition, validator, stager, native link repository, audit and material/controller logic are real.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Identity } from '../../../src/lib/server/runtime/contracts.ts';
import type { NativeRequestCompositions } from '../../../src/lib/server/runtime/hosted/compositions.ts';
import { world, caseId } from '../native-stager/world.ts';
import { BUDGETS, QUOTAS, ids } from '../storage/fixture.ts';
import { canonicalBytes } from '../../../src/lib/case-package/canonical.ts';
import { LIMITS } from '../../../src/lib/case-package/limits.ts';
import { sha256Hex } from '../../../src/lib/case-package/hash.ts';
import { hostedServices } from '../../../src/lib/server/runtime/hosted/services.ts';
import { createNativeResultsImport } from '../../../src/lib/results-review/native/service.ts';
import { createPublicationMaterialReader } from '../../../src/lib/server/runtime/hosted/publication-material.ts';
import { createNativePublication } from '../../../src/lib/publication/hosted/controller.ts';
import { checkSnapshot, signoffBlocker } from '../../../src/lib/publication/hosted/rules.ts';
import { auditConfig } from '../../../src/lib/audit/config.ts';
import { provisionAuditBinding } from '../../../src/lib/audit/d1-log.ts';
import type { StorageBudgets } from '../../../src/lib/storage/cloud/budgets.ts';
import { hostedValidationPolicy } from '../../../src/lib/server/runtime/hosted/validation-policy.ts';
import { createHostedCandidateStager } from '../../../src/lib/server/runtime/hosted/candidate-stager.ts';
import * as validation from '../../../src/lib/case-package/hosted-validation.ts';

const bridge = vi.hoisted(() => ({ identity: null as Identity | null, ports: null as NativeRequestCompositions | null }));
vi.mock('../../../src/lib/auth/clerk/provider.ts', () => ({ clerkIdentityProviderFromEnv: () => ({ ok: true,
  config: { clientId: 'client-a', appOrigin: 'https://client-a.test', client: { issuer: 'https://client-issuer.test' }, staff: { issuer: 'https://staff-issuer.test' } },
  provider: { authenticate: async () => bridge.identity },
}) }));
vi.mock('../../../src/lib/server/runtime/hosted/compositions.ts', async (original) => {
  const actual = await original<typeof import('../../../src/lib/server/runtime/hosted/compositions.ts')>();
  return { ...actual, bindNativeRequestCompositions(request: Request, ports: NativeRequestCompositions) {
    bridge.ports = ports; actual.bindNativeRequestCompositions(request, ports);
  } };
});
const worlds: ReturnType<typeof world>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const w of worlds.splice(0)) w.db.sqlite.close(); bridge.ports = null; bridge.identity = null; });
const auditLimits = { maxEventBytes: 4096, maxRows: 1000, maxReadRows: 100, maxDenialRows: 100,
  maxDenialsPerActor: 10, maxPageRows: 20, maxPagesPerRequest: 5 };
const deployment = { clientId: ids.clientA, hostname: 'client-a.test', worker: 'client-a',
  d1DatabaseId: '11111111-1111-1111-1111-111111111111', d1DatabaseName: 'client-a', r2Bucket: 'client-a' };

async function setup(extensionChars: number, budgets: StorageBudgets) {
  const w = world(); worlds.push(w);
  for (const path of ['tenancy/migrations/0001_tenant_case_grants.sql', 'tenancy/migrations/0002_tenant_grant_operations.sql',
    'publication/hosted/migrations/0001_publication_ledger.sql', 'publication/hosted/migrations/0002_atomic_publication.sql',
    'publication/hosted/migrations/0003_provenance_generation.sql', 'audit/migrations/0001_native_audit.sql']) {
    w.db.sqlite.exec(readFileSync(`src/lib/${path}`, 'utf8'));
  }
  const db = Object.assign(w.db, { withSession: (_constraint: 'first-primary') => w.db });
  if (w.identity.kind !== 'verified') throw new Error('synthetic identity');
  const identity: Extract<Identity, { kind: 'verified' }> = { ...w.identity,
    principal: { ...w.identity.principal, issuer: 'https://staff-issuer.test' }, async authorize(a) {
      expect(a.operation).toBe('read-preview'); expect(a.caseId).toBe(caseId);
    } };
  const cfg = auditConfig({ clientId: ids.clientA, trustedIssuers: [identity.principal.issuer, 'https://client-issuer.test'], limits: auditLimits });
  await provisionAuditBinding({ db, config: cfg, now: () => new Date() });
  for (const role of ['operator', 'publisher']) w.db.exec(`INSERT INTO tenant_case_grants
    (grant_id, client_id, scope, case_id, issuer, subject, principal_kind, role, slot, state, expires_at, version,
    created_operation_id, request, created_by_issuer, created_by_subject, created_at)
    VALUES (?, ?, 'case', ?, ?, ?, 'staff', ?, ?, 'active', NULL, 1, ?, '{}', ?, ?, ?)`,
    role, ids.clientA, caseId, identity.principal.issuer, identity.principal.subject, role, role, `grant-${role}`,
    identity.principal.issuer, identity.principal.subject, new Date().toISOString());
  const revision = await w.upload();
  const manifest = JSON.parse(new TextDecoder().decode(w.pkg.files.get('manifest.json')));
  manifest.extensions = { 'x-synthetic': ['x'.repeat(extensionChars), 'y'.repeat(extensionChars)] };
  const manifestBytes = canonicalBytes(manifest);
  w.pkg.files.set('manifest.json', manifestBytes);
  bridge.identity = identity;
  const request = new Request(`https://client-a.test/operator/publication/${caseId}/signoffs`);
  const settings = { schema: 'clearcase.native-runtime/1', deployment,
    manifest: { staffIssuer: identity.principal.issuer, clients: [{ ...deployment, clientIssuer: 'https://client-issuer.test' }] },
    auditLimits, storageBudgets: budgets, storageQuotas: QUOTAS,
    userWorkLimits: { maxStatementsPerBatch: 20, maxSnapshotBytes: 1 << 20 },
    intakeBudget: { maxFileBytes: budgets.maxOriginalBytes, maxMetadataBytes: 4096 },
    importBudget: { maxFiles: budgets.maxPackageFiles, maxFileBytes: budgets.maxPackageFileBytes,
      maxPackageBytes: budgets.maxPackageBytes, maxRequestBytes: 16 << 20 } };
  const compose = async (storage: unknown = budgets): Promise<NativeRequestCompositions | null> => {
    bridge.ports = null;
    await hostedServices(request, { CLEARCASE_CLIENT_ID: ids.clientA, DB: db, BUCKET: w.bucket,
      CLEARCASE_NATIVE_CONFIG: JSON.stringify({ ...settings, storageBudgets: storage }) });
    const ports: NativeRequestCompositions | null = bridge.ports;
    return ports;
  };
  return { w, db, identity, revision, manifest, manifestBytes, request, compose };
}

async function imported(s: Awaited<ReturnType<typeof setup>>) {
  const ports = await s.compose();
  if (!ports?.imports || !ports.publication?.candidates) throw new Error('real composition unavailable');
  const importer = createNativeResultsImport(ports.imports)!;
  const token = await importer.admit({ identity: s.identity, caseId, access: 'write' });
  const result = await importer.importPackage(token, { operationId: 'shared-policy-import',
    submissionRevisionId: s.revision, files: s.w.pkg.files });
  expect(result.kind).toBe('linked');
  if (result.kind !== 'linked') throw new Error(JSON.stringify(result));
  return { ports, publication: ports.publication, reader: ports.publication.candidates, result, scope: { clientId: ids.clientA, caseId, candidateId: result.candidate.candidateId } };
}

describe('composed import and publication share effective validation policy', () => {
  it('reads a genuine immutable >1 MiB manifest imported under an explicit 2 MiB file budget, still renderer-held', async () => {
    const budgets = { ...BUDGETS, maxPackageFileBytes: 2 << 20 };
    const s = await setup(700_000, budgets);
    expect(s.manifestBytes.byteLength).toBeGreaterThan(LIMITS.manifestBytes);
    expect(s.manifestBytes.byteLength).toBeLessThan(budgets.maxPackageFileBytes);
    const observed = vi.spyOn(validation, 'validateHostedPackage'); // observe calls; run the genuine validator unchanged
    const { publication, reader, result, scope } = await imported(s);
    const importedPolicies = observed.mock.calls.map(([input]) => input.limits);
    expect(importedPolicies).toHaveLength(3); // bootstrap, independent original facts, immutable stored readback
    expect(importedPolicies.every((policy) => policy === importedPolicies[0])).toBe(true);
    expect(importedPolicies[0]).toEqual(hostedValidationPolicy(budgets));
    const before = s.db.rows<{ verdict: string; validator_version: string; diagnostics_sha256: string; warning_fingerprints: string }>('SELECT * FROM rs_results_version');
    // The old policy really is incompatible with the successfully linked immutable candidate.
    const old = createPublicationMaterialReader({ db: s.db, bucket: s.w.bucket, clientId: ids.clientA, identity: s.identity,
      storageBudgets: budgets, validationLimits: { ...LIMITS }, renderChecker: null, audit: s.w.config.audit, now: s.w.config.now })!;
    await expect(old.read(scope)).rejects.toMatchObject({ code: 'integrity' });
    observed.mockClear();
    const snapshot = checkSnapshot(await reader.read(scope));
    expect(observed.mock.calls).toHaveLength(1);
    expect(observed.mock.calls[0][0].limits).toEqual(importedPolicies[0]); // all six resources AND every fixed parser rule
    expect(snapshot).not.toBeNull();
    if (!snapshot) throw new Error('material unavailable');
    expect(snapshot.link.candidate).toEqual(result.candidate.link.candidate);
    expect(snapshot.link.candidate.resultsVersion).toBe(s.manifest.resultsVersion);
    expect(snapshot.link.candidate.manifestSha256).toBe(sha256Hex(s.manifestBytes));
    expect(snapshot.validation).toEqual({ verdict: before[0].verdict, validatorVersion: before[0].validator_version,
      diagnosticsSha256: before[0].diagnostics_sha256, errorFingerprints: [], warningFingerprints: JSON.parse(before[0].warning_fingerprints) });
    expect(s.db.rows('SELECT * FROM rs_results_version')).toEqual(before);
    expect(snapshot.requiredPreviews).toEqual([{ assetId: 'OD-001', state: 'pending' }]);
    expect(signoffBlocker(snapshot)?.code).toBe('preview-not-ready');
    const body = { operationId: 'shared-policy-signoff', candidateId: scope.candidateId,
      identity: { linkId: snapshot.link.linkId, submissionRevisionId: snapshot.link.submissionRevisionId,
        submissionManifestSha256: snapshot.link.submissionManifestSha256, resultsVersion: snapshot.link.candidate.resultsVersion,
        manifestSha256: snapshot.link.candidate.manifestSha256, packageInputRevisionId: snapshot.link.candidate.packageInputRevisionId,
        diagnosticsSha256: snapshot.validation.diagnosticsSha256, validatorVersion: snapshot.validation.validatorVersion,
        snapshotRevision: snapshot.snapshotRevision },
      acknowledgements: snapshot.validation.warningFingerprints.map((fingerprint) => ({ fingerprint, reason: 'Reviewed synthetic warning' })), selfApproval: false };
    const request = new Request(s.request.url, { method: 'POST', headers: { origin: 'https://client-a.test', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const response = await createNativePublication(publication).signOff({ request, url: new URL(request.url),
      identity: s.identity, params: { caseId } });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'preview-not-ready' });
    expect(s.db.rows('SELECT * FROM pub_signoff')).toEqual([]);
    expect(s.db.rows('SELECT * FROM pub_apply_receipt')).toEqual([]);
    expect(s.db.rows('SELECT * FROM rs_publication')).toEqual([]);
  });

  it.each([
    { ...BUDGETS, maxPackageFiles: 16, maxPackageFileBytes: 64 << 10, maxPackageBytes: 1 << 20, maxOriginalBytes: 64 << 10, maxVerifyBytes: 4 << 20 },
    { ...BUDGETS, maxPackageFiles: 128, maxPackageFileBytes: 2 << 20, maxPackageBytes: 8 << 20, maxOriginalBytes: 2 << 20,
      maxBufferedObjectBytes: 2 << 20, maxVerifyBytes: 32 << 20 },
  ])('keeps smaller/larger valid resource bounds %j and canonical identity without policy drift', async (budgets) => {
    const s = await setup(1000, budgets);
    const observed = vi.spyOn(validation, 'validateHostedPackage');
    const { reader, result, scope } = await imported(s);
    const snapshot = checkSnapshot(await reader.read(scope));
    expect(snapshot?.link.candidate).toEqual(result.candidate.link.candidate);
    expect(snapshot?.validation.errorFingerprints).toEqual([]);
    expect(snapshot?.requiredPreviews[0].state).toBe('pending');
    expect(observed.mock.calls).toHaveLength(4);
    for (const [input] of observed.mock.calls) expect(input.limits).toEqual(hostedValidationPolicy(budgets));
  });

  it('captures stager and reader policies before caller mutations across awaits', async () => {
    const budgets = { ...BUDGETS, maxPackageFileBytes: 2 << 20 };
    const s = await setup(700_000, budgets);
    const { reader: composedReader, scope } = await imported(s);
    const snapshot = checkSnapshot(await composedReader.read(scope));
    const mutable = { ...budgets }, limits = { ...hostedValidationPolicy(budgets)! };
    const reader = createPublicationMaterialReader({ db: s.db, bucket: s.w.bucket, clientId: ids.clientA, identity: s.identity,
      storageBudgets: mutable, validationLimits: limits, renderChecker: null, audit: s.w.config.audit, now: s.w.config.now })!;
    const submission = await s.w.submissions.finalized({ clientId: ids.clientA, caseId, revisionId: s.revision });
    if (submission.state !== 'finalized' || !snapshot) throw new Error('fixture');
    const stager = createHostedCandidateStager({ ...s.w.config, budgets: mutable });
    const request = { clientId: ids.clientA, caseId, operationId: 'captured-stage', submission, files: s.w.pkg.files,
      identity: { resultsVersion: snapshot.link.candidate.resultsVersion, manifestSha256: snapshot.link.candidate.manifestSha256 } };
    // These caller objects are no longer the policies owned by either factory.
    mutable.maxPackageFileBytes = 1; mutable.maxVerifyBytes = 1; limits.manifestBytes = 1;
    expect((await stager.stager.stage(request)).kind).toBe('staged');
    expect(checkSnapshot(await reader.read(scope))?.validation).toEqual(snapshot.validation);
    const small = { ...BUDGETS, maxPackageFileBytes: 64 << 10 };
    const bounded = createHostedCandidateStager({ ...s.w.config, budgets: small });
    small.maxPackageFileBytes = 2 << 20;
    expect(await bounded.stager.stage(request)).toEqual({ kind: 'refused', reason: 'over-budget', detail: ['package exceeds file count or byte budget'] });
  });

  it('does not compose imports or publication for omitted, malformed or inconsistent storage budgets', async () => {
    const s = await setup(1000, BUDGETS);
    for (const key of Object.keys(BUDGETS)) {
      const missing: Record<string, unknown> = { ...BUDGETS }; delete missing[key];
      expect(await s.compose(missing)).toBeNull();
      expect(await s.compose({ ...BUDGETS, [key]: 0 })).toBeNull();
    }
    expect(await s.compose({ ...BUDGETS, maxPackageFileBytes: BUDGETS.maxPackageBytes + 1 })).toBeNull();
    expect(await s.compose({ ...BUDGETS, maxOriginalBytes: BUDGETS.maxBufferedObjectBytes + 1 })).toBeNull();
    expect(await s.compose({ ...BUDGETS, maxVerifyBytes: BUDGETS.maxVerifyBytesPerCaseWindow + 1 })).toBeNull();
    expect(await s.compose({ ...BUDGETS, maxVerifyObjects: BUDGETS.maxVerifyObjectsPerCaseWindow + 1 })).toBeNull();
  });

  it('refuses an over-budget manifest before linking rather than silently restoring parser/allocation defaults', async () => {
    const s = await setup(700_000, { ...BUDGETS });
    const ports = await s.compose();
    const importer = createNativeResultsImport(ports!.imports!)!;
    const token = await importer.admit({ identity: s.identity, caseId, access: 'write' });
    expect(await importer.importPackage(token, { operationId: 'bounded-import', submissionRevisionId: s.revision, files: s.w.pkg.files }))
      .toEqual({ kind: 'refused', code: 'validator-refused', detail: ['over-budget', 'package exceeds file count or byte budget'] });
    expect(s.db.rows('SELECT * FROM rs_results_version')).toEqual([]);
    expect(s.db.rows('SELECT * FROM native_candidate')).toEqual([]);
  });
});
