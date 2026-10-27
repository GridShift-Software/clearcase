// rx27 intake 503 then reauth (live on B, 27 Oct): a set-file declare or PUT that admitted a live session, whose ~60 s Clerk
// token then expired during the request's 3 to 8 s of wall time, answered 503 storage-unavailable. The original store asks
// the hosted upload authority again at each step (services.ts: session(), then checkRevocation()), which refuses the
// expired token with invalid-session, and the controller's storage() mapped every non-forbidden error to 503. These run
// the controller over the real original intake and repository, on SQLite D1 and memory R2 doubles, with the hosted
// composition's own re-check: a session ending mid-request is a 401, and only a real storage fault stays 503.
import { expect, it } from 'vitest';
import { createIntakeController } from '../../../src/lib/submissions/controller.ts';
import { d1SubmissionRepository } from '../../../src/lib/submissions/repository.ts';
import { createOriginalIntake } from '../../../src/lib/storage/cloud/intake.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import type { Identity, Principal, SessionId } from '../../../src/lib/server/runtime/contracts.ts';
import { BUDGETS, QUOTAS, deployment, ids, pdf, shaOf } from '../../hosted-foundation/storage/fixture.ts';
import { identity, uploadAuthority } from './doubles.ts';

const AT = '2026-10-27T17:14:35.000Z', now = () => new Date(AT);

// The request's identity: its session stands for the first `live` checks (admission), then is refused as Clerk's would be.
function expiring(live: number, code = 'invalid-session'): Identity {
  const base = identity();
  let checks = 0;
  return { ...base, checkRevocation: async () => { if (++checks > live) throw contractError(code, code === 'identity-unavailable'); } };
}

type Deployment = ReturnType<typeof deployment>;
// One request's hosted composition (services.ts) over the request's identity: authorizeUpload is the session check then the
// grant, and the original store asks it again at each step.
function compose(w: Deployment, who: Identity) {
  const grant = uploadAuthority([ids.caseA]);
  const session = async (s: { principal: Principal; sessionId: SessionId }) => {
    if (who.kind !== 'verified' || s.sessionId !== who.sessionId) throw contractError('invalid-session');
    await who.checkRevocation();
  };
  const authorizeUpload = async (a: Parameters<typeof grant>[0]) => { await session(a); await grant(a); };
  const originals = createOriginalIntake({ bindings: w, clientId: ids.clientA, budgets: BUDGETS, quotas: QUOTAS, now,
    authorize: async (m: { clientId: typeof ids.clientA; caseId: typeof ids.caseA }) => {
      if (who.kind !== 'verified') throw contractError('unauthenticated');
      await authorizeUpload({ principal: who.principal!, sessionId: who.sessionId!, clientId: m.clientId, caseId: m.caseId });
    } } as never);
  const ports = { clientId: ids.clientA, budget: { maxMetadataBytes: 4096, maxFileBytes: 1 << 20 }, authorizeUpload, repository: d1SubmissionRepository(w.db), originals, now };
  return createIntakeController(ports);
}

const setId = 'set-expiry-0000000001', bytes = pdf('expiry'), operationId = 'file-expiry-00000001';
const file = { operationId, path: 'a.pdf', size: bytes.length, sha256: shaOf(bytes), mediaType: 'application/pdf' };
type Method = 'openSet' | 'declareSetFile' | 'uploadSetFile' | 'declare' | 'upload';
function call(w: Deployment, method: Method, body: unknown, who: Identity, op?: string) {
  const raw = body instanceof Uint8Array, single = method === 'declare' || method === 'upload';
  const url = new URL(`https://client-a.test/client/intake/case-a${single ? '' : `/sets/${setId}`}${raw ? `/files/${op}` : method === 'declareSetFile' ? '/files' : ''}`);
  const init: RequestInit = { method: raw ? 'PUT' : 'POST', headers: { origin: url.origin, 'content-type': raw ? 'application/pdf' : 'application/json' }, body: raw ? (body as BodyInit) : JSON.stringify(body) };
  return compose(w, who)[method]({ request: new Request(url, init), url, params: { caseId: 'case-a', setId, operationId: op }, identity: who });
}
async function opened() {
  const w = deployment('client-a', ['case-a']);
  expect((await call(w, 'openSet', { setId, fileCount: 2, totalBytes: 2 * bytes.length }, identity())).status).toBe(201);
  return w;
}
const answer = async (r: Response) => ({ status: r.status, ...((await r.json()) as { code: string }) });

it('answers a set-file declare whose session ends after admission 401 unauthenticated, never 503 storage-unavailable', async () => {
  const w = await opened();
  // admission's own checkRevocation and its authorizeUpload stand; the original store's re-check meets the expired token
  expect(await answer(await call(w, 'declareSetFile', file, expiring(2)))).toMatchObject({ status: 401, code: 'unauthenticated' });
  expect([200, 201]).toContain((await call(w, 'declareSetFile', file, identity())).status);
});

it('answers a set-file PUT whose session ends after admission 401, and the same file is then stored', async () => {
  const w = await opened();
  expect((await call(w, 'declareSetFile', file, identity())).status).toBe(201);
  expect(await answer(await call(w, 'uploadSetFile', bytes, expiring(2), operationId))).toMatchObject({ status: 401, code: 'unauthenticated' });
  expect((await call(w, 'uploadSetFile', bytes, identity(), operationId)).status).toBe(201);
});

it('answers a single-file declare and PUT whose session ends after admission 401', async () => {
  const w = deployment('client-a', ['case-a']);
  expect(await answer(await call(w, 'declare', file, expiring(2)))).toMatchObject({ status: 401, code: 'unauthenticated' });
  expect([200, 201]).toContain((await call(w, 'declare', file, identity())).status);
  expect(await answer(await call(w, 'upload', bytes, expiring(2), operationId))).toMatchObject({ status: 401, code: 'unauthenticated' });
});

it('keeps an identity-provider fault mid-request and a real storage fault retryable 503s, never a 401', async () => {
  const w = await opened();
  const fault = await call(w, 'declareSetFile', file, expiring(2, 'identity-unavailable'));
  expect(await answer(fault)).toMatchObject({ status: 503, code: 'storage-unavailable' });
  expect(fault.headers.get('retry-after')).toBe('2');
  w.db.failNext = /INSERT INTO rs_original_upload/;
  expect(await answer(await call(w, 'declareSetFile', file, identity()))).toMatchObject({ status: 503, code: 'storage-unavailable' });
});
