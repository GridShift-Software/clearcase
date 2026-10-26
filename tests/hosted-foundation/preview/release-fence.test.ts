// The import service releases link metadata only after its final fence: a fresh session check and one SQL statement that
// holds the operate grant and the exact verified row, link, audit event and settlement. Every hash, parse and correction
// read happens before it, and nothing asynchronous follows it. The concurrent actor here loses the grant or the session
// (or changes a row) in the gap an await leaves, which is where the fence used to be too early.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { d1NativeCandidateRepository } from '../../../src/lib/results-review/native/repository.ts';
import { ids } from '../storage/fixture.ts';
import { caseId, previewWorld, type PreviewWorld } from './fixture.ts';
import { audited, d1, d1Has, digest, fenceStep, trace } from './trace.ts';

const worlds: PreviewWorld[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const p of worlds.splice(0)) p.w.db.sqlite.close(); });
// Corrections are refused on the Free request budget, so this world is uncapped and holds the matter dataset a correction replaces.
const setup = async () => { const p = await previewWorld({ requestBudget: null, matter: true }); worlds.push(p); return p; };
// The alpha's package on the Free budget, exactly as production composes it.
const setupFree = async () => { const p = await previewWorld(); worlds.push(p); return p; };

const SETTLE = 'INSERT INTO native_candidate_audit_settlement';
const LOSS = { grant: 'forbidden', session: 'invalid-session' } as const;
type Loss = keyof typeof LOSS;
const KINDS = ['grant', 'session'] as const;
const lose = (p: PreviewWorld, kind: Loss) => { if (kind === 'grant') p.revokeOperate(); else p.clerk.revoked = true; };
const admit = (p: PreviewWorld, access: 'read' | 'write') => p.service.admit({ identity: p.operator.identity, caseId, access });

const repeatImport = async (p: PreviewWorld) => p.service.importPackage(await admit(p, 'write'),
  { operationId: 'synthetic-preview-import', submissionRevisionId: p.candidate.link.submissionRevisionId, files: p.pkg.files });
async function correct(p: PreviewWorld, operationId: string, candidateId = p.candidate.candidateId) {
  const matter = JSON.parse(new TextDecoder().decode(p.pkg.files.get('datasets/matter.json'))).data;
  return p.service.correct(await admit(p, 'write'), { operationId, candidateId, reason: 'Synthetic release fence', replacements: [{ key: 'matter', data: { ...matter, title: `Corrected by ${operationId}` } }] });
}
const read = async (p: PreviewWorld) => p.service.readCandidate(await admit(p, 'read'), p.candidate.candidateId);
const list = async (p: PreviewWorld) => p.service.listCandidates(await admit(p, 'read'));

/** The requests that answer a link after settling its audit: a repeat of the genuine import, and a fresh and a repeated correction. */
const SETTLING = {
  'a repeated import': async (p: PreviewWorld) => () => repeatImport(p),
  'a fresh correction': async (p: PreviewWorld) => () => correct(p, 'fence-fresh'),
  'a repeated correction': async (p: PreviewWorld) => { await correct(p, 'fence-repeat'); return () => correct(p, 'fence-repeat'); },
};
type Settling = keyof typeof SETTLING;
const names = Object.keys(SETTLING) as Settling[];

