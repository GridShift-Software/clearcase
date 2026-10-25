import { afterEach, describe, expect, it } from 'vitest';
import { createPrivatePreview } from '../../../src/lib/server/runtime/hosted/private-preview.ts';
import { ids } from '../storage/fixture.ts';
import { CLIENT, caseId, meter, now, previewWorld, STAFF, type PreviewWorld } from './fixture.ts';

/** Workers Free: 50 subrequests and 50 D1 queries per invocation, five of each kept as headroom (WORKERS_FREE_REQUEST). */
const FREE = { external: 45, d1: 45 };
const worlds: PreviewWorld[] = [];
afterEach(() => { for (const p of worlds.splice(0)) p.w.db.sqlite.close(); });
const setup = async () => { const p = await previewWorld(); worlds.push(p); return p; };

/** The preview as services.ts composes it: this request's identity, its audited operate admission and the grant as SQL. */
function previewFor(p: PreviewWorld, who = p.operator, clientId = ids.clientA) {
  const authority = p.authorityOf(who);
  return createPrivatePreview({ clientId, identity: who.identity, db: p.w.db, audit: who.audit, now,
    authorizeOperate: (a) => authority.authorizeOperate({ ...a, capability: 'operate' }), operateCondition: (a) => authority.operate.condition(a) })!;
}
const read = (p: PreviewWorld, o: { caseId?: string; candidateId?: string } = {}, who = p.operator) =>
  previewFor(p, who).read({ caseId: o.caseId ?? caseId, candidateId: o.candidateId ?? p.candidate.candidateId });
/** Nothing but the read's own audit is written: no publication, sign-off, render evidence or user work. */
function nothingWritten(p: PreviewWorld) {
  for (const table of ['rs_publication', 'pub_signoff', 'pub_operation', 'rs_preview', 'uw_note'])
    if (p.w.db.sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(table)) expect(p.count(`SELECT COUNT(*) AS n FROM ${table}`)).toBe(0);
}
const events = (p: PreviewWorld, action: string) => p.w.db.sqlite.prepare('SELECT outcome FROM native_audit_events WHERE action = ? ORDER BY seq').all(action) as { outcome: string }[];

