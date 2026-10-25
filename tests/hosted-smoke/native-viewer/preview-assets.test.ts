// The derived-version asset route: publication, private-preview and withdrawal semantics are enforced on every read,
// and access to a case's originals before publication grants none of them. Unit doubles only (see world.ts).
import { describe, expect, it } from 'vitest';
import * as preview from '../../../deploy/client/routes/cases/[caseId]/v/[version]/assets/[assetId]/+server.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import { bigPdf, call, fetchDest, getOriginal, packageOver, pdf, provide, publish, shaOf, withdraw, world, type World } from './world.ts';

const FETCH = fetchDest('empty');
const getPreview = (w: World, caseId: string, version: string, assetId: string, o: { headers?: Record<string, string>; method?: 'GET' | 'HEAD' } = {}) =>
  call(preview, o.method ?? 'GET', `/cases/${caseId}/v/${version}/assets/${assetId}`, { caseId, version, assetId }, { assets: w.assets, headers: o.headers ?? FETCH });

// The stager derives each original's status from this case's finalized uploads and refuses a projection that claims more,
// so the case's originals are uploaded through the real intake first. Every version of a case lists the same originals.
async function stageWithPreview(w: World, tag: string, caseId = 'case-a') {
  const docs = [1, 2].map((n) => { const ref = `OD-00${n}`, path = `DISCOVERY/${ref} letter ${n}.pdf`; return { ref, disk: 'ok' as const, path, onDisk: path, bytes: pdf(`${caseId}-${n}`) }; });
  const pkg = await packageOver(caseId, tag, docs), rv = pkg.identity.resultsVersion, bytes = bigPdf(`preview-${tag}`);
  if (!w.db.rows('SELECT 1 FROM rs_case_original WHERE case_id = ? AND asset_id = ?', caseId, 'OD-001').length) await provide(w, caseId, pkg.uploads);
  const staged = await w.staging.stage({ caseId: caseId as never, operationId: `import-${tag}`, files: pkg.files, identity: pkg.identity, validation: pkg.validation, projection: pkg.projection });
  if (staged.kind === 'refused') throw new Error(`fixture stage refused: ${staged.reason}: ${staged.detail?.join('; ')}`);
  const key = `preview/${shaOf(bytes)}`;
  await w.bucket.put(key, bytes, { sha256: shaOf(bytes) });
  w.db.exec('INSERT INTO rs_preview (version_id, asset_id, sha256, size, media_type, filename, object_key) VALUES (?, ?, ?, ?, ?, ?, ?)', rv, 'p1', shaOf(bytes), bytes.byteLength, 'application/pdf', 'p1.pdf', key);
  return { rv, bytes };
}

describe('a version preview is reachable only while its exact version is published', () => {
  it('refuses a candidate version’s preview while the same case’s originals stay readable', async () => {
    const w = world();
    await w.upload('case-a', 'a1', bigPdf('orig'));
    const { rv } = await stageWithPreview(w, 'candidate');
    expect((await getOriginal(w, 'case-a', 'a1', { headers: FETCH })).status).toBe(200);
    const r = await getPreview(w, 'case-a', rv, 'p1');
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain('SYNTHETIC');
    expect(w.events.some((e) => e.action === 'asset.read-preview' && e.outcome === 'succeeded')).toBe(false);
  });

  it('serves the published preview inline to the viewer, ranged, with the version recorded in the audit', async () => {
    const w = world(), { rv, bytes } = await stageWithPreview(w, 'live');
    publish(w.db, 'case-a', rv);
    const r = await getPreview(w, 'case-a', rv, 'p1', { headers: { ...FETCH, range: 'bytes=0-15' } });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(bytes.subarray(0, 16));
    expect(w.events.some((e) => e.action === 'asset.read-preview' && e.outcome === 'succeeded' && e.version === rv)).toBe(true);
  });

  it('refuses a superseded version’s preview once another version is published', async () => {
    const w = world(), first = await stageWithPreview(w, 'first');
    publish(w.db, 'case-a', first.rv);
    expect((await getPreview(w, 'case-a', first.rv, 'p1')).status).toBe(200);
    const second = await stageWithPreview(w, 'second');
    publish(w.db, 'case-a', second.rv);
    expect((await getPreview(w, 'case-a', first.rv, 'p1')).status).toBe(404);
    expect((await getPreview(w, 'case-a', second.rv, 'p1')).status).toBe(200);
  });

  it('refuses every preview of a withdrawn version, a stale pointer notwithstanding, and keeps the originals', async () => {
    const w = world(), { rv } = await stageWithPreview(w, 'withdrawn');
    await w.upload('case-a', 'a1', bigPdf('still readable'));
    publish(w.db, 'case-a', rv);
    withdraw(w.db, 'case-a', rv);
    w.db.exec("UPDATE rs_publication SET state = 'published' WHERE case_id = 'case-a'");
    for (const method of ['GET', 'HEAD'] as const) expect((await getPreview(w, 'case-a', rv, 'p1', { method })).status).toBe(404);
    expect((await getOriginal(w, 'case-a', 'a1', { headers: FETCH })).status).toBe(200);
  });

  it('needs the preview authority itself: read-original does not open a published preview', async () => {
    const w = world(), { rv } = await stageWithPreview(w, 'authority');
    publish(w.db, 'case-a', rv);
    const grant = w.who.identity.authorize.bind(w.who.identity);
    w.who.identity.authorize = async (a) => { if (a.operation === 'read-preview') throw contractError('forbidden'); return grant(a); };
    expect((await getPreview(w, 'case-a', rv, 'p1')).status).toBe(404);
  });

  it('never resolves a version through another case’s URL', async () => {
    const w = world({ grants: ['case-a', 'case-b'] }), { rv } = await stageWithPreview(w, 'cross');
    publish(w.db, 'case-a', rv);
    expect((await getPreview(w, 'case-b', rv, 'p1')).status).toBe(404);
  });

  it.each(['latest', 'sha256:abc', 'sha256:' + 'z'.repeat(64), '..', ''])('answers the malformed version %j as absent', async (version) => {
    const w = world();
    expect((await getPreview(w, 'case-a', version, 'p1')).status).toBe(404);
  });

  it('answers a preview changed at rest 410 and never serves it', async () => {
    const w = world(), { rv } = await stageWithPreview(w, 'rot');
    publish(w.db, 'case-a', rv);
    const key = [...w.bucket.objects.keys()].find((k) => k.startsWith('preview/'))!;
    w.bucket.tamper(key, (b) => { b[b.length - 20]! ^= 1; return b; });
    for (const headers of [FETCH, { ...FETCH, range: 'bytes=0-3' }]) expect((await getPreview(w, 'case-a', rv, 'p1', { headers })).status).toBe(410);
  });
});
