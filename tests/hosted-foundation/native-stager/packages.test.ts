import { afterEach, describe, expect, it } from 'vitest';
import { createHostedCandidateStager } from '../../../src/lib/server/runtime/hosted/candidate-stager.ts';
import { caseId, world } from './world.ts';
import { ids } from '../storage/fixture.ts';
const worlds: ReturnType<typeof world>[] = [];
const setup = () => { const w = world(undefined, true); worlds.push(w); return w; };
afterEach(() => { for (const w of worlds.splice(0)) w.db.sqlite.close(); });

describe('private correction package reader', () => {
  it('reads exact bounded bytes of a genuine durably audited current private candidate, not client publication', async () => {
    const w = setup(), { candidate } = await w.linked(await w.upload());
    const rv = candidate.link.candidate.resultsVersion;
    const out = await w.ports.packages.files({ clientId: ids.clientA, caseId, resultsVersion: rv });
    expect(out).toEqual(w.pkg.files);
    expect(w.db.rows('SELECT * FROM rs_publication')).toEqual([]);
    expect(w.events.filter((e) => e.action === 'results.native-package-read').at(-1)?.outcome).toBe('succeeded');
  });

  it('completes a real native reviewer correction using the returned package reader and real stager', async () => {
    const w = setup(), { service, token, candidate } = await w.linked(await w.upload());
    const matter = JSON.parse(new TextDecoder().decode(w.pkg.files.get('datasets/matter.json'))).data;
    matter.title = 'A corrected synthetic title';
    const out = await service.correct(token, { operationId: 'synthetic-correction', candidateId: candidate.candidateId, reason: 'Correct invented title', replacements: [{ key: 'matter', data: matter }] });
    expect(out.kind).toBe('linked');
    if (out.kind !== 'linked') return;
    expect(out.candidate.current).toBe(true);
    expect(out.candidate.link.candidate.resultsVersion).not.toBe(candidate.link.candidate.resultsVersion);
    expect(await w.ports.packages.files({ clientId: ids.clientA, caseId, resultsVersion: candidate.link.candidate.resultsVersion })).toBeNull();
  });

  it('does not expose a merely staged version without a native current link', async () => {
    const w = setup(), a = await w.request(await w.upload());
    expect((await w.ports.stager.stage(a)).kind).toBe('staged');
    const before = w.bucket.gets;
    expect(await w.ports.packages.files({ clientId: ids.clientA, caseId, resultsVersion: a.identity.resultsVersion })).toBeNull();
    expect(w.bucket.gets - before).toBe(1);
  });

  it.each(['case', 'client', 'operate'] as const)('denies %s before private package metadata', async (failure) => {
    const w = setup(), { candidate } = await w.linked(await w.upload());
    if (failure === 'operate') w.state.allowed = false;
    const statements = w.db.statements, gets = w.bucket.gets;
    await expect(w.ports.packages.files({ clientId: failure === 'client' ? ids.clientB : ids.clientA, caseId: failure === 'case' ? ids.caseB : caseId, resultsVersion: candidate.link.candidate.resultsVersion })).rejects.toHaveProperty('code');
    expect(w.db.statements).toBe(statements);
    expect(w.bucket.gets).toBe(gets);
  });

  it('checks all stored bytes, not only the manifest or R2 metadata', async () => {
    const w = setup(), { candidate } = await w.linked(await w.upload());
    const object = w.db.rows<{ object_key: string }>("SELECT object_key FROM rs_package_file WHERE path = 'datasets/chronology.json'")[0].object_key;
    w.bucket.tamper(object, (b) => { b[b.length - 5] ^= 1; return b; });
    await expect(w.ports.packages.files({ clientId: ids.clientA, caseId, resultsVersion: candidate.link.candidate.resultsVersion })).rejects.toMatchObject({ code: 'integrity' });
  });

  it('reserves package verification separately and refuses an oversized plan before any package bytes', async () => {
    const w = setup(), { candidate } = await w.linked(await w.upload());
    const ports = createHostedCandidateStager({ ...w.config, budgets: { ...w.config.budgets, maxVerifyObjects: 1 } });
    const before = w.bucket.gets;
    await expect(ports.packages.files({ clientId: ids.clientA, caseId, resultsVersion: candidate.link.candidate.resultsVersion })).rejects.toMatchObject({ code: 'over-budget', retryable: false });
    expect(w.bucket.gets - before).toBe(1);
  });

  it('rejects a package row outside its content key without reading that object', async () => {
    const w = setup(), { candidate } = await w.linked(await w.upload());
    w.db.exec("UPDATE rs_package_file SET object_key = 'foreign/raw' WHERE path = 'assets.json'");
    const before = w.bucket.gets;
    await expect(w.ports.packages.files({ clientId: ids.clientA, caseId, resultsVersion: candidate.link.candidate.resultsVersion })).rejects.toMatchObject({ code: 'integrity' });
    expect(w.bucket.gets - before).toBe(1);
  });

  it('rechecks currentness after the final audited await and never releases stale correction bytes', async () => {
    const w = setup(), { candidate } = await w.linked(await w.upload());
    // The genuine settlement table is immutable. A test-only dropped trigger simulates a changed authority/currentness
    // state between reader awaits, without replacing the candidate repository or returning a forged current boolean.
    w.state.onAudit = () => {
      for (const r of w.db.rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'native_candidate_audit_settlement'")) w.db.sqlite.exec(`DROP TRIGGER "${r.name}"`);
      w.db.exec('DELETE FROM native_candidate_audit_settlement');
      w.state.onAudit = null;
    };
    await expect(w.ports.packages.files({ clientId: ids.clientA, caseId, resultsVersion: candidate.link.candidate.resultsVersion })).rejects.toMatchObject({ code: 'integrity' });
  });

  it('does not release private bytes on audit failure or revoked authority after an R2 await', async () => {
    const w = setup(), { candidate } = await w.linked(await w.upload()), args = { clientId: ids.clientA, caseId, resultsVersion: candidate.link.candidate.resultsVersion };
    w.state.auditFails = true;
    await expect(w.ports.packages.files(args)).rejects.toMatchObject({ code: 'audit-unavailable' });
    w.state.auditFails = false;
    const get = w.bucket.get.bind(w.bucket);
    w.bucket.get = async (key) => { const r = await get(key); if (key.startsWith('pkg/')) w.state.allowed = false; return r; };
    await expect(w.ports.packages.files(args)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
