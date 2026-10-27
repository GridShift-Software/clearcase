// Component-level checks added with the implementation (the adverse HTTP contract is adverse.test.ts, byte-identical to
// RED apart from the disclosed test-only fixes): hosted-safe hash equivalence with the library, the budget, the finalized
// submission reader, the D1 repository's lost-answer recovery, and DB-level lineage guards the service also enforces.
import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalText } from '../../../src/lib/case-package/canonical.ts';
import { inputRevisionId, resultsVersionOf, sha256Hex } from '../../../src/lib/case-package/hash.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { candidateIdOf, d1NativeCandidateRepository, linkDigest, linkIdOf, nativeImportBudget, submissionSnapshotReader, type NativeD1 } from '../../../src/lib/results-review/native/index.ts';
import { CASE_A, CASE_B, CLIENT, SqliteD1, finalizeSubmission } from './doubles.ts';
import { pdf, shaOf, buildFixture, asText } from './fixtures.ts';
import { sha256Bytes, sha256Canonical, sha256Text } from '../../../src/lib/results-review/native/digest.ts';
import { MIGRATIONS, compose, dispatch, world, type Route } from './harness.ts';
import { who } from './doubles.ts';

const utf8 = (s: string) => new TextEncoder().encode(s);
let n = 0;
const op = () => `op-u${String(++n).padStart(4, '0')}-0b7c2f3e1d2a4c5b`;
const ev = (path: string, method: string, params: Record<string, string>, body?: unknown) => {
  const url = new URL(path, 'https://client-a.clearcase.test');
  const headers = new Headers(body === undefined ? {} : { origin: url.origin, 'content-type': 'application/json' });
  return { request: new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), url, params, locals: { identity: who() } };
};
const call = (route: Route, method: string, path: string, params: Record<string, string>, body?: unknown) => dispatch(route, method, ev(path, method, params, body));

describe('hosted-safe hashing equals the library, byte for byte', () => {
  it('sha256 over bytes, text and canonical JSON equals sha256Hex of the library encoding', async () => {
    const value = { b: [3, 1, { z: 'é', a: null }], a: 'x\u0000y', 10: 1, 9: 2 };
    expect(await sha256Bytes(utf8('abc'))).toBe(sha256Hex(utf8('abc')));
    expect(await sha256Text('héllo')).toBe(sha256Hex('héllo'));
    expect(await sha256Canonical(value)).toBe(sha256Hex(canonicalJson(value)));
    expect(await sha256Canonical(value)).toBe(sha256Hex(utf8(canonicalJson(value))));
  });

  it('the submission manifest digest is the library sha256 of the library canonical text', async () => {
    const db = new SqliteD1(MIGRATIONS), file = { path: 'Letters/A.pdf', bytes: pdf('a') };
    const m = await finalizeSubmission(db, { operationId: op(), file });
    const snap = await submissionSnapshotReader(db).finalized({ clientId: CLIENT, caseId: CASE_A, revisionId: m.revisionId });
    if (snap.state !== 'finalized') throw new Error('not finalized');
    expect(snap.storedManifestSha256).toBe(sha256Hex(canonicalText(m)));
    expect(snap.storedManifestBytes).toBe(utf8(canonicalText(m)).byteLength);
  });

  it('a package identity is the library formula: the module recomputes nothing, so the manifest values are the library\'s own', () => {
    const fx = buildFixture({ docs: [{ ref: 'OD-001', path: 'Letters/A.pdf', bytes: pdf('a') }] });
    expect(inputRevisionId(fx.manifest.inputRevision.sources)).toBe(fx.manifest.inputRevision.id);
    expect(resultsVersionOf({ formatVersion: 1, caseId: 'case-a', inputRevisionId: fx.manifest.inputRevision.id, files: fx.manifest.files })).toBe(fx.manifest.resultsVersion);
  });

  it('derives candidate and link ids deterministically from their pins only', async () => {
    const a = { clientId: 'client-a', caseId: 'case-a', resultsVersion: `sha256:${'1'.repeat(64)}`, manifestSha256: '2'.repeat(64) };
    expect(await candidateIdOf(a)).toBe(await candidateIdOf({ ...a }));
    expect(await candidateIdOf(a)).not.toBe(await candidateIdOf({ ...a, caseId: 'case-b' }));
    expect(await candidateIdOf(a)).not.toBe(await candidateIdOf({ ...a, manifestSha256: '3'.repeat(64) }));
    const c = await candidateIdOf(a);
    expect(await linkIdOf({ candidateId: c, submissionRevisionId: 'r1', submissionManifestSha256: '4'.repeat(64) })).not.toBe(await linkIdOf({ candidateId: c, submissionRevisionId: 'r1', submissionManifestSha256: '5'.repeat(64) }));
  });
});

