import { describe, expect, it } from 'vitest';
import { verifyEvidence } from '../../../src/lib/publication/hosted/evidence/index.ts';
import { d1PublicationLedger } from '../../../src/lib/publication/hosted/ledger.ts';
import type { SignoffRecord } from '../../../src/lib/publication/hosted/ports.ts';
import { SqliteD1 } from '../hosted/doubles.ts';
import { CANDIDATE, CASE, CLIENT, NOW, PRINCIPAL, RV, hash, world } from './harness.ts';

// U5 (real-export design 2): sign-off binds the evidence root, publish recomputes it from the item rows, and acknowledgements are
// grouped. The evidence is written by U3's real engine into the real evidence tables; the controller, ledger and publisher are the
// real ones over the real native schema.

describe('decisive: an evidence row altered after sign-off', () => {
  it('refuses publish with candidate-changed and leaves the published pointer unchanged', async () => {
    const w = await world();
    const signed = await w.signOff();
    expect(signed.status).toBe(201);
    const signoffId = signed.body.signoffId as string;
    expect(w.pointer()).toBeNull();

    // Alter one row of the sealed generation. The 0005 seals refuse this, so the seal is removed first: this is a database that was
    // edited behind the application, which is what publish must not trust.
    w.db.exec('DROP TRIGGER pub_evidence_item_update_seal');
    const before = w.db.rows<{ item_json: string }>("SELECT item_json FROM pub_evidence_item WHERE item_key = 'preview/asset-00007'")[0]!.item_json;
    w.db.exec("UPDATE pub_evidence_item SET item_json = replace(item_json, 'renderer/1', 'renderer/2') WHERE item_key = 'preview/asset-00007'");
    expect(w.db.rows<{ item_json: string }>("SELECT item_json FROM pub_evidence_item WHERE item_key = 'preview/asset-00007'")[0]!.item_json).not.toBe(before);
    // Premise: the stored metadata (counts, greatest key, page digests) cannot see this, so only a recomputation from the rows can.
    expect(await verifyEvidence(w.store, w.binding)).toMatchObject({ ok: true });

    const refused = await w.publish(signoffId);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'signoff-stale', reason: 'candidate-changed' });
    expect(w.pointer()).toBeNull();
    expect(w.receipts()).toEqual([]);
    expect(w.signoffRow(signoffId).invalidated_reason).toBe('candidate-changed');
  });
});

describe('a v2 sign-off and publish', () => {
  it('binds the evidence root, retains every warning, and groups the acknowledgements by code with one reason each', async () => {
    const w = await world();
    const all = w.items.filter(i => i.key.startsWith('warning/')).length;
    const signed = await w.signOff();
    expect(signed).toMatchObject({ status: 201, body: { state: 'signed-off' } });
    const row = w.signoffRow(signed.body.signoffId as string);
    expect(JSON.parse(row.warning_fingerprints!)).toHaveLength(all);
    const stored = JSON.parse(row.acknowledgements!) as { groups: { code: string; reason: string; fingerprints: string[] }[] };
    expect(stored.groups.map(g => g.code).sort()).toEqual(['DS_UNSUPPORTED_FIELD', 'V5_META_COUNT_DISAGREEMENT']);
    expect(stored.groups.every(g => g.reason.length > 0)).toBe(true);
    expect(stored.groups.flatMap(g => g.fingerprints).sort()).toEqual([...w.fresh()].sort());
    expect(w.db.rows('SELECT signoff_id, candidate_id, generation, evidence_root FROM pub_signoff_evidence')).toEqual([
      { signoff_id: signed.body.signoffId, candidate_id: CANDIDATE, generation: '1', evidence_root: w.root }]);
  });

  it('publishes when nothing changed, and the receipt names the evidence root that was signed', async () => {
    const w = await world();
    const signed = await w.signOff();
    const done = await w.publish(signed.body.signoffId as string);
    expect(done.status).toBe(200);
    expect(w.pointer()).toMatchObject({ state: 'published' });
    const intent = JSON.parse((w.receipts()[0] as { intent_json: string }).intent_json) as { signedIdentity: { evidence: { root: string; generation: string; candidateId: string } } };
    expect(intent.signedIdentity.evidence).toEqual({ candidateId: CANDIDATE, generation: '1', root: w.root });
  });

  it('refuses a sign-off that names a different evidence root than the one now sealed', async () => {
    const w = await world();
    const identity = { ...(await w.claimed()), evidenceRoot: 'f'.repeat(64) };
    const refused = await w.signOff({ identity });
    expect(refused).toMatchObject({ status: 409, body: { code: 'stale-candidate', fields: ['evidenceRoot'] } });
    expect(w.db.rows('SELECT * FROM pub_signoff')).toEqual([]);
  });

  it('writes the sign-off before its evidence row, in one batch', async () => {
    const w = await world();
    w.db.batches.length = 0;
    await w.signOff();
    const batch = w.db.batches.find(b => b.some(s => s.includes('INSERT INTO pub_signoff_evidence')))!;
    expect(batch.findIndex(s => s.startsWith('INSERT INTO pub_signoff ')) ).toBeGreaterThanOrEqual(0);
    expect(batch.findIndex(s => s.startsWith('INSERT INTO pub_signoff '))).toBeLessThan(batch.findIndex(s => s.includes('INSERT INTO pub_signoff_evidence')));
  });
});

