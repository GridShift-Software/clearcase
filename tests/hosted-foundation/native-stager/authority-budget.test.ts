import { afterEach, describe, expect, it } from 'vitest';
import { createHostedCandidateStager } from '../../../src/lib/server/runtime/hosted/candidate-stager.ts';
import type { Identity } from '../../../src/lib/server/runtime/contracts.ts';
import { caseId, world, docs } from './world.ts';
import { ids } from '../storage/fixture.ts';
const worlds: ReturnType<typeof world>[] = [];
const setup = (ds = docs(1)) => { const w = world(ds); worlds.push(w); return w; };
afterEach(() => { for (const w of worlds.splice(0)) w.db.sqlite.close(); });

describe('current operate authority and finite work', () => {
  it.each(['operate', 'client-principal', 'anonymous', 'client', 'case', 'session'] as const)('refuses %s before any storage metadata or bytes', async (failure) => {
    const w = setup(), a = await w.request(await w.upload());
    let identity: Identity = w.identity;
    if (failure === 'operate') w.state.allowed = false;
    if (failure === 'session') w.state.revoked = true;
    if (failure === 'client-principal' && identity.kind === 'verified') identity = { ...identity, principal: { ...identity.principal, kind: 'client' } };
    if (failure === 'anonymous') identity = { ...identity, kind: 'anonymous', principal: null, sessionId: null };
    const ports = createHostedCandidateStager({ ...w.config, identity });
    const statements = w.db.statements, gets = w.bucket.gets;
    await expect(ports.stager.stage({ ...a, ...(failure === 'case' ? { caseId: ids.caseB } : {}), ...(failure === 'client' ? { clientId: ids.clientB } : {}) })).rejects.toHaveProperty('code');
    expect(w.db.statements).toBe(statements);
    expect(w.bucket.gets).toBe(gets);
    expect(w.events.at(-1)?.outcome).toBe('denied');
  });

  it('rechecks authorization after an R2 get before reading its body', async () => {
    const w = setup(), a = await w.request(await w.upload()), get = w.bucket.get.bind(w.bucket);
    let bodies = 0;
    w.bucket.get = async (key) => {
      const r = await get(key);
      if (!key.startsWith('orig/') || !r) return r;
      w.state.allowed = false;
      return { ...r, async arrayBuffer() { bodies++; return r.arrayBuffer(); } };
    };
    await expect(w.ports.stager.stage(a)).rejects.toMatchObject({ code: 'forbidden' });
    expect(bodies).toBe(0);
    expect(w.db.rows('SELECT * FROM rs_results_version')).toEqual([]);
  });

  it('rechecks session after an awaited original body; no version is stored', async () => {
    const w = setup(), a = await w.request(await w.upload()), get = w.bucket.get.bind(w.bucket);
    w.bucket.get = async (key) => {
      const r = await get(key);
      return r && { ...r, async arrayBuffer() { const bytes = await r.arrayBuffer(); if (key.startsWith('orig/')) w.state.revoked = true; return bytes; } };
    };
    await expect(w.ports.stager.stage(a)).rejects.toMatchObject({ code: 'invalid-session' });
    expect(w.db.rows('SELECT * FROM rs_results_version')).toEqual([]);
  });

  it('refuses crossed DB/bucket deployment identity before original bytes', async () => {
    const w = setup(), a = await w.request(await w.upload());
    w.bucket.setRaw('identity/client.json', new TextEncoder().encode(JSON.stringify({ client_id: ids.clientB })));
    const before = w.bucket.gets;
    await expect(w.ports.stager.stage(a)).rejects.toMatchObject({ code: 'storage-unavailable', retryable: true });
    expect(w.bucket.gets - before).toBe(1);
  });

  it.each(['absent', 'zero', 'infinite', 'inconsistent'] as const)('has no default or malformed %s budget fallback', (failure) => {
    const w = setup();
    const budgets = failure === 'absent' ? null : { ...w.config.budgets, ...(failure === 'zero' ? { maxVerifyObjects: 0 } : failure === 'infinite' ? { maxVerifyBytes: Infinity } : { maxOriginalBytes: w.config.budgets.maxBufferedObjectBytes + 1 }) };
    expect(() => createHostedCandidateStager({ ...w.config, budgets: budgets as typeof w.config.budgets })).toThrow('storage-unavailable');
    expect(() => createHostedCandidateStager({ ...w.config, quotas: { ...w.config.quotas, maxVersionsPerCase: 0 } })).toThrow('storage-unavailable');
  });

  it.each(['maxPackageFiles', 'maxPackageFileBytes', 'maxPackageBytes', 'maxOriginalBytes', 'maxDocuments', 'maxVerifyObjects', 'maxVerifyBytes'] as const)('enforces %s', async (key) => {
    const d = docs(1)[0], w = setup(key === 'maxDocuments' ? [d, { ...d, ref: 'OD-002' }] : [d]), a = await w.request(await w.upload());
    const budgets = { ...w.config.budgets, [key]: 1 };
    if (key === 'maxPackageBytes') budgets.maxPackageFileBytes = 1;
    const ports = createHostedCandidateStager({ ...w.config, budgets });
    expect(await ports.stager.stage(a)).toMatchObject({ kind: 'refused', reason: 'over-budget' });
    expect(w.db.rows('SELECT * FROM rs_results_version')).toEqual([]);
  });

  it('reserves exactly the documented four-original-plus-package plan once, including conservative repeats', async () => {
    const w = setup(), a = await w.request(await w.upload());
    const plan = { objects: 4 + a.files.size, bytes: a.submission.manifest.files[0].size * 4 + [...a.files.values()].reduce((n, b) => n + b.length, 0) };
    const ports = createHostedCandidateStager({ ...w.config, budgets: { ...w.config.budgets, maxVerifyObjects: plan.objects, maxVerifyBytes: plan.bytes, maxVerifyObjectsPerCaseWindow: plan.objects, maxVerifyBytesPerCaseWindow: plan.bytes } });
    const before = w.bucket.gets;
    expect((await ports.stager.stage(a)).kind).toBe('staged');
    // One identity read from this scope and one from ResultsStaging's gate, plus exactly the reserved deep reads.
    expect(w.bucket.gets - before).toBe(plan.objects + 2);
    expect(w.db.rows<{ objects: number; bytes: number }>('SELECT objects, bytes FROM rs_verification_work')).toEqual([plan]);
    const gets = w.bucket.gets;
    await expect(ports.stager.stage(a)).rejects.toMatchObject({ code: 'busy', retryable: true });
    expect(w.bucket.gets - gets).toBe(1); // identity only; no duplicate deep window spent
  });

  it('does not claim success after audit failure or authority loss during the success audit', async () => {
    const w = setup(), a = await w.request(await w.upload());
    w.state.auditFails = true;
    await expect(w.ports.stager.stage(a)).rejects.toMatchObject({ code: 'audit-unavailable', retryable: true });
    w.state.auditFails = false;
    w.state.onAudit = () => { w.state.allowed = false; };
    await expect(w.ports.stager.stage(a)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('pins caller case, identity, buffers and submission before the first await', async () => {
    const w = setup(), a = await w.request(await w.upload());
    const pending = w.ports.stager.stage(a);
    a.caseId = ids.caseB;
    a.identity.manifestSha256 = '0'.repeat(64);
    a.files.get('assets.json')!.fill(0);
    const out = await pending;
    expect(out.kind).toBe('staged');
  });
});