describe('the import budget has no default', () => {
  const good = { maxRequestBytes: 1 << 20, maxFiles: 16, maxFileBytes: 1 << 19, maxPackageBytes: 1 << 20 };
  it('accepts an exact, positive budget as an object or JSON text, and nothing else', () => {
    expect(nativeImportBudget(good)).toEqual(good);
    expect(nativeImportBudget(JSON.stringify(good))).toEqual(good);
    for (const bad of [undefined, null, '', '{', [], {}, { ...good, extra: 1 }, { ...good, maxFiles: 0 }, { ...good, maxFileBytes: 1.5 }, { ...good, maxFileBytes: good.maxPackageBytes + 1 }, { ...good, maxFiles: 8193 }]) expect(nativeImportBudget(bad)).toBeNull();
    expect(nativeImportBudget(good, { stagerMaxPackageBytes: good.maxPackageBytes - 1 })).toBeNull();
  });
});

describe('the finalized submission reader', () => {
  it('yields a manifest only for the case\'s own finalized upload', async () => {
    const db = new SqliteD1(MIGRATIONS);
    const fin = await finalizeSubmission(db, { operationId: op(), file: { path: 'Letters/A.pdf', bytes: pdf('a') } });
    const res = await finalizeSubmission(db, { operationId: op(), file: { path: 'Letters/B.pdf', bytes: pdf('b') }, finalize: false });
    const theirs = await finalizeSubmission(db, { caseId: CASE_B, operationId: op(), file: { path: 'Letters/C.pdf', bytes: pdf('c') } });
    const r = submissionSnapshotReader(db);
    const read = (revisionId: string, caseId = CASE_A) => r.finalized({ clientId: CLIENT, caseId, revisionId });
    expect((await read(fin.revisionId)).state).toBe('finalized');
    expect(await read(res.revisionId)).toEqual({ state: 'not-final' });
    expect(await read(theirs.revisionId)).toEqual({ state: 'absent' });
    expect(await read('subrev-op-nothing-000000000000')).toEqual({ state: 'absent' });
  });
});

describe('the D1 repository recovers from a lost answer and refuses to report a fault as success', () => {
  async function linked() {
    const w = world();
    const file = { path: 'Letters/Claim.pdf', bytes: pdf('claim') };
    const m = await finalizeSubmission(w.db, { operationId: op(), file });
    w.stager.folder = new Map([[file.path, file.bytes]]);
    const fx = buildFixture({ docs: [{ ref: 'OD-001', ...file }] });
    const r = await call('imports', 'POST', '/operator/results/case-a/imports', { caseId: 'case-a' }, { operationId: op(), submissionRevisionId: m.revisionId, files: asText(fx.files) });
    expect(r.status).toBe(201);
    return { w, fx, m, view: ((await r.json()) as { candidate: { candidateId: string; link: Parameters<typeof linkDigest>[0] } }).candidate };
  }
  const scope = { clientId: CLIENT, caseId: CASE_A };

  it('a stored link re-hashes to the digest written with it', async () => {
    const { w, view } = await linked();
    const row = w.db.rows<{ link_sha256: string }>('SELECT link_sha256 FROM native_import_link')[0];
    expect(await linkDigest(view.link)).toBe(row.link_sha256);
  });

  it('a batch that commits and then reports a fault is recovered by readback, not retried into a duplicate', async () => {
    const w = world();
    const lossy: NativeD1 = {
      prepare: (sql) => (w.db as unknown as NativeD1).prepare(sql),
      batch: async (s) => { await (w.db as unknown as NativeD1).batch(s); throw new Error('lost answer after commit'); },
    };
    w.ports.repository = d1NativeCandidateRepository(lossy);
    compose(w.ports);
    const file = { path: 'Letters/Claim.pdf', bytes: pdf('claim') };
    const m = await finalizeSubmission(w.db, { operationId: op(), file });
    w.stager.folder = new Map([[file.path, file.bytes]]);
    const fx = buildFixture({ docs: [{ ref: 'OD-001', ...file }] });
    const r = await call('imports', 'POST', '/operator/results/case-a/imports', { caseId: 'case-a' }, { operationId: op(), submissionRevisionId: m.revisionId, files: asText(fx.files) });
    expect(r.status).toBe(201);
    expect(w.db.rows('SELECT 1 FROM native_import_link')).toHaveLength(1);
    expect(w.db.rows('SELECT 1 FROM native_candidate')).toHaveLength(1);
  });

  it('a rejected batch with nothing recorded is a storage fault (503), and the same operation then succeeds', async () => {
    const w = world();
    const file = { path: 'Letters/Claim.pdf', bytes: pdf('claim') };
    const m = await finalizeSubmission(w.db, { operationId: op(), file });
    w.stager.folder = new Map([[file.path, file.bytes]]);
    const fx = buildFixture({ docs: [{ ref: 'OD-001', ...file }] });
    const body = { operationId: op(), submissionRevisionId: m.revisionId, files: asText(fx.files) };
    w.db.failNext = /INSERT INTO native_import_link/;
    const first = await call('imports', 'POST', '/operator/results/case-a/imports', { caseId: 'case-a' }, body);
    expect(first.status).toBe(503);
    expect(w.db.rows('SELECT 1 FROM native_import_link')).toHaveLength(0);
    expect(w.db.rows('SELECT 1 FROM native_candidate')).toHaveLength(0);
    const second = await call('imports', 'POST', '/operator/results/case-a/imports', { caseId: 'case-a' }, body);
    expect(second.status).toBe(201);
    expect(w.db.rows('SELECT 1 FROM native_import_link')).toHaveLength(1);
  });

  it('refuses at the database a second correction from an already superseded parent, whatever the service does', async () => {
    const { w, view } = await linked();
    const fix = { operationId: op(), reason: 'fix', replacements: [{ key: 'matter', data: { title: 'T', short: 'M', forum: 'F', storyline: [], strategy: [] } }] };
    const r = await call('corrections', 'POST', `/operator/results/case-a/candidates/${view.candidateId}/corrections`, { caseId: 'case-a', candidateId: view.candidateId }, fix);
    expect(r.status).toBe(201);
    const opId = op();
    w.db.exec("INSERT INTO native_import_attempt (client_id, case_id, operation_id, kind, operator_issuer, operator_subject, request_sha256, submission_revision_id, base_candidate_id, declared_at) VALUES ('client-a', 'case-a', ?, 'correction', 'https://issuer.test', 'operator-1', ?, 'x', ?, '2026-10-25T06:00:00.000Z')", opId, '0'.repeat(64), view.candidateId);
    expect(() => w.db.exec("INSERT INTO native_candidate (client_id, case_id, candidate_id, results_version, manifest_sha256, input_revision_id, origin, parent_candidate_id, operation_id, created_at) VALUES ('client-a', 'case-a', 'cand-fork', ?, ?, 'sha256:x', 'correction', ?, ?, '2026-10-25T06:00:00.000Z')", `sha256:${'d'.repeat(64)}`, 'e'.repeat(64), view.candidateId, opId)).toThrow();
    expect(w.db.rows('SELECT 1 FROM native_candidate')).toHaveLength(2);
  });

  it('refuses at the database a second supersession of one parent or a supersession by a non-correction', async () => {
    const { w, view } = await linked();
    const ins = (o: string, nw: string) => w.db.exec("INSERT INTO native_candidate_supersession (client_id, case_id, old_candidate_id, new_candidate_id, reason, operator_issuer, operator_subject, at) VALUES ('client-a', 'case-a', ?, ?, 'r', 'i', 's', '2026-10-25T06:00:00.000Z')", o, nw);
    expect(() => ins(view.candidateId, view.candidateId)).toThrow();
    expect(() => ins(view.candidateId, 'cand-nothing')).toThrow();
    expect(w.db.rows('SELECT 1 FROM native_candidate_supersession')).toHaveLength(0);
    expect(id('client', 'client-a')).toBeTruthy();
  });
});

