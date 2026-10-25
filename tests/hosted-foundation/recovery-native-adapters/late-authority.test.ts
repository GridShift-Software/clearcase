// Independent review regressions, real adapters with explicit SQL/R2 transport fault injection.
import { afterEach, expect, it } from 'vitest';
import { world, CASE, CLIENT, blobKey, enc, type World } from './world.ts';
import { exportCase } from '../../../src/lib/recovery/hosted/export.ts';
import { sha256Hex } from '../../../src/lib/recovery/hosted/bytes.ts';
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.close(); });
it('M1 refuses preview metadata when revocation occurs during the final publication query', async () => {
  const w = await world(); worlds.push(w);
  const p = await w.stage(); await w.preview(p.identity.resultsVersion); w.publish(p.identity.resultsVersion);
  const d = await w.deps(), prepare = w.db.prepare.bind(w.db); let publications = 0;
  w.db.prepare = (sql) => {
    const stmt = prepare(sql);
    if (!sql.includes('FROM rs_case c LEFT JOIN')) return stmt;
    const bind = stmt.bind.bind(stmt);
    stmt.bind = (...values) => {
      const bound = bind(...values), first = bound.first.bind(bound);
      bound.first = async <T>() => { const r = await first<T>(); if (++publications === 4) w.state.revoked = true; return r; };
      return bound;
    };
    return stmt;
  };
  await expect(d.previews!.previewsOf({ caseId: CASE, resultsVersion: p.identity.resultsVersion })).rejects.toMatchObject({ code: 'not-found' });
  expect(publications).toBe(4);
});
it('M1 refuses grant revocation during the final publication observation', async () => {
  const w = await world(); worlds.push(w);
  const p = await w.stage(); await w.preview(p.identity.resultsVersion); w.publish(p.identity.resultsVersion);
  const d = await w.deps(), prepare = w.db.prepare.bind(w.db); let calls = 0;
  w.db.prepare = (sql) => {
    const stmt = prepare(sql); if (!sql.includes('FROM rs_case c LEFT JOIN')) return stmt;
    const bind = stmt.bind.bind(stmt);
    stmt.bind = (...values) => { const q = bind(...values), first = q.first.bind(q); q.first = async <T>() => { const r = await first<T>(); if (++calls === 4) w.revokeGrant(); return r; }; return q; };
    return stmt;
  };
  await expect(d.previews!.previewsOf({ caseId: CASE, resultsVersion: p.identity.resultsVersion })).rejects.toMatchObject({ code: 'not-found' });
});
it.each(['source', 'target'] as const)('M2 refuses %s writes when an explicit grant is revoked during preflight head', async (which) => {
  const source = await world(), target = await world(true); worlds.push(source, target); source.options.target = target.options;
  const d = await source.deps(), w = which === 'source' ? source : target;
  const bytes = enc('grant-revoked-before-write'), sha256 = await sha256Hex(bytes);
  const key = which === 'source' ? blobKey(sha256) : `restore/${CLIENT}/${CASE}/e1/blobs/${sha256}`;
  const head = w.bucket.head.bind(w.bucket);
  w.bucket.head = async (k) => { const r = await head(k); if (k === key) w.revokeGrant(); return r; };
  await expect((which === 'source' ? d.objects! : d.target!.objects).putIfAbsent({ key, bytes, sha256 })).rejects.toMatchObject({ code: 'forbidden' });
  expect(w.bucket.objects.has(key)).toBe(false); expect(w.bucket.puts).toEqual([]);
});
it('M2 also refuses a legacy export write after exact publication is withdrawn during preflight head', async () => {
  const w = await world(); worlds.push(w); const p = await w.stage(); w.publish(p.identity.resultsVersion);
  const d = await w.deps(), head = w.bucket.head.bind(w.bucket); let changed = false;
  w.bucket.head = async (key) => { const r = await head(key); if (key.includes('/e1/blobs/') && !changed) { changed = true; w.db.exec("UPDATE rs_publication SET state = 'withdrawn' WHERE case_id = ?", CASE); } return r; };
  await expect(exportCase(d, { caseId: CASE, exportId: 'e1', includeUserWork: false })).rejects.toMatchObject({ code: 'storage-unavailable' });
  expect(changed).toBe(true); expect(w.bucket.puts.some((key) => key.includes('/e1/'))).toBe(false);
});
it('M2 refuses a new immutable write when revocation occurs during preflight head', async () => {
  const w = await world(); worlds.push(w);
  const d = await w.deps(), bytes = enc('must not be written'), sha256 = await sha256Hex(bytes), key = blobKey(sha256);
  const head = w.bucket.head.bind(w.bucket);
  w.bucket.head = async (k) => { const r = await head(k); if (k === key) w.state.revoked = true; return r; };
  await expect(d.objects!.putIfAbsent({ key, bytes, sha256 })).rejects.toMatchObject({ code: 'invalid-session' });
  expect(w.bucket.objects.has(key)).toBe(false);
  expect(w.bucket.puts).toEqual([]);
});
