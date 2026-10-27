import { describe, expect, it } from 'vitest';
import { checkSnapshotV2, evidenceCount } from '../../../src/lib/publication/hosted/rules.ts';
import { checkOriginals, type OriginalsComparison, type PublicationEvidence } from '../../../src/lib/publication/hosted/signoff-evidence.ts';
import type { EvidenceItemRow } from '../../../src/lib/publication/hosted/ports.ts';
import { world } from '../signoff-root/harness.ts';
import { bytesOf, originalsWorld, sha, type OriginalsWorld } from './harness.ts';

// What publish does with the originals the evidence recorded (U8). Everything here is SQLite plus the repo's MemoryR2 double.

async function signed(w: OriginalsWorld) {
  const r = await w.signOff();
  expect(r.status).toBe(201);
  return r.body.signoffId as string;
}
/** Compose another comparison (or none) for the next request. */
const compose = (w: OriginalsWorld, originals: OriginalsComparison | undefined) => { const { originals: _o, ...rest } = w.ports.signoffEvidence!; w.ports.signoffEvidence = (originals ? { ...rest, originals } : rest) as never; };
const unchanged = (w: OriginalsWorld) => { expect(w.pointer()).toBeNull(); expect(w.receipts()).toEqual([]); };

describe('the evidence holds the originals', () => {
  it('counts them, pages them as their own kind, and is a v2 snapshot the rules accept', async () => {
    const w = await originalsWorld({ count: 12 });
    const s = await w.current();
    expect(checkSnapshotV2(s)).not.toBeNull();
    expect(evidenceCount(s, 'original')).toBe(12);
    expect(s.evidence.groups.find(g => g.kind === 'original')).toEqual({ kind: 'original', subject: null, state: null, reason: null, count: 12 });
    const page = await w.reader.page({ clientId: s.link.clientId as never, caseId: s.link.caseId as never, candidateId: s.link.candidate.candidateId, generation: '1', root: s.evidence.root, after: null, kind: 'original', limit: 500 });
    expect(page!.map(r => r.key)).toEqual(w.refs.map(r => `original/${r.assetId}`));
    // The originals do not change what blocks a sign-off: they are evidence, and a sign-off still lists exactly the new warnings.
    expect(s.evidence.newWarnings).toBe(w.fresh().length);
  });

  it('is not read by sign-off: R2 is compared only when publish rechecks', async () => {
    const w = await originalsWorld();
    await signed(w);
    expect(w.heads).toEqual([]);
  });
});

describe('publish refuses, with the pointer and receipts unchanged, when R2 no longer holds what the evidence recorded', () => {
  const refusal = async (w: OriginalsWorld, reason = 'originals-changed') => {
    const id = await signed(w), r = await w.publish(id);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'signoff-stale', reason });
    unchanged(w);
    expect(w.signoffRow(id).invalidated_reason).toBe(reason);
  };

  it('for the first, a middle and the last original (every batch is compared)', async () => {
    for (const n of [0, 6, 11]) {
      const w = await originalsWorld({ count: 12, batch: 4 });
      const ref = w.refs[n]!, other = bytesOf(900 + n, ref.size);
      await w.r2.put(w.keyOf(ref), other, { sha256: sha(other) });
      await refusal(w);
    }
  });

  it('for an object that is gone', async () => {
    const w = await originalsWorld();
    w.r2.objects.delete(w.keyOf(w.refs[3]!));
    await refusal(w);
  });

  it('for an object of another size', async () => {
    const w = await originalsWorld();
    const ref = w.refs[2]!, longer = bytesOf(5, ref.size + 1);
    await w.r2.put(w.keyOf(ref), longer, { sha256: sha(longer) });
    await refusal(w);
  });

  it('for the same bytes written again, since the etag is what was sealed', async () => {
    const w = await originalsWorld();
    const ref = w.refs[4]!, same = new Uint8Array(w.r2.objects.get(w.keyOf(ref))!.bytes);
    await w.r2.put(w.keyOf(ref), same, { sha256: ref.sha256 });
    await refusal(w);
  });

  it('and a refused sign-off cannot be published later, even after the original is put back', async () => {
    const w = await originalsWorld();
    const ref = w.refs[1]!, saved = new Uint8Array(w.r2.objects.get(w.keyOf(ref))!.bytes);
    const id = await signed(w), other = bytesOf(31, ref.size);
    await w.r2.put(w.keyOf(ref), other, { sha256: sha(other) });
    expect((await w.publish(id)).status).toBe(409);
    await w.r2.put(w.keyOf(ref), saved, { sha256: ref.sha256 });
    const again = await w.publish(id);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'signoff-not-effective' });
    unchanged(w);
  });

  it('after the D1 rows, not before: a row altered in D1 is refused without reading R2', async () => {
    const w = await originalsWorld();
    const id = await signed(w);
    w.db.exec('DROP TRIGGER pub_evidence_item_update_seal');
    w.db.exec("UPDATE pub_evidence_item SET item_json = replace(item_json, 'e1', 'e9') WHERE item_key = 'original/sub-op-00003'");
    const r = await w.publish(id);
    expect(r.body).toMatchObject({ code: 'signoff-stale', reason: 'candidate-changed' });
    expect(w.heads).toEqual([]);
    unchanged(w);
  });
});

