// Function-level execution of the verbatim component request/state functions. Not hydration/browser proof.
import { expect, it, vi } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import * as WorkbenchExports from '../../../src/lib/views/hosted/OperatorWorkbench.svelte';
import { candidateIdOf, linkIdOf } from '../../../src/lib/results-review/native/digest.ts';
import type { LinkedCandidate } from '../../../src/lib/results-review/native/ports.ts';
import { CASE, CLIENT, RV, SHA, candidate, signoff } from './fixtures.ts';

const assertOperationSuccess = Reflect.get(WorkbenchExports, 'assertOperationSuccess');
const source = readFileSync('src/lib/views/hosted/OperatorWorkbench.svelte', 'utf8');
const script = source.split('<script lang="ts">')[1].split('</script>')[0];
const ast = ts.createSourceFile('instance.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = new Set(['jsonRequest', 'performPending', 'run']);
const functions = ast.statements.filter((s) => ts.isFunctionDeclaration(s) && s.name && names.has(s.name.text)).map((s) => s.getText(ast)).join('\n');
const js = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const OP = 'synthetic-operation-0000';
const input = `sha256:${'d'.repeat(64)}`, nextVersion = `sha256:${'e'.repeat(64)}`;

async function linked(correction = false): Promise<LinkedCandidate> {
  const c = candidate();
  const pin = { ...c.link.candidate, packageInputRevisionId: input as typeof c.link.candidate.packageInputRevisionId,
    resultsVersion: (correction ? nextVersion : RV) as typeof RV, manifestSha256: (correction ? 'f'.repeat(64) : SHA) as typeof c.link.candidate.manifestSha256 };
  pin.candidateId = await candidateIdOf(pin);
  const link = { ...c.link, candidate: pin, linkId: await linkIdOf({ candidateId: pin.candidateId,
    submissionRevisionId: c.link.submissionRevisionId, submissionManifestSha256: c.link.submissionManifestSha256 }),
    coverage: { policy: 'exact-required-file-set/1' as const, mappedOriginals: [{ packageRefs: ['OD-1'], packagePath: 'Synthetic.pdf',
      storedPath: 'synthetic.pdf', submissionAssetId: 'synthetic-asset', sha256: c.link.submissionManifestSha256, size: 123,
      pathMatch: 'case-nfc-unique' as const, preservedWarning: { code: 'ORIG_CASE_MISMATCH' as const, fingerprints: ['b'.repeat(32)] as [string] } }],
      unavailableOriginals: [{ kind: 'missing' as const, ref: 'OD-2', path: 'missing.pdf' }, { kind: 'embedded' as const, ref: 'OD-3', parentRef: 'OD-1' }] } };
  return { ...c, candidateId: pin.candidateId, origin: correction ? 'correction' : 'import', parentCandidateId: correction ? (await linked()).candidateId : null, link,
    correction: correction ? { reason: 'Synthetic correction', operator: { issuer: link.operator.issuer, subject: link.operator.subject }, at: link.linkedAt,
      changes: [{ path: 'datasets/matter.json', before: { sha256: SHA, size: 10 }, after: { sha256: 'f'.repeat(64), size: 20 } }] } : null };
}
async function fixture(kind: 'import' | 'correction' | 'signoff' | 'publish') {
  const c = await linked(), pin = c.link.candidate, so = signoff();
  const body = kind === 'import' ? { operationId: OP, submissionRevisionId: c.link.submissionRevisionId, files: { 'manifest.json': 'exact synthetic bytes' } }
    : kind === 'correction' ? { operationId: OP, reason: 'Synthetic correction', replacements: [{ key: 'matter', data: { text: 'Synthetic change' } }] }
    : kind === 'signoff' ? { operationId: OP, candidateId: c.candidateId, identity: { ...so, resultsVersion: RV }, acknowledgements: so.acknowledgements, selfApproval: true }
    : { operationId: OP, signoffId: so.signoffId, expected: { kind: 'none' } };
  const expected = kind === 'import' ? { clientId: CLIENT, caseId: CASE, submissionRevisionId: c.link.submissionRevisionId,
    submissionManifestSha256: c.link.submissionManifestSha256, resultsVersion: RV, manifestSha256: SHA, packageInputRevisionId: input }
    : kind === 'correction' ? c : { resultsVersion: RV };
  const response = kind === 'import' || kind === 'correction' ? { kind: 'linked', repeated: false, candidate: kind === 'correction' ? await linked(true) : c }
    : kind === 'signoff' ? { signoffId: `so-${OP}`, state: 'signed-off', resultsVersion: RV, selfApproval: true }
    : { operationId: OP, publication: { kind: 'published', resultsVersion: RV } };
  return { request: { path: `/synthetic/${kind}`, kind, body, expected }, response, status: kind === 'publish' ? 200 : 201 };
}

function exercise(seed: unknown, responder: () => Response | Promise<Response>) {
  const calls: { path: string; options: RequestInit }[] = [];
  const harness = new Function('fetch', 'assertOperationSuccess', 'seed', `
    let pending = seed, original = pending;
    let detail='retained detail',status='',signoffId='retained signoff',signoffOperation='signoff-op',importOperation='import-op',correctionOperation='correction-op',publishOperation='publish-op',candidateId='retained candidate',candidates=[];
    let readiness={reviewed:true}, reasons={warning:'retained reason'}, replacements='retained correction',busy=false;
    const invalidateReview=()=>{readiness=null}; let rotations=0;
    const newOperation=()=>{rotations++; return 'new-operation'};
    ${js}
    return {original, attempt:()=>run(performPending), state:()=>({pending,detail,status,signoffId,signoffOperation,importOperation,correctionOperation,publishOperation,candidateId,candidates,readiness,reasons,replacements,rotations})};
  `);
  const result = harness(async (path: string, options: RequestInit) => { calls.push({ path, options }); return responder(); }, assertOperationSuccess, seed);
  return { ...result, calls };
}
function response(value: unknown, status: number) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }

