import { describe, expect, it } from 'vitest';
import { checkRows } from '../../../src/lib/publication/hosted/signoff-evidence.ts';
import { verifyEvidence } from '../../../src/lib/publication/hosted/evidence/index.ts';
import { CANDIDATE, CASE, CLIENT, RV, hash } from '../signoff-root/harness.ts';
import { bytesOf, originalsWorld, sha } from './harness.ts';

// U8 (real-export design 2, round 3). The evidence build reads every original from R2, hashes it and records sha256, size and etag.
// Publish compares what R2 holds now with what the sealed evidence recorded. An original replaced after the build, with bytes of the
// same size and other content, must make publish refuse with the pointer unchanged.

describe('decisive: an R2 original replaced with same-size different bytes after the evidence build', () => {
  it('makes publish refuse, leaves the pointer and receipts unchanged, and invalidates the sign-off', async () => {
    const w = await originalsWorld();
    const target = w.refs[5]!, key = w.keyOf(target);
    const signed = await w.signOff();
    expect(signed.status).toBe(201);
    expect(w.pointer()).toBeNull();

    // The evidence holds the original as it was: sha256, size and the etag R2 gave.
    const stored = w.db.rows<{ item_json: string }>('SELECT item_json FROM pub_evidence_item WHERE item_key = ?', `original/${target.assetId}`)[0]!;
    const before = await w.r2.head(key);
    expect(JSON.parse(stored.item_json).observation).toEqual({ kind: 'original', assetId: target.assetId, sha256: target.sha256, size: target.size, etag: before!.etag });

    // Same size, other content, replaced at rest after the build.
    const other = bytesOf(999, target.size);
    expect(other.byteLength).toBe(target.size);
    expect(sha(other)).not.toBe(target.sha256);
    await w.r2.put(key, other, { sha256: sha(other) });
    const after = await w.r2.head(key);
    expect(after!.size).toBe(before!.size);
    expect(after!.etag).not.toBe(before!.etag);

    // Premise: nothing in D1 moved. The sealed run, every item row and the root are exactly what the sign-off bound, so only the R2
    // comparison can see this.
    const claim = { clientId: CLIENT, caseId: CASE, candidateId: CANDIDATE, generation: '1', root: w.root, resultsVersion: RV, manifestSha256: hash('1') };
    expect(await verifyEvidence(w.store, w.binding)).toMatchObject({ ok: true });
    expect(await checkRows({ reader: w.reader, store: w.store }, claim)).toMatchObject({ ok: true });

    const refused = await w.publish(signed.body.signoffId as string);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'signoff-stale', reason: 'originals-changed' });
    expect(w.pointer()).toBeNull();
    expect(w.receipts()).toEqual([]);
    expect(w.signoffRow(signed.body.signoffId as string).invalidated_reason).toBe('originals-changed');
  });

  it('publishes the same candidate when R2 still holds exactly what the evidence recorded', async () => {
    const w = await originalsWorld();
    const signed = await w.signOff();
    const done = await w.publish(signed.body.signoffId as string);
    expect(done.status).toBe(200);
    expect(w.pointer()).toMatchObject({ state: 'published' });
    // Every distinct original was compared, in batches of at most four.
    expect(w.heads.flat().sort()).toEqual(w.refs.map(w.keyOf).sort());
    expect(Math.max(...w.heads.map(b => b.length))).toBeLessThanOrEqual(4);
  });
});
