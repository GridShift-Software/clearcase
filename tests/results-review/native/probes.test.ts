// Protected source-review regressions. Synthetic component evidence, not live acceptance.
import { expect, it } from 'vitest';
import { world, compose, dispatch } from './harness.ts';
import { CASE_A, CLIENT, NOW, finalizeSubmission, who } from './doubles.ts';
import { asText, buildFixture, pdf } from './fixtures.ts';
import { createNativeResultsImport, createCandidateReader, type NativeImportPorts } from '../../../src/lib/results-review/native/index.ts';

let serial = 0;
const op = () => `review-${String(++serial).padStart(5, '0')}-abcdef1234567890`;
const post = async (route: 'imports' | 'corrections', body: unknown, candidateId?: string) => {
  const pathname = route === 'imports' ? '/operator/results/case-a/imports' : `/operator/results/case-a/candidates/${candidateId}/corrections`;
  const url = new URL(pathname, 'https://client-a.clearcase.test');
  return dispatch(route, 'POST', {
    request: new Request(url, { method: 'POST', headers: { origin: url.origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    url, params: { caseId: 'case-a', ...(candidateId ? { candidateId } : {}) }, locals: { identity: who() },
  });
};
async function prepared() {
  const w = world();
  const file = { path: 'Letters/Claim.pdf', bytes: pdf('review-only') };
  const manifest = await finalizeSubmission(w.db, { operationId: op(), file });
  w.stager.folder = new Map([[file.path, file.bytes]]);
  const fx = buildFixture({ docs: [{ ref: 'OD-001', ...file }] });
  return { w, fx, body: { operationId: op(), submissionRevisionId: manifest.revisionId, files: asText(fx.files) } };
}

it('a correction retries the same staged manifest after a failed link write', async () => {
  const { w, fx, body } = await prepared();
  const imported = await post('imports', body);
  expect(imported.status).toBe(201);
  const { candidate } = await imported.json() as any;
  let clock = Date.parse(NOW);
  w.ports.now = () => new Date(clock);
  compose(w.ports);
  const oldMatter = JSON.parse(new TextDecoder().decode(fx.files.get('datasets/matter.json')!));
  const correction = { operationId: op(), reason: 'Fix synthetic title', replacements: [{ key: 'matter', data: { ...oldMatter.data, title: 'Corrected' } }] };
  w.db.failNext = /INSERT INTO native_import_link/;
  const first = await post('corrections', correction, candidate.candidateId);
  expect(first.status).toBe(503);
  expect(w.db.rows('SELECT 1 FROM native_import_link')).toHaveLength(1);
  expect(w.stager.store.size).toBe(2); // correction really staged before the failed link write
  clock += 1000;
  const retry = await post('corrections', correction, candidate.candidateId);
  const result = await retry.clone().json();
  console.log('correction retry', retry.status, result);
  expect([200, 201], JSON.stringify(result)).toContain(retry.status);
});

it('admission tokens cannot cross service instances', async () => {
  const { w, body } = await prepared();
  expect((await post('imports', body)).status).toBe(201);
  const ports = w.ports as unknown as NativeImportPorts;
  const allowed = createNativeResultsImport(ports)!;
  const token = await allowed.admit({ identity: who(), caseId: CASE_A, access: 'read' });
  let deniedChecks = 0;
  const denied = createNativeResultsImport({ ...ports, authorizeOperate: async () => { deniedChecks++; throw Object.assign(new Error('forbidden'), { code: 'forbidden' }); } })!;
  const outcome = await denied.listCandidates(token).then(rows => ({ leaked: rows.length, deniedChecks }), error => ({ code: error.code, deniedChecks }));
  console.log('foreign service token', outcome);
  expect(outcome).toMatchObject({ code: 'forbidden' });
});

it('an audit failure leaves a durable import event or keeps the candidate noncurrent', async () => {
  const { w, body } = await prepared();
  w.audit.failAlways = true;
  const response = await post('imports', body);
  expect(response.status).toBe(503);
  expect(w.audit.events).toHaveLength(0);
  // Model a lost response with no client retry, then a later independently audited review read.
  w.audit.failAlways = false;
  const service = createNativeResultsImport(w.ports as unknown as NativeImportPorts)!;
  const token = await service.admit({ identity: who(), caseId: CASE_A, access: 'read' });
  expect(await service.listCandidates(token)).toHaveLength(1);
  const reader = createCandidateReader(w.ports as unknown as NativeImportPorts)!;
  const current = await reader.current({ clientId: CLIENT, caseId: CASE_A });
  const durableImport = w.audit.events.some(e => e.action === 'results.import-candidate');
  const tables = w.db.rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'native_%'").map(r => r.name);
  console.log('audit after recovery', { current: current.length, actions: w.audit.events.map(e => e.action), tables });
  // No durable outbox table exists in the native schema either: success is recoverable only by an optional uploader retry.
  expect(durableImport || current.length === 0).toBe(true);
});