it('probe 3: semantically invalid 2xx import response retains the exact uncertain request', async () => {
  const f = await fixture('import'), h = exercise(f.request, () => response({}, 201));
  await h.attempt();
  expect(h.state().status).toMatch(/did not confirm.*unconfirmed/);
  expect(h.state().pending).toBe(h.original);
});

for (const kind of ['import', 'correction', 'signoff', 'publish'] as const) {
  it(`${kind}: malformed 2xx keeps all recovery state and resends byte-identical request before a valid success`, async () => {
    const f = await fixture(kind); let value: unknown = {};
    const h = exercise(f.request, () => response(value, f.status));
    const before = h.state();
    await h.attempt();
    expect(h.state()).toEqual({ ...before, status: expect.stringMatching(/did not confirm.*unconfirmed/) });
    expect(h.state().pending).toBe(h.original);
    value = f.response;
    await h.attempt();
    expect(h.calls[1]).toEqual(h.calls[0]);
    expect(h.calls[0].options.body).toBe(JSON.stringify(f.request.body));
    expect(h.state().pending).toBeNull();
    expect(h.state().rotations).toBe(1);
    expect(h.state().status).toMatch(/controller confirmed/);
    expect(h.state().readiness).toBeNull();
    expect(h.state().reasons).toEqual(before.reasons);
    expect(h.state().replacements).toBe(before.replacements);
  });
  it(`${kind}: rejects every missing success-DTO field before cleanup`, async () => {
    const f = await fixture(kind);
    const paths: string[][] = [];
    function visit(x: unknown, path: string[] = []) {
      if (x === null || typeof x !== 'object') return;
      for (const [key, value] of Object.entries(x)) { paths.push([...path, key]); visit(value, [...path, key]); }
    }
    visit(f.response);
    for (const path of paths) {
      const mutant = JSON.parse(JSON.stringify(f.response)); let node = mutant;
      for (const part of path.slice(0, -1)) node = node[part];
      delete node[path.at(-1)!];
      const h = exercise(f.request, () => response(mutant, f.status));
      await h.attempt();
      expect(h.state().pending, `${kind} ${path.join('.')}`).toBe(h.original);
      expect(h.state().rotations).toBe(0);
      expect(h.state().status).toMatch(/unconfirmed/);
    }
  });
  it(`${kind}: rejects retyped success fields before cleanup`, async () => {
    const f = await fixture(kind);
    function fields(x: unknown, path: string[] = []): string[][] {
      if (x === null || typeof x !== 'object') return [path];
      return Object.entries(x).flatMap(([key, value]) => fields(value, [...path, key]));
    }
    for (const path of fields(f.response)) {
      const mutant = JSON.parse(JSON.stringify(f.response)); let node = mutant;
      for (const part of path.slice(0, -1)) node = node[part];
      const key = path.at(-1)!;
      // Every leaf gets an incompatible type, including nullable and boolean fields.
      node[key] = typeof node[key] === 'string' ? 123 : 'wrong-type';
      const h = exercise(f.request, () => response(mutant, f.status));
      await h.attempt();
      expect(h.state().pending, `${kind} ${path.join('.')}`).toBe(h.original);
      expect(h.state().rotations).toBe(0);
    }
  });
  it(`${kind}: accepts a fully validated replay without inventing a new operation`, async () => {
    const f = await fixture(kind);
    const value = kind === 'import' || kind === 'correction' ? { ...f.response, repeated: true } : f.response;
    const h = exercise(f.request, () => response(value, 200));
    await h.attempt();
    expect(h.calls).toHaveLength(1);
    expect(h.state().pending).toBeNull();
    expect(h.state().rotations).toBe(1);
  });
  it(`${kind}: null, scalar, array, incomplete and unexpected success shapes never confirm`, async () => {
    const f = await fixture(kind);
    for (const value of [null, true, 1, 'linked', [], {}, { ...f.response, unexpected: true }]) {
      const h = exercise(f.request, () => response(value, f.status));
      await h.attempt();
      expect(h.state().pending).toBe(h.original);
      expect(h.state().rotations).toBe(0);
      expect(h.state().status).toMatch(/unconfirmed/);
    }
  });
  it(`${kind}: network, JSON parse and 5xx retain the request; a definite 4xx retains drafts`, async () => {
    const f = await fixture(kind);
    for (const responder of [() => { throw new Error('offline'); }, () => new Response('{', { status: 201 }), () => response({ code: 'outage' }, 503)]) {
      const h = exercise(f.request, responder);
      await h.attempt();
      expect(h.state().pending).toBe(h.original);
      expect(h.state().rotations).toBe(0);
    }
    const h = exercise(f.request, () => response({ code: 'refused', message: 'Synthetic refusal' }, 409));
    await h.attempt();
    expect(h.state().pending).toBeNull();
    expect(h.state().rotations).toBe(0);
    expect(h.state().reasons).toEqual({ warning: 'retained reason' });
    expect(h.state().replacements).toBe('retained correction');
  });
}