describe('a grant or session lost while a settled candidate is verified is never answered as a link', () => {
  describe.each(names)('%s', (name) => {
    it.each(KINDS)('refuses as its denial when the %s is lost at the first hash after the settlement', async (kind) => {
      const p = await setup(), run = await SETTLING[name](p), t = trace(p.w.db);
      t.when([d1(SETTLE), digest], () => lose(p, kind));
      let value: unknown;
      await expect(run().then((v) => { value = v; })).rejects.toMatchObject({ code: LOSS[kind] });
      expect(value).toBeUndefined();
    });
  });
  it.each(KINDS)('refuses a correction as its denial when the %s is lost at its first correction read after the settlement', async (kind) => {
    const p = await setup(), run = await SETTLING['a repeated correction'](p), t = trace(p.w.db);
    t.when([d1(SETTLE), d1Has('FROM native_correction_change')], () => lose(p, kind));
    await expect(run()).rejects.toMatchObject({ code: LOSS[kind] });
  });
  it.each(KINDS)('refuses a repeated import as its denial when the %s is lost at the third hash after the settlement, not only the first', async (kind) => {
    const p = await setup(), t = trace(p.w.db);
    t.when([d1(SETTLE), digest, digest, digest], () => lose(p, kind));
    await expect(repeatImport(p)).rejects.toMatchObject({ code: LOSS[kind] });
  });
  describe('on the alpha package within the Free request budget', () => {
    it.each(KINDS)('refuses a repeated import as its denial when the %s is lost at the first hash after the settlement', async (kind) => {
      const p = await setupFree(), t = trace(p.w.db);
      t.when([d1(SETTLE), digest], () => lose(p, kind));
      await expect(repeatImport(p)).rejects.toMatchObject({ code: LOSS[kind] });
    });
    it('ends a repeated import on the statement that holds the operate grant', async () => {
      const p = await setupFree(), t = trace(p.w.db);
      expect(await repeatImport(p)).toMatchObject({ kind: 'linked', repeated: true });
      expect(t.log.slice(t.last(fenceStep) + 1)).toEqual([]);
    });
  });
});

describe('the final fence is the last thing a release does', () => {
  const answers: [string, (p: PreviewWorld) => Promise<() => Promise<unknown>>][] = [
    ...names.map((n): [string, (p: PreviewWorld) => Promise<() => Promise<unknown>>] => [n, SETTLING[n]]),
    ['an audited candidate read', async (p) => () => read(p)],
    ['an audited candidate list', async (p) => () => list(p)],
  ];
  it.each(answers)('%s ends on the statement that holds the operate grant, with no hash, parse or query after it', async (_n, make) => {
    const p = await setup(), run = await make(p), t = trace(p.w.db);
    const start = t.log.length;
    const out = await run();
    expect(out).toBeTruthy();
    const lastFence = t.last(fenceStep);
    expect(lastFence).toBeGreaterThan(start);
    expect(t.log.slice(lastFence + 1)).toEqual([]);
  });
});