describe('what publish compares', () => {
  it('each distinct object once, in batches no larger than the comparison allows', async () => {
    const w = await originalsWorld({ count: 12, batch: 5 });
    expect((await w.publish(await signed(w))).status).toBe(200);
    expect(w.heads.map(b => b.length)).toEqual([5, 5, 2]);
    expect(new Set(w.heads.flat()).size).toBe(12);
    expect(w.pointer()).toMatchObject({ state: 'published' });
  });

  it('an object several assets share is compared once', async () => {
    const heads: string[] = [];
    const rows = [row('a', 1, 'e1'), row('b', 1, 'e1'), row('c', 2, 'e2')];
    expect(await checkOriginals(rowsPort(rows), comparisonOf(i => heads.push(...i)), claim, 3)).toEqual({ ok: true, compared: 2 });
    expect(heads.sort()).toEqual([`orig/${hex(1)}`, `orig/${hex(2)}`]);
  });
});

describe('what publish never does on a guess', () => {
  it('answers 503 and keeps the sign-off when the run holds originals and no comparison is composed', async () => {
    const w = await originalsWorld();
    compose(w, undefined);
    const id = await signed(w), r = await w.publish(id);
    expect(r.status).toBe(503);
    unchanged(w);
    expect(w.signoffRow(id).invalidated_at).toBeNull();
  });

  it('answers 503 and keeps the sign-off when R2 cannot be read, then publishes when it can', async () => {
    let down = true;
    const w = await originalsWorld();
    compose(w, { ...w.comparison, heads: async keys => { if (down) throw new Error('r2 down'); return w.comparison.heads(keys); } });
    const id = await signed(w);
    const first = await w.publish(id);
    expect(first.status).toBe(503);
    unchanged(w);
    expect(w.signoffRow(id).invalidated_at).toBeNull();
    down = false;
    expect((await w.publish(id)).status).toBe(200);
  });

  it('answers 503 for more originals than the comparison may check, and keeps the sign-off', async () => {
    const w = await originalsWorld({ count: 12, limit: 11 });
    const id = await signed(w), r = await w.publish(id);
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: 'originals-over-limit' });
    expect(w.heads).toEqual([]);
    unchanged(w);
    expect(w.signoffRow(id).invalidated_at).toBeNull();
  });

  it('does not pass a comparison that answers for another number of objects', async () => {
    const w = await originalsWorld();
    compose(w, { ...w.comparison, heads: async keys => (await w.comparison.heads(keys)).slice(1) });
    const id = await signed(w);
    expect((await w.publish(id)).status).toBe(503);
    unchanged(w);
    expect(w.signoffRow(id).invalidated_at).toBeNull();
  });
});

describe('what stays as it was', () => {
  it('a run with no originals publishes without any comparison composed, and reads no R2', async () => {
    const w = await world();
    const s = await w.signOff();
    expect(w.ports.signoffEvidence!.originals).toBeUndefined();
    expect((await w.publish(s.body.signoffId as string)).status).toBe(200);
  });

  it('a candidate that reads as v1 reaches no comparison and no evidence kind', async () => {
    const w = await originalsWorld();
    const id = await signed(w);
    w.flipSnapshotToV1();
    const r = await w.publish(id);
    expect(r.body).toMatchObject({ code: 'signoff-stale', reason: 'candidate-changed' });
    expect(w.heads).toEqual([]);
    unchanged(w);
  });
});

// ---- checkOriginals over stubs, for the cases the real tables cannot produce (a sealed run has consistent rows) ----------------
const claim = { clientId: 'k', caseId: 'c', candidateId: 'cand', generation: '1', root: 'r'.repeat(64), resultsVersion: 'v', manifestSha256: 'a'.repeat(64) };
/** Object n is `orig/<hex n>`; its size is n + 4 and its etag `e<n>` in every stub below. */
const hex = (n: number) => n.toString(16).padStart(64, '0');
function row(assetId: string, n: number, etag: string, size = n + 4): EvidenceItemRow {
  const input = { caseId: claim.caseId, clientId: claim.clientId, manifestSha256: claim.manifestSha256, rendererVersion: 'r', resultsVersion: claim.resultsVersion, validatorVersion: 'x' };
  return { key: `original/${assetId}`, json: JSON.stringify({ input, observation: { kind: 'original', assetId, sha256: hex(n), size, etag } }), baseline: null };
}
const rowsPort = (rows: EvidenceItemRow[], paged = rows.length): PublicationEvidence => ({ store: null as never, reader: { page: async a => {
  const after = a.after === null ? 0 : rows.findIndex(r => r.key === a.after) + 1;
  return rows.slice(after, after + Math.min(a.limit, paged));
} } });
const nOf = (key: string) => Number(BigInt(`0x${key.slice(5)}`));
const comparisonOf = (seen: (keys: readonly string[]) => void = () => {}, batch = 10): OriginalsComparison =>
  ({ batch, limit: 5000, heads: async keys => { seen(keys); return keys.map(k => ({ etag: `e${nOf(k)}`, size: nOf(k) + 4 })); } });

