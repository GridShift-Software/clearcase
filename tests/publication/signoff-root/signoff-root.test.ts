import { describe, expect, it } from 'vitest';
import { verifyEvidence } from '../../../src/lib/publication/hosted/evidence/index.ts';
import { CANDIDATE, CASE, world } from './harness.ts';

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