describe('private candidate preview: authority', () => {
  it('refuses a client principal holding a content grant on the case, before any candidate data', async () => {
    const p = await setup();
    p.grant('synthetic-client', 'viewer', 'client');
    const client = p.identityOf({ issuer: CLIENT, subject: 'synthetic-client', kind: 'client' });
    await expect(read(p, {}, client)).rejects.toMatchObject({ code: 'forbidden' });
    expect(events(p, 'results.preview-candidate')).toEqual([]);
  });

  it('refuses a candidate of another case, even to an operator of both cases, as not found', async () => {
    const p = await setup();
    await expect(read(p, { caseId: p.caseB })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('refuses a case the operator holds nothing on, and an unknown candidate id', async () => {
    const p = await setup();
    await expect(read(p, { caseId: p.otherCase })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(read(p, { candidateId: 'cand-00000000000000000000000000000000' })).rejects.toMatchObject({ code: 'not-found' });
  });

  it.each(['operate', 'content'] as const)('requires both operate and content authority: refuses without %s', async (lost) => {
    const p = await setup();
    (lost === 'operate' ? p.revokeOperate : p.revokeContent)();
    await expect(read(p)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses another client deployment and an unverified identity', async () => {
    const p = await setup();
    await expect(previewFor(p, p.operator, ids.clientB).read({ caseId, candidateId: p.candidate.candidateId })).rejects.toMatchObject({ code: 'wrong-client' });
    const anonymous = { ...p.operator, identity: { kind: 'anonymous', principal: null, sessionId: null, clientId: ids.clientA, checkRevocation: async () => {}, authorize: async () => {} } } as unknown as typeof p.operator;
    await expect(read(p, {}, anonymous)).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

describe('private candidate preview: stored state', () => {
  it('refuses a superseded candidate as not found', async () => {
    const p = await setup();
    // Storage state only: a correction's supersession row, written past the migration's trigger, which needs a real correction.
    p.w.db.sqlite.exec('DROP TRIGGER native_supersession_insert_once');
    p.w.db.exec("INSERT INTO native_candidate_supersession (client_id, case_id, old_candidate_id, new_candidate_id, reason, operator_issuer, operator_subject, at) VALUES (?, ?, ?, 'cand-synthetic-newer', 'synthetic', ?, 'synthetic-operator', ?)",
      ids.clientA, caseId, p.candidate.candidateId, STAFF, now().toISOString());
    await expect(read(p)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('refuses a candidate whose audit settlement is absent (not durably audited) as not found', async () => {
    const p = await setup();
    p.w.db.sqlite.exec('DROP TRIGGER native_audit_settlement_no_delete');
    p.w.db.exec('DELETE FROM native_candidate_audit_settlement WHERE candidate_id = ?', p.candidate.candidateId);
    await expect(read(p)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('refuses a stored read model whose rows no longer hash to the version', async () => {
    const p = await setup();
    p.w.db.exec("UPDATE rs_document SET list_json = replace(list_json, 'Invented subject 1', 'Tampered') WHERE ref = 'JN-001'");
    await expect(read(p)).rejects.toMatchObject({ code: 'integrity' });
  });
});

describe('private candidate preview: the read', () => {
  it('shows the exact current candidate privately within one Workers Free request, mapped originals and missing ones explicit', async () => {
    const p = await setup(), n = meter(p);
    p.clerk.calls = 0;
    const out = await read(p);
    console.log('[preview-cost]', JSON.stringify({ clerk: p.clerk.calls, d1: n.d1, r2: n.r2 }));
    expect(p.clerk.calls).toBeLessThanOrEqual(FREE.external);
    expect(n.d1).toBeLessThanOrEqual(FREE.d1);
    expect(n.r2).toBe(0);
    const pin = p.candidate.link.candidate;
    expect(out).toMatchObject({ state: 'private-candidate-not-published', caseId, candidateId: p.candidate.candidateId, linkId: p.candidate.link.linkId,
      resultsVersion: pin.resultsVersion, manifestSha256: pin.manifestSha256, packageInputRevisionId: pin.packageInputRevisionId,
      submissionRevisionId: p.candidate.link.submissionRevisionId, attribution: 'manual-operator-link-not-processing-proof' });
    expect(out.overview.resultsVersion).toBe(pin.resultsVersion);
    expect(out.rows.map((r) => r.ref)).toEqual(['JN-001', 'JN-002']);
    expect(out.originals).toEqual([{ ref: 'JN-001', assetId: p.assetId, path: 'synthetic-client-a.pdf', mediaType: 'application/pdf', size: 44, inline: true }]);
    expect(out.unavailable).toEqual(p.candidate.link.coverage.unavailableOriginals);
    expect(out.unavailable.map((u) => u.ref)).toEqual(['JN-002', 'P-d951f19ec198c55f']);
    // No raw storage key, digest-addressed object path or audit intent reaches the page.
    expect(JSON.stringify(out)).not.toMatch(/orig\/|pkg\/|preview\/|event_json|sessionId/);
    expect(events(p, 'results.preview-candidate').map((e) => e.outcome)).toEqual(['succeeded']);
    nothingWritten(p);
  });

  const measured = async () => { const p = await setup(); p.clerk.calls = 0; await read(p); const k = p.clerk.calls; p.w.db.sqlite.close(); worlds.splice(worlds.indexOf(p), 1); return k; };
  it('answers a session, operate grant or content grant lost at any of its session checks as that denial, never data', async () => {
    const total = await measured();
    expect(total).toBeGreaterThanOrEqual(2);
    for (let k = 1; k <= total; k++) for (const lost of ['session', 'operate', 'content'] as const) {
      const p = await setup();
      p.clerk.calls = 0;
      p.clerk.onClerk = (c) => { if (c !== k) return; if (lost === 'session') p.clerk.revoked = true; else (lost === 'operate' ? p.revokeOperate : p.revokeContent)(); };
      await expect(read(p), `${lost} at ${k}`).rejects.toMatchObject({ code: lost === 'session' ? 'invalid-session' : 'forbidden' });
      nothingWritten(p);
    }
  });

  it('refuses when the candidate is superseded after its data was read, at the final fence', async () => {
    const p = await setup();
    p.clerk.calls = 0;
    const total = await measured();
    p.w.db.sqlite.exec('DROP TRIGGER native_supersession_insert_once');
    p.clerk.onClerk = (c) => {
      if (c === total) p.w.db.exec("INSERT INTO native_candidate_supersession (client_id, case_id, old_candidate_id, new_candidate_id, reason, operator_issuer, operator_subject, at) VALUES (?, ?, ?, 'cand-synthetic-newer', 'synthetic', ?, 'synthetic-operator', ?)",
        ids.clientA, caseId, p.candidate.candidateId, STAFF, now().toISOString());
    };
    await expect(read(p)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('releases nothing when its audit cannot be recorded', async () => {
    const p = await setup();
    const prepare = p.w.db.prepare.bind(p.w.db);
    p.w.db.prepare = (sql) => {
      const s = prepare(sql);
      if (!/^INSERT INTO native_audit_events/.test(sql)) return s;
      return { ...s, bind: (...v: unknown[]) => {
        const b = s.bind(...(v as never[]));
        const fail = v.some((x) => typeof x === 'string' && x.includes('"results.preview-candidate"'));
        const boom = async () => { throw new Error('synthetic audit fault'); };
        return fail ? { ...b, run: boom, first: boom, all: boom } : b;
      } } as typeof s;
    };
    await expect(read(p)).rejects.toMatchObject({ code: 'audit-unavailable' });
  });
});