describe('grouped acknowledgements', () => {
  it('refuses a group with no reason, with every warning still unacknowledged', async () => {
    const w = await world();
    const groups = w.groups(); groups[0]!.reason = '   ';
    expect(await w.signOff({ acknowledgements: groups })).toMatchObject({ status: 422, body: { code: 'ack-reason' } });
  });
  it('refuses a fingerprint listed twice, a fingerprint that needs no acknowledgement, and one left out', async () => {
    const w = await world();
    const twice = w.groups(); twice[1]!.fingerprints.push(twice[0]!.fingerprints[0]!);
    expect(await w.signOff({ acknowledgements: twice })).toMatchObject({ status: 422, body: { code: 'ack-not-exact' } });
    const baseline = w.groups(); baseline[0]!.fingerprints.push('0'.repeat(32));
    expect(await w.signOff({ acknowledgements: baseline })).toMatchObject({ status: 422, body: { code: 'ack-not-exact' } });
    const short = w.groups(); short[0]!.fingerprints.pop();
    expect(await w.signOff({ acknowledgements: short })).toMatchObject({ status: 422, body: { code: 'ack-incomplete' } });
    expect(w.db.rows('SELECT * FROM pub_signoff')).toEqual([]);
  });
  it('refuses a per-warning list on a v2 candidate', async () => {
    const w = await world();
    const flat = w.fresh().map(fingerprint => ({ fingerprint, reason: 'ok' }));
    expect(await w.signOff({ acknowledgements: flat })).toMatchObject({ status: 422, body: { code: 'invalid-request' } });
  });
});