describe('the fence holds the exact verified rows, not any id', () => {
  const dropWriteOnceTriggers = (p: PreviewWorld) => {
    for (const r of p.w.db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'native_%'").all() as { name: string }[]) p.w.db.sqlite.exec(`DROP TRIGGER ${r.name}`);
  };
  const FFFF = 'f'.repeat(64);
  const swaps: Record<string, string[]> = {
    'the link digest': [`UPDATE native_import_link SET link_sha256 = '${FFFF}'`],
    'the link id': ["UPDATE native_import_link SET link_id = 'link-substituted'"],
    'the audit event digest': [`UPDATE native_candidate_audit_intent SET event_sha256 = '${FFFF}'`],
    'the audit event id': ["UPDATE native_candidate_audit_intent SET event_id = 'native-substituted'"],
    'the settlement': ['DELETE FROM native_candidate_audit_settlement'],
  };
  it.each(Object.entries(swaps))('does not answer a repeated import when %s is replaced after it was verified', async (_n, statements) => {
    const p = await setup(), t = trace(p.w.db);
    t.when([d1(SETTLE), digest], () => { p.w.db.sqlite.exec('PRAGMA foreign_keys = OFF'); dropWriteOnceTriggers(p); for (const s of statements) p.w.db.sqlite.exec(s); });
    await expect(repeatImport(p)).rejects.toBeTruthy();
  });

  it('does not answer a stale current when a genuine correction supersedes the candidate after it was verified, and a retry answers the truth', async () => {
    const p = await setup(), t = trace(p.w.db);
    t.when([d1(SETTLE), digest], async () => { expect((await correct(p, 'fence-supersede')).kind).toBe('linked'); });
    await expect(repeatImport(p)).rejects.toMatchObject({ code: 'storage-unavailable', retryable: true });
    vi.restoreAllMocks();
    const again = await repeatImport(p);
    expect(again).toMatchObject({ kind: 'linked', repeated: true, candidate: { candidateId: p.candidate.candidateId, current: false } });
  });
});

describe('audited reads release only under a fresh fence', () => {
  it.each(KINDS)('refuses a candidate read as its denial when the %s is lost while its audit event is written', async (kind) => {
    const p = await setup(), t = trace(p.w.db);
    t.when([audited('results.read-candidate')], () => lose(p, kind));
    await expect(read(p)).rejects.toMatchObject({ code: LOSS[kind] });
  });
  it.each(KINDS)('refuses a candidate list as its denial when the %s is lost while its audit event is written', async (kind) => {
    const p = await setup(), t = trace(p.w.db);
    t.when([audited('results.read-candidate')], () => lose(p, kind));
    await expect(list(p)).rejects.toMatchObject({ code: LOSS[kind] });
  });
  it('answers the same candidates when nothing is lost, with one audit event each', async () => {
    const p = await setup();
    expect(await read(p)).toMatchObject({ candidateId: p.candidate.candidateId, current: true });
    expect((await list(p)).map((c) => c.candidateId)).toEqual([p.candidate.candidateId]);
    expect(p.count("SELECT COUNT(*) AS n FROM native_audit_events WHERE action = 'results.read-candidate'")).toBe(2);
  });
});

describe('genuine repeat, retry and audit-failure semantics', () => {
  it('repeats the genuine import as the same settled candidate', async () => {
    const p = await setup();
    expect(await repeatImport(p)).toMatchObject({ kind: 'linked', repeated: true, candidate: { candidateId: p.candidate.candidateId, current: true, origin: 'import' } });
    expect(p.count('SELECT COUNT(*) AS n FROM native_candidate')).toBe(1);
  });
  it('keeps a candidate noncurrent when its audit fails, then answers it once the same operation is retried', async () => {
    const p = await setup(), prepare = p.w.db.prepare.bind(p.w.db);
    let fail = false;
    p.w.db.prepare = (sql) => {
      const s = prepare(sql);
      if (!/^INSERT INTO native_audit_events/.test(sql)) return s;
      return { ...s, bind: (...v: unknown[]) => { const b = s.bind(...(v as never[])); return fail && v.some((x) => typeof x === 'string' && x.includes('"results.correct-candidate"')) ? { ...b, run: async () => { throw new Error('synthetic audit fault'); } } : b; } } as typeof s;
    };
    const matterFailing = async () => { fail = true; await expect(correct(p, 'fence-audit-failure')).rejects.toThrow(); fail = false; };
    await matterFailing();
    expect(p.count('SELECT COUNT(*) AS n FROM native_candidate')).toBe(2);
    expect(p.count('SELECT COUNT(*) AS n FROM native_candidate_audit_settlement')).toBe(1);
    expect(await correct(p, 'fence-audit-failure')).toMatchObject({ kind: 'linked', repeated: true, candidate: { origin: 'correction', current: true } });
    expect(p.count('SELECT COUNT(*) AS n FROM native_candidate_audit_settlement')).toBe(2);
  });
  it('does not let an existing settlement bless another event id or the same id with changed bytes', async () => {
    const p = await setupFree(), repo = d1NativeCandidateRepository(p.w.db);
    const intent = await repo.auditIntent({ clientId: ids.clientA, caseId, candidateId: p.candidate.candidateId });
    const settled = () => p.count('SELECT COUNT(*) AS n FROM native_candidate_audit_settlement');
    const before = settled();
    for (const event of [{ ...intent.event, eventId: `${intent.event.eventId}-forged` }, { ...intent.event, outcome: 'denied' as const }]) {
      await expect(repo.settleAudit({ ...intent, event })).rejects.toMatchObject({ code: 'integrity' });
      expect(settled()).toBe(before);
    }
    expect(await repo.settleAudit(intent)).toMatchObject({ candidateId: p.candidate.candidateId, current: true });
  });
});
