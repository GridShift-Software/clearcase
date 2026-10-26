// The finalized-snapshot digest and the downloaded-manifest digest are different legitimate scopes. The submission view carries
// both; the workbench pins the finalized-snapshot digest to the link and to readiness, and shows the download digest only
// for the bytes the manifest route serves. Real controller, real snapshot reader and real readiness reader over the intake's
// SQLite stand-in; synthetic data only, no browser or worker runtime.
import { describe, expect, it } from 'vitest';
import * as WorkbenchExports from '../../../src/lib/views/hosted/OperatorWorkbench.svelte';
import type { LinkedCandidate } from '../../../src/lib/results-review/native/ports.ts';
import { submissionSnapshotReader, type NativeD1 } from '../../../src/lib/results-review/native/index.ts';
import type { OperatorSubmissionView } from '../../../src/lib/submissions/download/controller.ts';
import { createPublicationReadiness, type ReadinessView } from '../../../src/lib/publication/hosted/readiness.ts';
import { sha256 } from '../../../src/lib/server/runtime/ids.ts';
import { candidateIdOf, linkIdOf, sha256Text } from '../../../src/lib/results-review/native/digest.ts';
import { identity, seed, sha, world as downloads } from '../operator-download/doubles.ts';
import { compose, dispatch } from '../operator-download/harness.ts';
import { CASE, candidate, snapshot, world as readinessWorld } from './fixtures.ts';

const assertReadiness: (v: ReadinessView, caseId: string, c: LinkedCandidate, s: OperatorSubmissionView) => void = Reflect.get(WorkbenchExports, 'assertReadiness');
const assertOperationSuccess: (r: unknown, status: number, value: unknown) => Promise<void> = Reflect.get(WorkbenchExports, 'assertOperationSuccess');
const importExpectation: (s: OperatorSubmissionView, caseId: string, packageManifestText: string) => Promise<Record<string, string>> = Reflect.get(WorkbenchExports, 'importExpectation');

/** One finalized submission served by the real operator controller, plus the native reader's own digest of the same row. */
async function served() {
  const w = downloads({ operate: [CASE] }), s = await seed(w, { caseId: CASE });
  compose(w.ports);
  const who = identity({ readOriginal: [CASE] }), params = { caseId: CASE, operationId: s.operationId };
  const get = (route: 'view' | 'manifest') => {
    const url = new URL(`https://client-a.clearcase.test/operator/submissions/${CASE}/finalized/${s.operationId}${route === 'manifest' ? '/manifest' : ''}`);
    return dispatch(route, 'GET', { request: new Request(url), url, params, locals: { identity: who } });
  };
  const view: OperatorSubmissionView = await (await get('view')).json();
  const manifest = await get('manifest');
  const snap = await submissionSnapshotReader(w.db as unknown as NativeD1).finalized({ clientId: view.clientId as never, caseId: CASE, revisionId: view.revisionId });
  if (snap.state !== 'finalized') throw new Error('the seeded submission must be finalized');
  return { view, manifest, manifestBytes: new Uint8Array(await manifest.arrayBuffer()), snapshotSha: snap.storedManifestSha256 as string, bytes: s.bytes };
}
/** A linked candidate and the real readiness answer for it, both pinned to the given submission identity. */
async function pinned(revisionId: string, submissionManifestSha256: string) {
  const w = readinessWorld(), s = snapshot();
  w.current = { ...s, link: { ...s.link, submissionRevisionId: revisionId, submissionManifestSha256: sha256(submissionManifestSha256) } };
  const readiness: ReadinessView = await (await createPublicationReadiness(w.ports).read(w.request())).json();
  const c = candidate();
  return { readiness, c: { ...c, link: { ...c.link, submissionRevisionId: revisionId, submissionManifestSha256: sha256(submissionManifestSha256) } } as LinkedCandidate };
}