describe('the evidence root is checked again at publish', () => {
  it('refuses a row added to the sealed generation after sign-off', async () => {
    const w = await world();
    const signed = await w.signOff();
    await w.freezeSnapshot();
    w.db.exec(`INSERT INTO pub_evidence_item (candidate_id, generation, item_key, item_json) VALUES ('${CANDIDATE}', '1', 'warning/${'f'.repeat(32)}', '{"input":{},"observation":{"kind":"warning","fingerprint":"${'f'.repeat(32)}"}}')`);
    const refused = await w.publish(signed.body.signoffId as string);
    expect(refused).toMatchObject({ status: 409, body: { code: 'signoff-stale', reason: 'candidate-changed' } });
    expect(w.pointer()).toBeNull();
  });

  it('refuses a row that appears after the last recheck and before the pointer write', async () => {
    const w = await world();
    const signed = await w.signOff();
    await w.freezeSnapshot();
    w.db.beforeBatch = () => w.db.exec(`INSERT INTO pub_evidence_item (candidate_id, generation, item_key, item_json) VALUES ('${CANDIDATE}', '1', 'warning/${'e'.repeat(32)}', '{}')`);
    const refused = await w.publish(signed.body.signoffId as string);
    expect(refused.status).toBe(409);
    expect(w.pointer()).toBeNull();
    expect(w.receipts()).toEqual([]);
  });

  it('refuses a row changed in place, with the count unchanged, after the last recheck and before the pointer write', async () => {
    const w = await world();
    const signed = await w.signOff();
    // The same fault model as the decisive test: the update seal is gone, so only the commit's own guard can see the change.
    w.db.exec('DROP TRIGGER pub_evidence_item_update_seal');
    w.db.beforeBatch = () => w.db.exec("UPDATE pub_evidence_item SET item_json = replace(item_json, 'renderer/1', 'renderer/2') WHERE item_key = 'preview/asset-00007'");
    const refused = await w.publish(signed.body.signoffId as string);
    expect(w.db.rows("SELECT item_json FROM pub_evidence_item WHERE item_key = 'preview/asset-00007'")[0]!.item_json).toContain('renderer/2');
    expect(refused).toMatchObject({ status: 409, body: { code: 'signoff-stale' } });
    expect(w.pointer()).toBeNull();
    expect(w.receipts()).toEqual([]);
  });

  it('refuses a sign-off whose evidence row names another candidate', async () => {
    const w = await world();
    const signed = await w.signOff();
    w.db.exec('DROP TRIGGER pub_signoff_evidence_update_seal');
    w.db.exec("UPDATE pub_signoff_evidence SET candidate_id = 'candidate-other'");
    expect(await w.publish(signed.body.signoffId as string)).toMatchObject({ status: 409, body: { code: 'signoff-stale', reason: 'candidate-changed' } });
    expect(w.pointer()).toBeNull();
  });

  it('answers 503 and keeps the sign-off effective when the evidence cannot be read', async () => {
    const w = await world();
    const signed = await w.signOff();
    w.db.failReads = /FROM pub_evidence_run r JOIN pub_evidence_item i/;
    expect((await w.publish(signed.body.signoffId as string)).status).toBe(503);
    w.db.failReads = null;
    expect(w.signoffRow(signed.body.signoffId as string).invalidated_at).toBeNull();
    expect(w.pointer()).toBeNull();
  });

  it('refuses a sign-off for a candidate that now reads as v1, and does not read the case at all without the evidence port', async () => {
    const w = await world();
    const signed = await w.signOff();
    w.flipSnapshotToV1();
    expect(await w.publish(signed.body.signoffId as string)).toMatchObject({ status: 409, body: { code: 'signoff-stale' } });
    const bare = await world();
    delete (bare.ports as { signoffEvidence?: unknown }).signoffEvidence;
    expect((await bare.signOff()).status).toBe(503);
    expect(CASE).toBeTruthy();
  });
});

describe('at the size of a real export', () => {
  it('signs off and publishes 2,500 warnings and 1,689 previews, every fingerprint listed, in reads of at most 500 rows', async () => {
    const w = await world({ spec: { previews: 1689, warnings: 2500 }, baseline: 100 });
    const groups = w.groups(3);
    expect(groups.flatMap(g => g.fingerprints)).toHaveLength(2400);
    const body = JSON.stringify(groups);
    expect(body.length).toBeGreaterThan(64 * 1024);
    const signed = await w.signOff({ acknowledgements: groups });
    expect(signed.status).toBe(201);
    const row = w.signoffRow(signed.body.signoffId as string);
    expect(JSON.parse(row.warning_fingerprints!)).toHaveLength(2500);
    const stored = JSON.parse(row.acknowledgements!) as { groups: { reason: string; fingerprints: string[] }[] };
    expect(stored.groups).toHaveLength(3);
    expect(stored.groups.flatMap(g => g.fingerprints)).toHaveLength(2400);
    w.db.sql.length = 0;
    const done = await w.publish(signed.body.signoffId as string);
    expect(done.status).toBe(200);
    // 4,192 rows are hashed in pages of 500: nine full reads, one short read, and no more.
    expect(w.db.sql.filter(q => q.includes('FROM pub_evidence_run r JOIN pub_evidence_item i')).length).toBeLessThanOrEqual(10);
    expect(w.pointer()).toMatchObject({ state: 'published' });
  }, 60_000);

  it('keeps the 64 KiB bound for a candidate that is not v2', async () => {
    const w = await world(), identity = await w.claimed();
    w.flipSnapshotToV1();
    const padded = await w.signOff({ identity, padding: 'x'.repeat(70_000) });
    expect(padded).toMatchObject({ status: 413, body: { code: 'too-large' } });
  });
  it('lets a v2 candidate through that bound only to be judged on its own fields', async () => {
    const w = await world();
    expect(await w.signOff({ padding: 'x'.repeat(70_000) })).toMatchObject({ status: 422, body: { code: 'invalid-request' } });
  });
});

