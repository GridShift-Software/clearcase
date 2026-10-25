// Native private processed-package import: the adverse contract of the operator routes. Synthetic bytes only. The package
// builder, the validator and the byte verifier are the real case-package library; storage, identity, the original store and
// audit are unit doubles (doubles.ts), so a pass here is component evidence, not a hosted or Cloudflare PASS.
import { describe, expect, it } from 'vitest';
import { canonicalText } from '../../../src/lib/case-package/canonical.ts';
import { sha256Hex } from '../../../src/lib/case-package/hash.ts';
import type { CaseId, ClientId, Identity } from '../../../src/lib/server/runtime/contracts.ts';
import { CASE_A, CASE_B, CLIENT, NOW, finalizeSubmission, trackedBody, who, type SubmittedFile } from './doubles.ts';
import { asText, buildFixture, fromText, pdf, shaOf, type Doc, type Fixture } from './fixtures.ts';
import { BUDGET, compose, dispatch, world, type Route, type World } from './harness.ts';

const ORIGIN = 'https://client-a.clearcase.test';
const utf8 = (s: string) => new TextEncoder().encode(s);
let seq = 0;
const op = () => `op-${String(++seq).padStart(4, '0')}-0b7c2f3e1d2a4c5b`;

type Init = { origin?: string | null; contentType?: string; body?: BodyInit | ReadableStream<Uint8Array>; who?: Identity };
function event(path: string, method: string, init: Init, params: Record<string, string>) {
  const url = new URL(path, ORIGIN), headers = new Headers();
  if (init.origin !== null && method !== 'GET') headers.set('origin', init.origin ?? ORIGIN);
  if (init.contentType) headers.set('content-type', init.contentType);
  const request = new Request(url, { method, headers, body: init.body as BodyInit, ...(init.body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit);
  return { request, url, params, locals: { identity: init.who ?? who() } };
}
const json = (v: unknown) => ({ contentType: 'application/json', body: JSON.stringify(v) });
const call = (route: Route, method: string, path: string, params: Record<string, string>, init: Init = {}) => dispatch(route, method, event(path, method, init, params));
const importPkg = (caseId: string, body: unknown, init: Init = {}) => call('imports', 'POST', `/operator/results/${caseId}/imports`, { caseId }, { ...json(body), ...init });
const correct = (caseId: string, candidateId: string, body: unknown, init: Init = {}) =>
  call('corrections', 'POST', `/operator/results/${caseId}/candidates/${candidateId}/corrections`, { caseId, candidateId }, { ...json(body), ...init });
const readOne = (caseId: string, candidateId: string, who?: Identity) => call('candidate', 'GET', `/operator/results/${caseId}/candidates/${candidateId}`, { caseId, candidateId }, { who });
const listAll = (caseId: string, who?: Identity) => call('candidates', 'GET', `/operator/results/${caseId}/candidates`, { caseId }, { who });
const code = async (r: Response) => { try { return ((await r.clone().json()) as { code: string }).code; } catch { return `non-JSON ${r.status}`; } };

interface LinkView {
  candidateId: string; origin: 'import' | 'correction'; parentCandidateId: string | null; current: boolean; supersededBy: string | null;
  correction: null | { reason: string; operator: { issuer: string; subject: string }; at: string; changes: { path: string; before: { sha256: string; size: number } | null; after: { sha256: string; size: number } }[] };
  link: {
    format: string; linkId: string; clientId: string; caseId: string; submissionRevisionId: string; submissionManifestSha256: string;
    candidate: { clientId: string; caseId: string; candidateId: string; resultsVersion: string; manifestSha256: string; packageInputRevisionId: string };
    coverage: { policy: string; mappedOriginals: { packageRefs: string[]; packagePath: string; storedPath: string; submissionAssetId: string; sha256: string; size: number; pathMatch: string; preservedWarning?: { code: string; fingerprints: string[] } }[]; unavailableOriginals: Record<string, string>[] };
    operator: { issuer: string; subject: string; kind: string }; linkedAt: string; attribution: string; state: string;
  };
}
const linked = async (r: Response) => {
  expect([200, 201]).toContain(r.status);
  return (await r.clone().json() as { kind: string; repeated: boolean; candidate: LinkView }).candidate;
};
const rows = (w: World, table: string) => w.db.rows<Record<string, unknown>>(`SELECT * FROM ${table}`);
const counts = (w: World) => Object.fromEntries(['native_import_attempt', 'native_candidate', 'native_import_link', 'native_candidate_supersession', 'native_correction_change'].map((t) => [t, rows(w, t).length]));

const CLAIM: Doc = { ref: 'OD-001', path: 'Letters/Claim.pdf', bytes: pdf('claim') };
interface Ready { w: World; fx: Fixture; revisionId: string; manifest: Awaited<ReturnType<typeof finalizeSubmission>>; body: { operationId: string; submissionRevisionId: string; files: Record<string, string> } }
/** A world with one finalized one-file submission and a package whose single required original is that file. */
async function ready(o: { configured?: boolean; docs?: readonly Doc[]; submitted?: SubmittedFile; fx?: Parameters<typeof buildFixture>[0]; submissions?: unknown; operate?: readonly CaseId[]; null?: string | null } = {}): Promise<Ready> {
  const w = world({ operate: o.operate, null: o.null, submissions: o.submissions, configured: o.configured });
  const docs = o.docs ?? [CLAIM];
  const submitted = o.submitted ?? { path: docs[0].path, bytes: docs[0].bytes };
  const manifest = await finalizeSubmission(w.db, { operationId: op(), file: submitted });
  w.stager.folder = new Map([[submitted.path, submitted.bytes]]);
  const fx = buildFixture({ docs, ...o.fx });
  return { w, fx, revisionId: manifest.revisionId, manifest, body: { operationId: op(), submissionRevisionId: manifest.revisionId, files: asText(fx.files) } };
}
const submissionSha = (m: { [k: string]: unknown }) => shaOf(utf8(canonicalText(m)));

describe('authority is decided before any body byte, row, object or stager call', () => {
  it('refuses an anonymous caller with 401 and never pulls the body', async () => {
    const r0 = await ready(), t = trackedBody(utf8(JSON.stringify(r0.body)));
    const r = await importPkg('case-a', {}, { body: t.stream, who: who({ kind: 'anonymous' }) });
    expect(r.status).toBe(401);
    expect(await code(r)).toBe('unauthenticated');
    expect(t.state.pulled).toBe(0);
    expect(r0.w.stager.calls).toHaveLength(0);
    expect(counts(r0.w)).toEqual({ native_import_attempt: 0, native_candidate: 0, native_import_link: 0, native_candidate_supersession: 0, native_correction_change: 0 });
  });

  it('refuses a session of another client with 401 wrong-client', async () => {
    const { w, body } = await ready();
    const r = await importPkg('case-a', body, { who: who({ clientId: 'client-b' as ClientId }) });
    expect(r.status).toBe(401);
    expect(await code(r)).toBe('wrong-client');
    expect(w.operateCalls).toHaveLength(0);
  });

  it('refuses a revoked session with 401 before the capability is asked', async () => {
    const { w, body } = await ready();
    const r = await importPkg('case-a', body, { who: who({ revoked: true }) });
    expect(r.status).toBe(401);
    expect(w.operateCalls).toHaveLength(0);
  });

  it('refuses a client principal with 403 even if the case grant would allow it: a client never imports a candidate', async () => {
    const { w, body } = await ready();
    const t = trackedBody(utf8(JSON.stringify(body)));
    const r = await importPkg('case-a', {}, { body: t.stream, who: who({ principalKind: 'client' }) });
    expect(r.status).toBe(403);
    expect(await code(r)).toBe('forbidden');
    expect(t.state.pulled).toBe(0);
    expect(w.stager.calls).toHaveLength(0);
    expect(rows(w, 'native_import_link')).toHaveLength(0);
  });

  it('gives an unknown case and a case without the operate capability the same 403', async () => {
    const { w, body } = await ready({ operate: [CASE_A] });
    const noCap = await importPkg('case-b', body), unknown = await importPkg('case-zzz', body);
    expect(noCap.status).toBe(403);
    expect(unknown.status).toBe(403);
    expect(await noCap.clone().text()).toBe(await unknown.clone().text());
    expect(w.stager.calls).toHaveLength(0);
  });

  it('refuses a cross-origin write and a non-JSON content type before anything else', async () => {
    const { w, body } = await ready();
    expect((await importPkg('case-a', body, { origin: 'https://evil.test' })).status).toBe(403);
    expect((await importPkg('case-a', body, { origin: null })).status).toBe(403);
    expect((await importPkg('case-a', body, { contentType: 'text/plain' })).status).toBe(415);
    expect(w.operateCalls).toHaveLength(0);
  });

  it.each(['authorizeOperate', 'stager', 'submissions', 'repository', 'audit', 'budget'])('answers 503 when the %s port is not composed (no default, no allow-all)', async (port) => {
    const { w, body } = await ready({ null: port });
    const r = await importPkg('case-a', body);
    expect(r.status).toBe(503);
    expect(w.stager.calls).toHaveLength(0);
    expect(counts(w).native_import_link).toBe(0);
  });

  it('answers 503 for every route when nothing is composed', async () => {
    const { w, body } = await ready({ configured: false });
    expect((await importPkg('case-a', body)).status).toBe(503);
    expect((await listAll('case-a')).status).toBe(503);
    expect((await readOne('case-a', 'cand-x')).status).toBe(503);
    expect((await correct('case-a', 'cand-x', {})).status).toBe(503);
    expect(w.stager.calls).toHaveLength(0);
  });

  it('never shows a private candidate to a client principal or an operator without the case capability', async () => {
    const { w, body } = await ready();
    const made = await importPkg('case-a', body);
    expect(made.status).toBe(201);
    const c = await linked(made);
    expect((await readOne('case-a', c.candidateId, who({ principalKind: 'client' }))).status).toBe(404);
    expect((await listAll('case-a', who({ principalKind: 'client' }))).status).toBe(404);
    expect((await readOne('case-a', c.candidateId, who({ kind: 'anonymous' }))).status).toBe(401);
    const other = world({ operate: [CASE_B] });
    expect(other.operateCalls).toHaveLength(0);
    expect(w.operateCalls.length).toBeGreaterThan(0);
    // Same populated repository; the ungranted staff operator must really attempt both reads.
    compose({ ...w.ports, authorizeOperate: async () => { throw Object.assign(new Error('forbidden'), { code: 'forbidden' }); } });
    expect((await readOne('case-a', c.candidateId, who({ subject: 'ungranted-staff' }))).status).toBe(404);
    expect((await listAll('case-a', who({ subject: 'ungranted-staff' }))).status).toBe(404);
    expect(counts(w).native_candidate).toBe(1);
  });
});

describe('a finalized submission and a validated package make one immutable private link', () => {
  it('records the exact client, case, finalized revision and manifest bytes SHA against the candidate instance, resultsVersion, manifestSha256 and the package inputRevision.id', async () => {
    const { w, fx, body, manifest, revisionId } = await ready();
    const r = await importPkg('case-a', body);
    expect(r.status).toBe(201);
    const c = await linked(r), l = c.link;
    expect(l.format).toBe('clearcase.candidate-import-link/1');
    expect([l.clientId, l.caseId]).toEqual(['client-a', 'case-a']);
    expect(l.submissionRevisionId).toBe(revisionId);
    expect(l.submissionManifestSha256).toBe(submissionSha(manifest as never));
    expect(l.candidate).toMatchObject({ clientId: 'client-a', caseId: 'case-a', resultsVersion: fx.manifest.resultsVersion, packageInputRevisionId: fx.manifest.inputRevision.id });
    expect(l.candidate.manifestSha256).toBe(sha256Hex(fx.files.get('manifest.json')!));
    expect(l.candidate.candidateId).toMatch(/^cand-[0-9a-f]{32}$/);
    expect(l.operator).toEqual({ issuer: 'https://issuer.test', subject: 'operator-1', kind: 'staff' });
    expect(l.linkedAt).toBe(NOW);
    expect(l.attribution).toBe('manual-operator-link-not-processing-proof');
    expect(l.state).toBe('private-candidate-linked');
    expect(c).toMatchObject({ origin: 'import', parentCandidateId: null, current: true, supersededBy: null, correction: null });
    expect(counts(w)).toMatchObject({ native_import_link: 1, native_candidate: 1, native_import_attempt: 1 });
  });

  it('does not confuse the converter input identity (HTML) with the submitted PDF: the link pins the package inputRevision.id, never a PDF digest', async () => {
    const { fx, body } = await ready();
    const l = (await linked(await importPkg('case-a', body))).link;
    expect(l.candidate.packageInputRevisionId).toBe(fx.manifest.inputRevision.id);
    expect(l.candidate.packageInputRevisionId).not.toContain(shaOf(CLAIM.bytes));
    expect(l.submissionManifestSha256).not.toBe(shaOf(CLAIM.bytes));
    expect(JSON.stringify(l)).not.toMatch(/recipe|processed|verified-processing/);
  });

  it('maps every required original by path, sha256 and size, literal, with no warning invented', async () => {
    const { body } = await ready();
    const cov = (await linked(await importPkg('case-a', body))).link.coverage;
    expect(cov.policy).toBe('exact-required-file-set/1');
    expect(cov.mappedOriginals).toEqual([{ packageRefs: ['OD-001'], packagePath: 'Letters/Claim.pdf', storedPath: 'Letters/Claim.pdf', submissionAssetId: expect.stringMatching(/^sub-op-/), sha256: shaOf(CLAIM.bytes), size: CLAIM.bytes.byteLength, pathMatch: 'literal' }]);
    expect(cov.mappedOriginals[0]).not.toHaveProperty('preservedWarning');
    expect(cov.unavailableOriginals).toEqual([]);
  });

  it('reads the same link back, and lists it, to an authorized operator', async () => {
    const { body } = await ready();
    const c = await linked(await importPkg('case-a', body));
    const one = await readOne('case-a', c.candidateId);
    expect(one.status).toBe(200);
    expect(one.headers.get('cache-control')).toBe('no-store');
    expect(await one.json()).toEqual(c);
    const all = (await (await listAll('case-a')).json()) as { candidates: LinkView[] };
    expect(all.candidates.map((x) => x.candidateId)).toEqual([c.candidateId]);
    expect((await readOne('case-a', 'cand-00000000000000000000000000000000')).status).toBe(404);
    expect((await readOne('case-b', c.candidateId)).status).toBe(404);
  });

  it('appends an audit event naming the verified operator, the candidate and the exact version', async () => {
    const { w, body } = await ready();
    const c = await linked(await importPkg('case-a', body));
    const e = w.audit.events.find((x) => x.action === 'results.import-candidate')!;
    expect(e).toMatchObject({ actor: { kind: 'verified', principal: { subject: 'operator-1', kind: 'staff' } }, object: { kind: 'candidate', id: c.candidateId, caseId: 'case-a' }, version: c.link.candidate.resultsVersion, outcome: 'succeeded', at: NOW });
  });

  it('is idempotent for the same actor, operation and bytes: one link, no second staging', async () => {
    const { w, body } = await ready();
    const first = await importPkg('case-a', body), again = await importPkg('case-a', body);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { repeated: boolean }).repeated).toBe(true);
    expect(w.stager.calls).toHaveLength(1);
    expect(counts(w)).toMatchObject({ native_import_link: 1, native_candidate: 1, native_import_attempt: 1 });
  });

  it('refuses a reused operation id for different bytes or another operator, without revealing which', async () => {
    const { w, fx, body } = await ready();
    expect((await importPkg('case-a', body)).status).toBe(201);
    const other = buildFixture({ docs: [CLAIM], tag: 'other', matter: { title: 'Another' } });
    const changed = await importPkg('case-a', { ...body, files: asText(other.files) });
    const stranger = await importPkg('case-a', body, { who: who({ subject: 'operator-2' }) });
    expect([changed.status, stranger.status]).toEqual([409, 409]);
    expect([await code(changed), await code(stranger)]).toEqual(['operation-reused', 'operation-reused']);
    expect(await changed.clone().text()).toBe(await stranger.clone().text());
    expect(counts(w)).toMatchObject({ native_import_link: 1, native_candidate: 1 });
    expect(fx.files.size).toBeGreaterThan(0);
  });

  it('refuses to import the same package twice under another operation id (the candidate exists, lineage is not rewritten)', async () => {
    const { w, body } = await ready();
    expect((await importPkg('case-a', body)).status).toBe(201);
    const r = await importPkg('case-a', { ...body, operationId: op() });
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('candidate-exists');
    expect(counts(w)).toMatchObject({ native_import_link: 1, native_candidate: 1 });
  });
});