describe('finalized snapshot identity versus downloaded manifest digest', () => {
  it('keeps two legitimately unequal digests: the download keeps its served-bytes hash, the snapshot keeps the reader\'s hash', async () => {
    const { view, manifest, manifestBytes, snapshotSha } = await served();
    expect(view.manifestSha256).not.toBe(snapshotSha);
    expect(sha(manifestBytes)).toBe(view.manifestSha256);
    expect(manifest.headers.get('x-clearcase-manifest-sha256')).toBe(view.manifestSha256);
    expect((view as unknown as Record<string, unknown>).finalizedSnapshotSha256).toBe(snapshotSha);
  });
  it('lets readiness for the linked candidate pass against the controller\'s own view', async () => {
    const { view, snapshotSha } = await served();
    const { readiness, c } = await pinned(view.revisionId, snapshotSha);
    expect(readiness.identity.submissionManifestSha256).toBe(snapshotSha);
    expect(() => assertReadiness(readiness, CASE, c, view)).not.toThrow();
  });
  it('still refuses a changed finalized identity, whatever scope the forgery claims', async () => {
    const { view, snapshotSha } = await served();
    const { readiness, c } = await pinned(view.revisionId, snapshotSha);
    const forged = (x: string) => ({ ...readiness, identity: { ...readiness.identity, submissionManifestSha256: sha256(x) } });
    // the download scope is not the finalized scope; the changed pin is refused by the link, the readiness and the view alike
    expect(() => assertReadiness(forged(view.manifestSha256), CASE, c, view)).toThrow(/does not match/);
    expect(() => assertReadiness(forged('0'.repeat(64)), CASE, c, view)).toThrow(/does not match/);
    expect(() => assertReadiness(readiness, CASE, { ...c, link: { ...c.link, submissionManifestSha256: sha256(view.manifestSha256) } }, view)).toThrow(/does not match/);
    expect(() => assertReadiness(readiness, CASE, c, { ...view, finalizedSnapshotSha256: '0'.repeat(64) } as OperatorSubmissionView)).toThrow(/does not match/);
    expect(() => assertReadiness(readiness, CASE, c, { ...view, manifestSha256: '0'.repeat(64) })).not.toThrow(); // the download hash is not an identity input
  });
  it('pins an import to the finalized snapshot, not to the downloaded manifest', async () => {
    const { view, snapshotSha } = await served();
    const e = await importExpectation(view, CASE, JSON.stringify({ resultsVersion: `sha256:${'a'.repeat(64)}`, inputRevision: { id: `sha256:${'b'.repeat(64)}` } }));
    expect(e.submissionManifestSha256).toBe(snapshotSha);
    expect(e.submissionManifestSha256).not.toBe(view.manifestSha256);
    expect(e.submissionRevisionId).toBe(view.revisionId);
    expect(e.clientId).toBe(view.clientId);
  });
  it('confirms the linked import response against the finalized snapshot pin and refuses a response carrying the download digest', async () => {
    const { view, snapshotSha } = await served();
    const text = JSON.stringify({ resultsVersion: `sha256:${'a'.repeat(64)}`, inputRevision: { id: `sha256:${'b'.repeat(64)}` } });
    const expected = await importExpectation(view, CASE, text);
    const respond = async (linkedSha: string) => {
      const c = candidate(), pin = { ...c.link.candidate, clientId: expected.clientId as never, resultsVersion: expected.resultsVersion, manifestSha256: await sha256Text(text), packageInputRevisionId: expected.packageInputRevisionId };
      const candidateId = await candidateIdOf(pin), linkedPin = { ...pin, candidateId };
      const link = { ...c.link, clientId: expected.clientId as never, candidate: linkedPin, submissionRevisionId: view.revisionId, submissionManifestSha256: linkedSha,
        linkId: await linkIdOf({ candidateId, submissionRevisionId: view.revisionId, submissionManifestSha256: linkedSha }) };
      return { kind: 'linked', repeated: false, candidate: { ...c, candidateId, link } };
    };
    const request = { kind: 'import', path: '/imports', expected, body: { operationId: 'synthetic-operation0000', submissionRevisionId: view.revisionId, files: {} } };
    await expect(assertOperationSuccess(request, 201, await respond(snapshotSha))).resolves.toBeUndefined();
    await expect(assertOperationSuccess(request, 201, await respond(view.manifestSha256))).rejects.toThrow();
  });
});