describe('retries and composition', () => {
  it('answers the same sign-off request again without a second sign-off', async () => {
    const w = await world();
    const first = await w.signOff({ operationId: 'signoff-operation-retry00001' });
    const again = await w.signOff({ operationId: 'signoff-operation-retry00001' });
    expect(first.status).toBe(201);
    expect(again).toMatchObject({ status: 200, body: { signoffId: first.body.signoffId } });
    expect(w.db.rows('SELECT * FROM pub_signoff')).toHaveLength(1);
    expect(w.db.rows('SELECT * FROM pub_signoff_evidence')).toHaveLength(1);
  });

  it('writes nothing when the ledger was not composed for evidence', async () => {
    const w = await world({ evidence: false });
    expect((await w.signOff()).status).toBe(503);
    expect(w.db.rows('SELECT * FROM pub_signoff')).toEqual([]);
  });

  it('takes the evidence row\'s candidate from the sign-off, and refuses a record that names another', async () => {
    const w = await world();
    const signed = await w.signOff();
    const row = w.db.rows<{ candidate_id: string }>('SELECT candidate_id FROM pub_signoff_evidence')[0]!;
    expect(row.candidate_id).toBe(w.signoffRow(signed.body.signoffId as string).candidate_id);
    const record = (await w.ports.ledger!.signoff({ clientId: CLIENT, caseId: CASE, signoffId: signed.body.signoffId as string }))!;
    const other: SignoffRecord = { ...record, signoffId: 'so-other-operation-00001', operationId: 'other-operation-00001', requestSha256: hash('9'), evidence: { ...record.evidence!, candidateId: 'candidate-other' } };
    await expect(w.ports.ledger!.recordSignoff(other)).rejects.toMatchObject({ code: 'storage-unavailable' });
    expect(w.db.rows('SELECT * FROM pub_signoff')).toHaveLength(1);
  });

  it('does not name the evidence table in any statement of a v1 sign-off', async () => {
    const db = new SqliteD1(), sql: string[] = [], prepare = db.prepare.bind(db);
    db.prepare = (q: string) => { sql.push(q); return prepare(q); };
    const ledger = d1PublicationLedger(db as never);
    const v1: SignoffRecord = { candidateId: 'cand-1', linkId: 'link-1', submissionRevisionId: 'sub-1', submissionManifestSha256: hash('a'), resultsVersion: RV, manifestSha256: hash('b'),
      packageInputRevisionId: 'input-1', diagnosticsSha256: hash('d'), validatorVersion: 'validator-1', snapshotRevision: 'd1:1', signoffId: 'so-v1-operation-0000001', operationId: 'v1-operation-0000001',
      requestSha256: hash('c'), clientId: CLIENT, caseId: CASE, warningFingerprints: ['f'.repeat(32)], acknowledgements: [{ fingerprint: 'f'.repeat(32), reason: 'Seen.' }],
      signer: PRINCIPAL, preparedBy: { issuer: PRINCIPAL.issuer, subject: 'preparer' }, selfApproval: false, signedAt: NOW,
      auditEvent: { eventId: 'e1', actor: { kind: 'verified', principal: PRINCIPAL, sessionId: 'sess-publisher-0001' as never }, action: 'publication.signoff', object: { kind: 'publication', id: 'x', caseId: CASE }, version: RV, outcome: 'succeeded', at: NOW },
      state: 'recorded', invalidatedAt: null, invalidatedReason: null };
    const out = await ledger.recordSignoff(v1);
    expect(out).toMatchObject({ kind: 'recorded', repeated: false });
    await ledger.settleSignoff({ clientId: CLIENT, caseId: CASE, signoffId: v1.signoffId });
    const read = await ledger.signoff({ clientId: CLIENT, caseId: CASE, signoffId: v1.signoffId });
    expect(read).toMatchObject({ acknowledgements: [{ fingerprint: 'f'.repeat(32), reason: 'Seen.' }], state: 'audited' });
    expect(read).not.toHaveProperty('evidence');
    expect(JSON.parse(db.rows<{ acknowledgements: string }>('SELECT acknowledgements FROM pub_signoff')[0]!.acknowledgements)).toEqual([{ fingerprint: 'f'.repeat(32), reason: 'Seen.' }]);
    expect(sql.some(q => q.includes('pub_signoff_evidence'))).toBe(false);
    expect(CANDIDATE).toBeTruthy();
  });
});