describe('the submission must be the case\'s own FINALIZED revision', () => {
  it('refuses a revision that is only reserved: the reader checks the upload state, not the revision row', async () => {
    const w = world(), reserved = await finalizeSubmission(w.db, { operationId: op(), file: { path: CLAIM.path, bytes: CLAIM.bytes }, finalize: false });
    w.stager.folder = new Map([[CLAIM.path, CLAIM.bytes]]);
    const fx = buildFixture({ docs: [CLAIM] });
    const r = await importPkg('case-a', { operationId: op(), submissionRevisionId: reserved.revisionId, files: asText(fx.files) });
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('submission-not-finalized');
    expect(w.stager.calls).toHaveLength(0);
    expect(counts(w).native_import_link).toBe(0);
  });

  it('never guesses a submission: an unknown revision, or another case\'s revision, is the same not-found', async () => {
    const { w, body } = await ready();
    const none = await importPkg('case-a', { ...body, submissionRevisionId: 'subrev-op-nothing-0000000000' });
    expect(none.status).toBe(404);
    expect(await code(none)).toBe('submission-not-found');
    const theirs = await finalizeSubmission(w.db, { caseId: CASE_B, operationId: op(), file: { path: CLAIM.path, bytes: CLAIM.bytes } });
    const crossed = await importPkg('case-a', { ...body, operationId: op(), submissionRevisionId: theirs.revisionId });
    expect(crossed.status).toBe(404);
    expect(await code(crossed)).toBe('submission-not-found');
    expect(w.stager.calls).toHaveLength(0);
  });

  it('does not link by the case slug alone: a package for another case id is refused before staging', async () => {
    const { w, body } = await ready();
    const other = buildFixture({ docs: [CLAIM], caseId: 'case-b' });
    const r = await importPkg('case-a', { ...body, files: asText(other.files) });
    expect(r.status).toBe(422);
    expect(await code(r)).toBe('wrong-case');
    expect(w.stager.calls).toHaveLength(0);
    expect(counts(w).native_candidate).toBe(0);
  });

  it('refuses a candidate already linked to another submission revision', async () => {
    const { w, body } = await ready();
    expect((await importPkg('case-a', body)).status).toBe(201);
    const second = await finalizeSubmission(w.db, { operationId: op(), file: { path: CLAIM.path, bytes: CLAIM.bytes } });
    const r = await importPkg('case-a', { ...body, operationId: op(), submissionRevisionId: second.revisionId });
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('candidate-exists');
    expect(counts(w).native_import_link).toBe(1);
  });
});