it('refuses well-shaped successes for another operation, submission, case, package, parent, version or self-approval', async () => {
  for (const kind of ['import', 'correction', 'signoff', 'publish'] as const) {
    const f = await fixture(kind);
    const mutations = kind === 'import' ? [
      ['expected', 'caseId', 'another-case'], ['expected', 'clientId', 'another-client'],
      ['expected', 'submissionRevisionId', 'another-submission'], ['expected', 'submissionManifestSha256', '0'.repeat(64)],
      ['expected', 'resultsVersion', nextVersion], ['expected', 'manifestSha256', '0'.repeat(64)], ['expected', 'packageInputRevisionId', `sha256:${'0'.repeat(64)}`],
    ] : kind === 'correction' ? [
      ['expected', 'candidateId', 'another-parent'], ['body', 'reason', 'another reason'],
    ] : kind === 'signoff' ? [
      ['body', 'operationId', 'another-operation'], ['body', 'selfApproval', false],
    ] : [['body', 'operationId', 'another-operation'], ['expected', 'resultsVersion', nextVersion]];
    for (const [outer, key, value] of mutations) {
      const request = JSON.parse(JSON.stringify(f.request)); request[String(outer)][String(key)] = value;
      const h = exercise(request, () => response(f.response, f.status));
      await h.attempt();
      expect(h.state().pending).toBe(h.original);
      expect(h.state().rotations).toBe(0);
    }
  }
});

// Heavy review M4: a 401 the hosted handle marked x-clearcase-reauth (an expired session only the handshake renews) reloads
// this page, which goes through the handshake and back; the request is sent once and never retried.
it('reloads the page for a marked 401 and sends nothing again', async () => {
  for (const kind of ['import', 'correction', 'signoff', 'publish'] as const) {
    const f = await fixture(kind), assign = vi.fn();
    vi.stubGlobal('location', { href: 'https://client-a.clearcase.test/operator/results/case-a', assign });
    try {
      const h = exercise(f.request, () => new Response(JSON.stringify({ code: 'invalid-session', message: 'Your session has ended. Sign in again.' }), { status: 401, headers: { 'content-type': 'application/json', 'x-clearcase-reauth': '1' } }));
      await h.attempt();
      expect(assign).toHaveBeenCalledExactlyOnceWith('https://client-a.clearcase.test/operator/results/case-a');
      expect(h.calls).toHaveLength(1);
      expect(h.state().status).toMatch(/reloading to sign you in again.*not sent again/);
    } finally {
      vi.unstubAllGlobals();
    }
  }
});