describe('every field of the binding is load-bearing', () => {
  it.each([
    ['the evidence row is gone', "DROP TRIGGER pub_signoff_evidence_delete_seal", 'DELETE FROM pub_signoff_evidence'],
    ['its root is another', "DROP TRIGGER pub_signoff_evidence_update_seal", "UPDATE pub_signoff_evidence SET evidence_root = '" + 'a'.repeat(64) + "'"],
    ['its generation is another', "DROP TRIGGER pub_signoff_evidence_update_seal", "UPDATE pub_signoff_evidence SET generation = '2'"],
  ])('refuses publish when %s', async (_label, drop, change) => {
    const w = await world();
    const signed = await w.signOff();
    w.db.exec(drop); w.db.exec(change);
    expect(await w.publish(signed.body.signoffId as string)).toMatchObject({ status: 409, body: { code: 'signoff-stale', reason: 'candidate-changed' } });
    expect(w.pointer()).toBeNull();
    expect(w.receipts()).toEqual([]);
  });

  it('refuses a run that is not sealed to the sign-off\'s results version', async () => {
    const w = await world();
    const signed = await w.signOff();
    await w.freezeSnapshot();
    w.db.exec("UPDATE pub_evidence_run SET results_version = 'sha256:" + 'b'.repeat(64) + "'");
    expect(await w.publish(signed.body.signoffId as string)).toMatchObject({ status: 409, body: { reason: 'candidate-changed' } });
    expect(w.pointer()).toBeNull();
  });

  it.each([
    ['a numeric evidence root', { identity: (c: Record<string, unknown>) => ({ ...c, evidenceRoot: 7 }) }],
    ['no evidence root', { identity: (c: Record<string, unknown>) => { const { evidenceRoot: _r, ...rest } = c; return rest; } }],
    ['a group code in lower case', { groups: (g: { code: string }[]) => g.map(x => ({ ...x, code: x.code.toLowerCase() })) }],
    ['a group without fingerprints', { groups: (g: object[]) => g.map(x => ({ ...x, fingerprints: [] })) }],
    ['fingerprints that are not a list', { groups: (g: object[]) => g.map(x => ({ ...x, fingerprints: 'abc' })) }],
    ['a group with an extra key', { groups: (g: object[]) => g.map(x => ({ ...x, extra: 1 })) }],
    ['a short fingerprint', { groups: (g: { fingerprints: string[] }[]) => g.map(x => ({ ...x, fingerprints: x.fingerprints.map(f => f.slice(1)) })) }],
  ])('refuses %s', async (_label, edit) => {
    const w = await world();
    const body: Record<string, unknown> = {};
    if ('identity' in edit) body.identity = edit.identity(await w.claimed());
    if ('groups' in edit) body.acknowledgements = (edit.groups as (g: never) => unknown)(w.groups() as never);
    expect(await w.signOff(body)).toMatchObject({ status: 422 });
    expect(w.db.rows('SELECT * FROM pub_signoff')).toEqual([]);
  });

  it('refuses a mix of per-warning and grouped acknowledgements', async () => {
    const w = await world();
    const [first, ...rest] = w.groups();
    expect(await w.signOff({ acknowledgements: [...rest, { fingerprint: first!.fingerprints[0], reason: 'x' }] })).toMatchObject({ status: 422, body: { code: 'invalid-request' } });
  });
});