describe('the supplied package is verified byte for byte and never rewritten', () => {
  it('refuses an unknown manifest field and stages nothing', async () => {
    const { w, fx, body } = await ready();
    const m = JSON.parse(new TextDecoder().decode(fx.files.get('manifest.json')!)) as Record<string, unknown>;
    m.processedBy = 'recipe-run-1';
    const files = { ...body.files, 'manifest.json': canonicalText(m) };
    const r = await importPkg('case-a', { ...body, files });
    expect(r.status).toBe(422);
    expect(await code(r)).toBe('package-invalid');
    expect(w.stager.calls).toHaveLength(0);
    expect(counts(w).native_import_link).toBe(0);
  });

  it('refuses a listed file whose bytes differ, an unlisted extra file and a missing listed file', async () => {
    const { w, body } = await ready();
    const tampered = { ...body.files, 'datasets/matter.json': body.files['datasets/matter.json'].replace('Matter', 'Mattex') };
    const extra = { ...body.files, 'datasets/extra.json': '{}\n' };
    const { 'assets.json': _gone, ...missing } = body.files;
    for (const files of [tampered, extra, missing]) {
      const r = await importPkg('case-a', { ...body, operationId: op(), files });
      expect(r.status).toBe(422);
      expect(await code(r)).toBe('package-invalid');
    }
    expect(w.stager.calls).toHaveLength(0);
  });

  it('keeps the supplied package bytes exactly as the stager receives them', async () => {
    const { w, fx, body } = await ready();
    expect((await importPkg('case-a', body)).status).toBe(201);
    const seen = w.stager.calls[0].files;
    expect([...seen.keys()].sort()).toEqual([...fx.files.keys()].sort());
    for (const [p, b] of fx.files) expect(shaOf(seen.get(p)!)).toBe(shaOf(b));
  });

  it('refuses a package the real validator rejects, with no link', async () => {
    const { w, fx, body } = await ready();
    const bad = buildFixture({ docs: [CLAIM], assets: { 'OD-001': { kind: 'file', path: CLAIM.path, sha256: '0'.repeat(64), size: CLAIM.bytes.byteLength, mediaType: 'application/pdf', textStatus: 'pending' } } });
    const r = await importPkg('case-a', { ...body, files: asText(bad.files) });
    expect(r.status).toBe(422);
    expect(await code(r)).toBe('validator-refused');
    expect(counts(w).native_import_link).toBe(0);
    expect(fx.manifest.resultsVersion).toBeTruthy();
  });

  it('refuses when the stager reports an identity other than the supplied package\'s', async () => {
    const { w, body } = await ready();
    w.stager.outcomeOverride = (o) => ({ ...(o as object), resultsVersion: `sha256:${'a'.repeat(64)}` });
    const r = await importPkg('case-a', body);
    expect([502, 503]).toContain(r.status);
    expect(counts(w).native_import_link).toBe(0);
  });

  it('answers 503 on a storage fault and persists no link; the same operation then succeeds', async () => {
    const { w, body } = await ready();
    w.stager.fail = true;
    expect((await importPkg('case-a', body)).status).toBe(503);
    expect(counts(w).native_import_link).toBe(0);
    w.stager.fail = false;
    expect((await importPkg('case-a', body)).status).toBe(201);
  });
});

