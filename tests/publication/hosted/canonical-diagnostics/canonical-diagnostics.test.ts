import { describe, expect, it } from 'vitest';
import { validateHostedPackage } from '../../../../src/lib/case-package/hosted-validation.ts';
import { checkSnapshot } from '../../../../src/lib/publication/hosted/rules.ts';
import type { CandidateSnapshot } from '../../../../src/lib/publication/hosted/ports.ts';
import { factsFor, fixture } from '../../../hosted-foundation/hosted-validation/fixture.ts';
import { CASE_A, MemoryAudit, MemoryCandidates, MemoryPublisher, PREPARER, RV_NEW, SqliteD1, grants, identity, snapshot } from '../doubles.ts';
import { compose, dispatch, ledgerFor } from '../harness.ts';

const ORIGIN = 'https://client-a.clearcase.test';
const F_NEW = 'f'.repeat(32);

function canonicalSnapshot(): CandidateSnapshot {
  const f = fixture();
  const validated = validateHostedPackage({ files: f.files, originals: factsFor(f.docs, f.stored) }).result;
  expect(validated.diagnosticsSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  return snapshot({ validation: {
    ...snapshot().validation,
    diagnosticsSha256: validated.diagnosticsSha256,
    validatorVersion: validated.validatorVersion,
  } });
}

function setup(s: CandidateSnapshot) {
  const db = new SqliteD1(), candidates = new MemoryCandidates();
  candidates.put(s);
  compose({ clientId: 'client-a' as never, authorize: grants([`${PREPARER.subject}:${CASE_A}`, `publisher-q:${CASE_A}`]), candidates,
    publisher: new MemoryPublisher(), ledger: ledgerFor(db), audit: new MemoryAudit(), now: () => new Date('2026-10-25T06:00:00.000Z') });
  return db;
}

function submit(body: unknown) {
  const url = new URL('/operator/publication/case-a/signoffs', ORIGIN);
  return dispatch('signoffs', { request: new Request(url, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    url, params: { caseId: 'case-a' }, locals: { identity: identity() } });
}

function body(s: CandidateSnapshot, diagnosticsSha256 = s.validation.diagnosticsSha256) {
  return { operationId: 'canonical-diagnostics-op-001', candidateId: s.link.candidate.candidateId,
    identity: { linkId: s.link.linkId, submissionRevisionId: s.link.submissionRevisionId, submissionManifestSha256: s.link.submissionManifestSha256,
      resultsVersion: s.link.candidate.resultsVersion, manifestSha256: s.link.candidate.manifestSha256,
      packageInputRevisionId: s.link.candidate.packageInputRevisionId, diagnosticsSha256,
      validatorVersion: s.validation.validatorVersion, snapshotRevision: s.snapshotRevision },
    acknowledgements: [{ fingerprint: F_NEW, reason: 'Reviewed canonical synthetic diagnostic.' }], selfApproval: false };
}

describe('canonical diagnostics digest boundary', () => {
  it('reproduces the genuine canonical validator digest rejection through signoff before the fix', async () => {
    const s = canonicalSnapshot();
    setup(s);
    const response = await submit(body(s));
    expect(response.status).toBe(201);
  });

  it('continues to accept legacy bare SHA-256 records without rewriting them', () => {
    const s = canonicalSnapshot();
    const bare = s.validation.diagnosticsSha256.slice('sha256:'.length);
    expect(checkSnapshot({ ...s, validation: { ...s.validation, diagnosticsSha256: bare } })?.validation.diagnosticsSha256).toBe(bare);
  });

  it.each([
    'SHA256:' + 'a'.repeat(64), 'sha256:' + 'A'.repeat(64), 'sha256:' + 'a'.repeat(63), 'sha256:' + 'a'.repeat(65),
    'sha256:' + 'a'.repeat(64) + ':extra', 'sha256',
  ])('rejects malformed canonical digest %s', (diagnosticsSha256) => {
    const s = canonicalSnapshot();
    expect(checkSnapshot({ ...s, validation: { ...s.validation, diagnosticsSha256 } })).toBeNull();
  });

  it('preserves exact diagnostics identity comparison across bare and tagged forms', async () => {
    const s = canonicalSnapshot();
    setup(s);
    const bare = s.validation.diagnosticsSha256.slice('sha256:'.length);
    const response = await submit(body(s, bare));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'stale-candidate' });
  });
});