describe('a correction pins the submission it was linked to', () => {
  it('refuses when the submission reader no longer returns the stored manifest bytes SHA the link pinned', async () => {
    const file = { path: 'Letters/Claim.pdf', bytes: pdf('claim') };
    const state = { sha: '' };
    const manifest = (rev: string) => ({ format: 'clearcase.submission-manifest/1' as const, clientId: CLIENT, caseId: CASE_A, revisionId: rev, sequence: 1, operationId: 'op-mutable-000000001', finalizedAt: '2026-10-25T05:00:00.000Z', files: [{ path: file.path, filename: 'Claim.pdf', mediaType: 'application/pdf', size: file.bytes.byteLength, sha256: shaOf(file.bytes), assetId: 'sub-1' }] });
    const reader = { finalized: async (a: { revisionId: string }) => (a.revisionId === 'subrev-mutable' ? { state: 'finalized', manifest: manifest('subrev-mutable'), storedManifestSha256: state.sha || sha256Hex(canonicalText(manifest('subrev-mutable'))), storedManifestBytes: 10 } : { state: 'absent' }) };
    const w = world({ submissions: reader });
    w.stager.folder = new Map([[file.path, file.bytes]]);
    const fx = buildFixture({ docs: [{ ref: 'OD-001', ...file }] });
    const made = await call('imports', 'POST', '/operator/results/case-a/imports', { caseId: 'case-a' }, { operationId: op(), submissionRevisionId: 'subrev-mutable', files: asText(fx.files) });
    expect(made.status).toBe(201);
    const c = ((await made.json()) as { candidate: { candidateId: string } }).candidate;
    state.sha = 'f'.repeat(64);
    const r = await call('corrections', 'POST', `/operator/results/case-a/candidates/${c.candidateId}/corrections`, { caseId: 'case-a', candidateId: c.candidateId },
      { operationId: op(), reason: 'fix', replacements: [{ key: 'matter', data: { title: 'T', short: 'M', forum: 'F', storyline: [], strategy: [] } }] });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe('submission-changed');
    expect(w.db.rows('SELECT 1 FROM native_candidate')).toHaveLength(1);
  });
});