describe('checkOriginals over rows it cannot trust', () => {
  const ok = comparisonOf();
  it('refuses rows that disagree about one object, a count that is not the snapshot\'s, a page that ends early and a row that is not an original', async () => {
    expect(await checkOriginals(rowsPort([row('a', 1, 'e1'), row('b', 1, 'eX')]), ok, claim, 2)).toEqual({ ok: false, reason: 'rows' });
    expect(await checkOriginals(rowsPort([row('a', 1, 'e1'), row('b', 1, 'e1', 9)]), ok, claim, 2)).toEqual({ ok: false, reason: 'rows' });
    expect(await checkOriginals(rowsPort([row('a', 1, 'e1')]), ok, claim, 2)).toEqual({ ok: false, reason: 'rows' });
    expect(await checkOriginals(rowsPort([row('a', 1, 'e1'), row('b', 2, 'e2')]), ok, claim, 1)).toEqual({ ok: false, reason: 'rows' });
    const warning: EvidenceItemRow = { key: `warning/${'1'.repeat(32)}`, json: JSON.stringify({ input: { caseId: 'c', clientId: 'k', manifestSha256: 'a'.repeat(64), rendererVersion: 'r', resultsVersion: 'v', validatorVersion: 'x' }, observation: { kind: 'warning', fingerprint: '1'.repeat(32) } }), baseline: false };
    expect(await checkOriginals(rowsPort([warning]), ok, claim, 1)).toEqual({ ok: false, reason: 'rows' });
    expect(await checkOriginals({ store: null as never, reader: { page: async () => null } }, ok, claim, 1)).toEqual({ ok: false, reason: 'rows' });
  });
  it('refuses a row bound to another case, results version or manifest', async () => {
    for (const other of [{ caseId: 'other' }, { clientId: 'other' }, { resultsVersion: 'other' }, { manifestSha256: 'b'.repeat(64) }]) {
      expect(await checkOriginals(rowsPort([row('a', 1, 'e1')]), ok, { ...claim, ...other }, 1)).toEqual({ ok: false, reason: 'rows' });
    }
  });
  it('rejects, rather than passes, a comparison that answers for another number of objects', async () => {
    const lying: OriginalsComparison = { ...ok, heads: async keys => (await ok.heads(keys)).slice(1) };
    await expect(checkOriginals(rowsPort([row('a', 1, 'e1')]), lying, claim, 1)).rejects.toThrow();
  });
  it('reports a missing object, a changed etag and a changed size, and more objects than its limit', async () => {
    const rows = [row('a', 1, 'e1'), row('b', 2, 'e2')];
    expect(await checkOriginals(rowsPort(rows), { ...ok, heads: async keys => keys.map((k, i) => (i === 1 ? null : { etag: `e${nOf(k)}`, size: nOf(k) + 4 })) }, claim, 2)).toEqual({ ok: false, reason: 'missing' });
    expect(await checkOriginals(rowsPort(rows), { ...ok, heads: async keys => keys.map(k => ({ etag: 'other', size: nOf(k) + 4 })) }, claim, 2)).toEqual({ ok: false, reason: 'changed' });
    expect(await checkOriginals(rowsPort(rows), { ...ok, heads: async keys => keys.map(k => ({ etag: `e${nOf(k)}`, size: 0 })) }, claim, 2)).toEqual({ ok: false, reason: 'changed' });
    expect(await checkOriginals(rowsPort(rows), { ...ok, limit: 1 }, claim, 2)).toEqual({ ok: false, reason: 'over-limit' });
  });
  it('reads a long run in pages and still compares every object', async () => {
    const rows = Array.from({ length: 1203 }, (_, n) => row(`a${String(n).padStart(5, '0')}`, n, `e${n}`));
    const seen: string[] = [];
    const port = comparisonOf(keys => seen.push(...keys), 100);
    expect(await checkOriginals(rowsPort(rows, 500), port, claim, 1203)).toEqual({ ok: true, compared: 1203 });
    expect(seen).toHaveLength(1203);
    const moved: OriginalsComparison = { ...port, heads: async keys => (await port.heads(keys)).map((h, i) => (nOf(keys[i]!) === 1100 ? { ...h!, size: h!.size + 1 } : h)) };
    expect(await checkOriginals(rowsPort(rows, 500), moved, claim, 1203)).toEqual({ ok: false, reason: 'changed' });
  });
});