describe('bounded upload', () => {
  it('stops reading at the body bound and calls neither validator nor stager', async () => {
    const { w, body } = await ready();
    const big = utf8(JSON.stringify({ ...body, pad: 'x'.repeat(BUDGET.maxRequestBytes) }));
    const t = trackedBody(big, 4096);
    const r = await importPkg('case-a', {}, { body: t.stream });
    expect(r.status).toBe(413);
    expect(t.state.pulled).toBeLessThanOrEqual(BUDGET.maxRequestBytes + 4096);
    expect(w.stager.calls).toHaveLength(0);
  });

  it('refuses too many files and an over-budget file as 413 before staging', async () => {
    const { w, body } = await ready();
    const many = Object.fromEntries(Array.from({ length: BUDGET.maxFiles + 1 }, (_, i) => [`datasets/f${i}.json`, '{}\n']));
    expect((await importPkg('case-a', { ...body, operationId: op(), files: many })).status).toBe(413);
    const huge = { ...body.files, 'datasets/chronology.json': 'x'.repeat(BUDGET.maxFileBytes + 1) };
    expect((await importPkg('case-a', { ...body, operationId: op(), files: huge })).status).toBe(413);
    expect(w.stager.calls).toHaveLength(0);
  });

  it('refuses malformed, duplicate-key or unknown-field requests as 422', async () => {
    const { w, body } = await ready();
    const bodies = ['{', '[]', JSON.stringify({ ...body, extra: 1 }), `{"operationId":"${body.operationId}","operationId":"${body.operationId}","submissionRevisionId":"x","files":{}}`, JSON.stringify({ ...body, files: { 'manifest.json': 1 } }), JSON.stringify({ ...body, operationId: 'bad id' })];
    for (const b of bodies) expect((await importPkg('case-a', {}, { contentType: 'application/json', body: b })).status).toBe(422);
    expect(w.stager.calls).toHaveLength(0);
  });
});

describe('the exact required file set, preserved by the candidate staying private and unlinked', () => {
  const unlinked = async (r: Response) => {
    expect(r.status).toBe(422);
    return (await r.clone().json()) as { code: string; reasons: { code: string; subject?: string }[] };
  };
  const CLAIM_B: Doc = { ref: 'OD-002', path: 'Letters/Reply.pdf', bytes: pdf('reply') };
  const submission = (files: SubmittedFile[], revisionId = 'subrev-multi-op-0000000001') => {
    const manifest = { format: 'clearcase.submission-manifest/1' as const, clientId: CLIENT, caseId: CASE_A, revisionId, sequence: 1, operationId: 'multi-op-0000000001', finalizedAt: NOW,
      files: files.map((f, i) => ({ path: f.path, filename: f.path.split('/').pop()!, mediaType: 'application/pdf', size: f.bytes.byteLength, sha256: shaOf(f.bytes), assetId: `sub-multi-${i}` })) };
    const text = canonicalText(manifest);
    return { reader: { finalized: async (a: { revisionId: string }) => (a.revisionId === revisionId ? { state: 'finalized', manifest, storedManifestSha256: shaOf(utf8(text)), storedManifestBytes: utf8(text).byteLength } : { state: 'absent' }) }, revisionId };
  };
  async function multi(docs: Doc[], files: SubmittedFile[], fx: Partial<Parameters<typeof buildFixture>[0]> = {}) {
    const s = submission(files), w = world({ submissions: s.reader });
    w.stager.folder = new Map(files.map((f) => [f.path, f.bytes]));
    const pkg = buildFixture({ docs, ...fx });
    return { w, pkg, body: { operationId: op(), submissionRevisionId: s.revisionId, files: asText(pkg.files) } };
  }

  it('links two originals, each mapped once', async () => {
    const { w, body } = await multi([CLAIM, CLAIM_B], [CLAIM, CLAIM_B]);
    const r = await importPkg('case-a', body);
    expect(r.status).toBe(201);
    expect((await linked(r)).link.coverage.mappedOriginals.map((m) => m.packagePath)).toEqual(['Letters/Claim.pdf', 'Letters/Reply.pdf']);
    expect(counts(w).native_import_link).toBe(1);
  });

  it('leaves the candidate private and unlinked when a submitted file is not a required original (no subset permission)', async () => {
    const extra = { path: 'Letters/Extra.pdf', bytes: pdf('extra') };
    const { w, body } = await multi([CLAIM], [CLAIM, extra]);
    const r = await importPkg('case-a', body);
    expect(r.status).toBe(422);
    const u = await unlinked(r);
    expect(u.code).toBe('unlinked');
    expect(u.reasons).toContainEqual({ code: 'submitted-file-unmapped', subject: 'Letters/Extra.pdf' });
    expect(w.stager.calls).toHaveLength(1); // staged privately by the stager, never linked
    expect(counts(w)).toMatchObject({ native_import_link: 0, native_candidate: 0 });
  });

  it('leaves it unlinked when a required original is not in the submission', async () => {
    const { w, body } = await multi([CLAIM, CLAIM_B], [CLAIM]);
    const u = await unlinked(await importPkg('case-a', body));
    expect(u.reasons).toContainEqual({ code: 'required-original-unmatched', subject: 'Letters/Reply.pdf' });
    expect(counts(w).native_import_link).toBe(0);
  });

  it('leaves it unlinked when the submitted file at that path has other bytes (sha256) or another size', async () => {
    const swapped = { path: CLAIM.path, bytes: pdf('different') };
    const a = await multi([CLAIM], [swapped]);
    // the validator sees the folder the submission holds, so it rejects the fingerprint; the link must not be reached
    const r = await importPkg('case-a', a.body);
    expect([409, 422]).toContain(r.status);
    expect(counts(a.w).native_import_link).toBe(0);
    // a stager that does not catch it (the validator folder holds the package's bytes) is still stopped by the link
    const b = await multi([CLAIM], [swapped]);
    b.w.stager.folder = new Map([[CLAIM.path, CLAIM.bytes]]);
    const u = await unlinked(await importPkg('case-a', b.body));
    expect(u.reasons).toContainEqual({ code: 'required-original-fingerprint-mismatch', subject: 'Letters/Claim.pdf' });
    expect(counts(b.w).native_import_link).toBe(0);
  });

  it('shares one verified file fact between ref aliases and records every ref', async () => {
    const alias = { 'OD-009': { kind: 'file', path: CLAIM.path, sha256: shaOf(CLAIM.bytes), size: CLAIM.bytes.byteLength, mediaType: 'application/pdf', textStatus: 'pending' } };
    const { body } = await multi([CLAIM], [CLAIM], { assets: alias });
    const cov = (await linked(await importPkg('case-a', body))).link.coverage;
    expect(cov.mappedOriginals).toHaveLength(1);
    expect(cov.mappedOriginals[0].packageRefs).toEqual(['OD-001', 'OD-009']);
  });

  it('keeps missing and embedded entries explicit and unavailable, with no invented hash', async () => {
    const extra = {
      'OD-777': { kind: 'missing', path: 'Letters/Gone.pdf', mediaType: 'application/pdf', textStatus: 'pending' },
      'OD-001.a1': { kind: 'embedded', parentRef: 'OD-001', ordinal: 1, member: 'image001.png', mediaType: 'image/png', textStatus: 'unsupported' },
    };
    const { body } = await multi([CLAIM], [CLAIM], { assets: extra });
    const cov = (await linked(await importPkg('case-a', body))).link.coverage;
    expect(cov.unavailableOriginals).toEqual([{ kind: 'embedded', ref: 'OD-001.a1', parentRef: 'OD-001' }, { kind: 'missing', ref: 'OD-777', path: 'Letters/Gone.pdf' }]);
    expect(JSON.stringify(cov.unavailableOriginals)).not.toMatch(/sha256|size/);
  });

  it('does not let a missing entry excuse an extra submitted file at its path', async () => {
    const extra = { 'OD-777': { kind: 'missing', path: 'Letters/Gone.pdf', mediaType: 'application/pdf', textStatus: 'pending' } };
    const gone = { path: 'Letters/Gone.pdf', bytes: pdf('gone') };
    const { w, body } = await multi([CLAIM], [CLAIM, gone], { assets: extra });
    const u = await unlinked(await importPkg('case-a', body));
    expect(u.reasons).toContainEqual({ code: 'submitted-file-unmapped', subject: 'Letters/Gone.pdf' });
    expect(counts(w).native_import_link).toBe(0);
  });

  it('records both literal paths of a unique case/NFC match and the validator\'s own ORIG_CASE_MISMATCH fingerprint, unchanged', async () => {
    const stored = { path: 'letters/claim.pdf', bytes: CLAIM.bytes };
    const { w, body } = await multi([{ ...CLAIM, path: stored.path }], [stored], { indexedPath: { 'OD-001': 'Letters/Claim.pdf' } });
    const r = await importPkg('case-a', body);
    expect(r.status).toBe(201);
    const m = (await linked(r)).link.coverage.mappedOriginals[0];
    expect(m).toMatchObject({ pathMatch: 'case-nfc-unique', packagePath: 'Letters/Claim.pdf', storedPath: 'letters/claim.pdf', packageRefs: ['OD-001'] });
    expect(m.preservedWarning?.code).toBe('ORIG_CASE_MISMATCH');
    expect(m.preservedWarning?.fingerprints).toHaveLength(1);
    expect(m.preservedWarning?.fingerprints[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(counts(w).native_import_link).toBe(1);
  });

  it('is not a waiver: a case/NFC match whose validator reported no ORIG_CASE_MISMATCH stays unlinked', async () => {
    const stored = { path: 'letters/claim.pdf', bytes: CLAIM.bytes };
    const { w, body } = await multi([{ ...CLAIM, path: stored.path }], [stored], { indexedPath: { 'OD-001': 'Letters/Claim.pdf' } });
    w.stager.outcomeOverride = (o) => ({ ...(o as object), caseMismatch: [] });
    const u = await unlinked(await importPkg('case-a', body));
    expect(u.reasons).toContainEqual({ code: 'case-mismatch-warning-missing', subject: 'Letters/Claim.pdf' });
    expect(counts(w).native_import_link).toBe(0);
  });

  it('invents no warning: a literal match that carries a case-mismatch warning is unlinked', async () => {
    const { w, body } = await multi([CLAIM], [CLAIM]);
    w.stager.outcomeOverride = (o) => ({ ...(o as object), caseMismatch: [{ ref: 'OD-001', fingerprint: 'f'.repeat(32) }] });
    const u = await unlinked(await importPkg('case-a', body));
    expect(u.reasons.map((x) => x.code)).toContain('unexpected-case-mismatch-warning');
    expect(counts(w).native_import_link).toBe(0);
  });

  it('does not guess among folds: two submitted files that differ only by case leave a third spelling ambiguous', async () => {
    const a = { path: 'letters/claim.pdf', bytes: pdf('a') }, b = { path: 'LETTERS/CLAIM.pdf', bytes: pdf('b') };
    const { w, body } = await multi([{ ref: 'OD-001', path: a.path, bytes: a.bytes }], [a, b], { indexedPath: { 'OD-001': 'Letters/Claim.pdf' } });
    const u = await unlinked(await importPkg('case-a', body));
    expect(u.reasons.map((x) => x.code)).toContain('required-original-ambiguous');
    expect(counts(w).native_import_link).toBe(0);
  });

  it('prefers the exact name over a case variant (no ambiguity), yet the variant file still blocks the link as unmapped', async () => {
    const lower = { path: 'letters/claim.pdf', bytes: pdf('lower') };
    const { w, body } = await multi([CLAIM], [CLAIM, lower]);
    const u = await unlinked(await importPkg('case-a', body));
    expect(u.reasons).toEqual([{ code: 'submitted-file-unmapped', subject: 'letters/claim.pdf' }]);
    expect(counts(w).native_import_link).toBe(0);
  });
});

describe('audit is required on the success path and written for refusals', () => {
  it('answers 503 when audit cannot append, keeps the persisted link, and a retry completes with the same event id', async () => {
    const { w, body } = await ready();
    w.audit.failNext = true;
    expect((await importPkg('case-a', body)).status).toBe(503);
    expect(counts(w).native_import_link).toBe(1);
    const r = await importPkg('case-a', body);
    expect(r.status).toBe(200);
    expect(w.audit.events.filter((e) => e.action === 'results.import-candidate')).toHaveLength(1);
    expect(w.stager.calls).toHaveLength(1);
  });

  it('records a denial for a forbidden case, never the package', async () => {
    const { w, body } = await ready();
    await importPkg('case-b', body);
    expect(w.audit.events.some((e) => e.outcome === 'denied')).toBe(true);
    expect(JSON.stringify(w.audit.events)).not.toContain('Synthetic');
  });
});

describe('D1 write-once protections hold below the service', () => {
  async function made() { const x = await ready(); const c = await linked(await importPkg('case-a', x.body)); return { ...x, c }; }
  const refused = (w: World, sql: string, ...v: (string | number | null)[]) => expect(() => w.db.exec(sql, ...v)).toThrow();

  it('refuses UPDATE and DELETE on every table, and REPLACE of an existing link, candidate or attempt', async () => {
    const { w } = await made();
    for (const t of ['native_import_attempt', 'native_candidate', 'native_import_link']) {
      refused(w, `DELETE FROM ${t}`);
    }
    refused(w, "UPDATE native_import_link SET linked_at = '2000-01-01T00:00:00.000Z'");
    refused(w, "UPDATE native_import_link SET submission_manifest_sha256 = '" + '0'.repeat(64) + "'");
    refused(w, "UPDATE native_candidate SET manifest_sha256 = '" + '0'.repeat(64) + "'");
    refused(w, "UPDATE native_import_attempt SET operator_subject = 'someone-else'");
    const link = rows(w, 'native_import_link')[0], cand = rows(w, 'native_candidate')[0];
    const cols = (r: Record<string, unknown>) => Object.keys(r);
    const replace = (t: string, r: Record<string, unknown>) => w.db.exec(`INSERT OR REPLACE INTO ${t} (${cols(r).join(',')}) VALUES (${cols(r).map(() => '?').join(',')})`, ...(Object.values(r) as (string | number | null)[]));
    expect(() => replace('native_import_link', { ...link, linked_at: '2001-01-01T00:00:00.000Z' })).toThrow();
    expect(() => replace('native_candidate', { ...cand, created_at: '2001-01-01T00:00:00.000Z' })).toThrow();
    expect(rows(w, 'native_import_link')[0]).toEqual(link);
  });

  it('refuses a link that disagrees with its candidate, or whose operator is not the attempt\'s', async () => {
    const { w, c } = await made();
    const link = rows(w, 'native_import_link')[0];
    const ins = (over: Record<string, unknown>) => {
      const r = { ...link, link_id: 'link-forged-00000000000000000000', candidate_id: 'cand-forged', ...over };
      w.db.exec(`INSERT INTO native_import_link (${Object.keys(r).join(',')}) VALUES (${Object.keys(r).map(() => '?').join(',')})`, ...(Object.values(r) as (string | number | null)[]));
    };
    expect(() => ins({ candidate_id: 'cand-forged' })).toThrow(); // no such candidate
    expect(() => ins({ candidate_id: c.candidateId })).toThrow(); // a candidate is linked once
    expect(counts(w).native_import_link).toBe(1);
  });

  it('refuses a candidate whose attempt does not exist or whose parent is absent', async () => {
    const { w } = await made();
    const cand = rows(w, 'native_candidate')[0];
    const ins = (over: Record<string, unknown>) => {
      const r = { ...cand, ...over };
      w.db.exec(`INSERT INTO native_candidate (${Object.keys(r).join(',')}) VALUES (${Object.keys(r).map(() => '?').join(',')})`, ...(Object.values(r) as (string | number | null)[]));
    };
    expect(() => ins({ candidate_id: 'cand-x', results_version: `sha256:${'b'.repeat(64)}`, operation_id: 'no-such-operation-000000' })).toThrow();
    expect(() => ins({ candidate_id: 'cand-y', results_version: `sha256:${'c'.repeat(64)}`, operation_id: String(cand.operation_id), origin: 'correction', parent_candidate_id: 'cand-nothing' })).toThrow();
  });

  it('keeps stored link bytes honest: a link row whose content digest no longer matches reads as an integrity fault, never as the link', async () => {
    const { w, c } = await made();
    // simulate storage tampering below the triggers (an administrator dropping them), then read through the service
    for (const t of ['native_import_link']) {
      for (const tr of w.db.rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?", t)) w.db.exec(`DROP TRIGGER ${tr.name}`);
    }
    w.db.exec("UPDATE native_import_link SET submission_revision_id = 'subrev-forged-0000000000000000'");
    const r = await readOne('case-a', c.candidateId);
    expect(r.status).toBe(503);
    expect(await code(r)).toBe('integrity');
  });
});

describe('a minimal authored correction is a NEW validated candidate with a NEW link', () => {
  async function base() {
    const x = await ready();
    const c = await linked(await importPkg('case-a', x.body));
    return { ...x, c };
  }
  const NEWMATTER = { title: 'Matter (corrected)', short: 'M', forum: 'High Court', storyline: [{ h: 'Background', t: 'Corrected by the reviewer.' }], strategy: [] };
  const fix = (extra: object = {}) => ({ operationId: op(), reason: 'Correct the matter title', replacements: [{ key: 'matter', data: NEWMATTER }], ...extra });

  it('creates a new candidate, a new immutable link to the same submission, a supersession and a before/after record', async () => {
    const { w, fx, c } = await base();
    const r = await correct('case-a', c.candidateId, fix());
    expect(r.status).toBe(201);
    const n = await linked(r);
    expect(n.candidateId).not.toBe(c.candidateId);
    expect(n).toMatchObject({ origin: 'correction', parentCandidateId: c.candidateId, current: true, supersededBy: null });
    expect(n.link.linkId).not.toBe(c.link.linkId);
    expect(n.link.candidate.resultsVersion).not.toBe(c.link.candidate.resultsVersion);
    expect(n.link.candidate.manifestSha256).not.toBe(c.link.candidate.manifestSha256);
    expect(n.link.submissionRevisionId).toBe(c.link.submissionRevisionId);
    expect(n.link.submissionManifestSha256).toBe(c.link.submissionManifestSha256);
    expect(n.link.candidate.packageInputRevisionId).toBe(fx.manifest.inputRevision.id);
    expect(n.link.coverage).toEqual(c.link.coverage);
    expect(n.correction).toMatchObject({ reason: 'Correct the matter title', operator: { subject: 'operator-1' }, at: NOW });
    const ch = n.correction!.changes;
    expect(ch.map((x) => x.path)).toEqual(['datasets/matter.json']);
    expect(ch[0].before?.sha256).toBe(shaOf(fx.files.get('datasets/matter.json')!));
    expect(ch[0].after.sha256).not.toBe(ch[0].before?.sha256);
    expect(counts(w)).toMatchObject({ native_candidate: 2, native_import_link: 2, native_candidate_supersession: 1, native_correction_change: 1 });
  });

  it('keeps generated records, the asset index and every other file byte-identical, and sets only the parent and the changed dataset', async () => {
    const { w, fx, c } = await base();
    const n = await linked(await correct('case-a', c.candidateId, fix()));
    const staged = w.stager.store.get(n.link.candidate.resultsVersion)!.files;
    for (const p of ['datasets/chronology.json', 'assets.json']) expect(shaOf(staged.get(p)!)).toBe(shaOf(fx.files.get(p)!));
    expect(shaOf(staged.get('datasets/matter.json')!)).not.toBe(shaOf(fx.files.get('datasets/matter.json')!));
    const m = JSON.parse(new TextDecoder().decode(staged.get('manifest.json')!)) as { parent: string; inputRevision: { id: string }; created: string };
    expect(m.parent).toBe(c.link.candidate.resultsVersion);
    expect(m.inputRevision.id).toBe(fx.manifest.inputRevision.id);
    expect(m.created).toBe(NOW);
    expect(w.stager.store.get(c.link.candidate.resultsVersion)).toBeTruthy(); // the old stored version stays
  });

  it('invalidates the old sign-off basis: the old candidate is superseded, its link unchanged', async () => {
    const { c } = await base();
    const n = await linked(await correct('case-a', c.candidateId, fix()));
    const old = (await (await readOne('case-a', c.candidateId)).json()) as LinkView;
    expect(old).toMatchObject({ current: false, supersededBy: n.candidateId });
    expect(old.link).toEqual(c.link);
    const all = ((await (await listAll('case-a')).json()) as { candidates: LinkView[] }).candidates;
    expect(all.filter((x) => x.current).map((x) => x.candidateId)).toEqual([n.candidateId]);
  });

  it('records the correction audit event and is idempotent for the same operation', async () => {
    const { w, c } = await base();
    const body = fix();
    expect((await correct('case-a', c.candidateId, body)).status).toBe(201);
    const again = await correct('case-a', c.candidateId, body);
    expect(again.status).toBe(200);
    expect(w.audit.events.filter((e) => e.action === 'results.correct-candidate')).toHaveLength(1);
    expect(counts(w)).toMatchObject({ native_candidate: 2, native_import_link: 2, native_candidate_supersession: 1 });
  });

  it('refuses a correction of a superseded candidate: only the current candidate is corrected', async () => {
    const { w, c } = await base();
    expect((await correct('case-a', c.candidateId, fix())).status).toBe(201);
    const r = await correct('case-a', c.candidateId, fix({ replacements: [{ key: 'matter', data: { ...NEWMATTER, title: 'Again' } }] }));
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('superseded');
    expect(counts(w).native_candidate).toBe(2);
  });

  it('refuses to touch generated records, the asset index, unknown datasets or an unchanged dataset', async () => {
    const { w, c } = await base();
    for (const key of ['chronology', 'assets', 'no-such-dataset']) {
      const r = await correct('case-a', c.candidateId, fix({ replacements: [{ key, data: [] }] }));
      expect(r.status).toBe(422);
      expect(await code(r)).toBe('invalid-correction');
    }
    expect((await correct('case-a', c.candidateId, fix({ replacements: [{ key: '../matter', data: [] }] }))).status).toBe(422);
    const same = await correct('case-a', c.candidateId, fix({ replacements: [{ key: 'matter', data: { title: 'Matter', short: 'M', forum: 'High Court', storyline: [{ h: 'Background', t: 'Synthetic.' }], strategy: [] } }] }));
    expect(same.status).toBe(422);
    expect(await code(same)).toBe('no-change');
    expect(counts(w).native_candidate).toBe(1);
  });

  it('refuses corrected data the real validator rejects, and persists nothing', async () => {
    const { w, c } = await base();
    const r = await correct('case-a', c.candidateId, fix({ replacements: [{ key: 'matter', data: { title: 5 } }] }));
    expect(r.status).toBe(422);
    expect(counts(w)).toMatchObject({ native_candidate: 1, native_import_link: 1, native_candidate_supersession: 0, native_correction_change: 0 });
  });

  it('requires a reason and refuses user work smuggled into a correction', async () => {
    const { w, c } = await base();
    expect((await correct('case-a', c.candidateId, fix({ reason: '' }))).status).toBe(422);
    expect((await correct('case-a', c.candidateId, fix({ reason: 'x'.repeat(501) }))).status).toBe(422);
    const userwork = await correct('case-a', c.candidateId, fix({ replacements: [{ key: 'matter', data: { ...NEWMATTER, notes_user_v1: [] } }] }));
    expect(userwork.status).toBe(422);
    expect(counts(w).native_candidate).toBe(1);
  });

  it('refuses when the stored base bytes no longer verify, and for a client principal or an unknown base', async () => {
    const { w, c } = await base();
    w.packages.tamper = (f) => { f.set('datasets/matter.json', utf8('{}\n')); };
    const r = await correct('case-a', c.candidateId, fix());
    expect(r.status).toBe(503);
    expect(await code(r)).toBe('integrity');
    w.packages.tamper = null;
    expect((await correct('case-a', c.candidateId, fix(), { who: who({ principalKind: 'client' }) })).status).toBe(403);
    const none = await correct('case-a', 'cand-00000000000000000000000000000000', fix());
    expect(none.status).toBe(404);
    expect(counts(w).native_candidate).toBe(1);
  });
});
