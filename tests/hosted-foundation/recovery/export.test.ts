import { describe, expect, it } from 'vitest';
import { exportCase, verifyExport } from '../../../src/lib/recovery/hosted/index.ts';
import { sha256Hex } from '../../../src/lib/recovery/hosted/bytes.ts';
import { CASE, CLIENT, SESSION, enc, lookup, world } from './world.ts';

const req = { caseId: CASE, exportId: 'exp-1', includeUserWork: true };
const code = (p: Promise<unknown>) => p.then(() => 'resolved', (e: { code?: string }) => e.code ?? String(e));
const pin = (r: { manifestSha256: string }, exportId = 'exp-1') => ({ caseId: CASE, exportId, expectedManifestSha256: r.manifestSha256 });

describe('complete export', () => {
  it('stores original bytes, exact packages, previews and independent user work; every digest matches the stored bytes', async () => {
    const w = world();
    const r = await exportCase(w.deps, req);
    const m = r.manifest;
    expect(m.originals.map((o) => o.assetId)).toEqual(['orig-1', 'orig-2', 'orig-dup']);
    for (const o of m.originals) {
      const stored = w.objects.map.get(`recovery/exports/${CLIENT}/${CASE}/exp-1/${o.blob}`)!;
      expect(stored).toEqual(w.originals.get(o.assetId));
      expect(o.sha256).toBe(await sha256Hex(stored)); expect(o.size).toBe(stored.length);
    }
    expect(m.previews).toHaveLength(1); expect(m.previews[0]!.resultsVersion).toBe(m.source.activeVersion);
    expect(m.resultsVersions[0]!.version).toMatchObject({ input_revision_id: 'rev-in-1', manifest_sha256: 'b'.repeat(64), diagnostics_sha256: 'c'.repeat(64) });
    expect(m.resultsVersions[0]!.files.map((f) => f.path)).toEqual(['manifest.json', 'datasets/docs.json']);
    expect(m.source.publication.kind).toBe('published'); expect(m.source.caseRevision).toBe('rev-1');
    expect(m.userWork).toMatchObject({ tables: 1, rows: 2 });
    expect(m.accounting).toMatchObject({ originals: { files: 3, embedded: 0 }, previews: { files: 1 }, resultsPackages: { versions: 1, files: 2 }, userWork: { included: true, rows: 2 } });
    // duplicate original content is stored once but accounted as two files
    expect(m.accounting.blobs.distinct).toBe(3 + 1 + 2 + 1 - 1);
    const v = await verifyExport(w.deps, pin(r));
    expect(v.accounting).toEqual(m.accounting); expect(v.verifiedBlobs).toBe(m.accounting.blobs.distinct);
  });

  it('never carries a session token or credential into the manifest or the store; user work is absent unless selected', async () => {
    const w = world(); const r = await exportCase(w.deps, { ...req, includeUserWork: false });
    expect(JSON.stringify(r.manifest)).not.toContain(SESSION);
    for (const b of w.objects.map.values()) expect(new TextDecoder().decode(b)).not.toContain(SESSION);
    expect(r.manifest.userWork).toBeNull(); expect(w.calls.exportAll).toBe(0);
  });

  it('records an embedded original explicitly with no invented hash', async () => {
    const w = world(); w.k.embedded = true;
    const r = await exportCase(w.deps, req);
    expect(r.manifest.embedded).toEqual([expect.objectContaining({ assetId: 'orig-2', unavailable: 'embedded' })]);
    expect(r.manifest.embedded[0]).not.toHaveProperty('sha256');
    expect(r.manifest.accounting.originals).toMatchObject({ files: 2, embedded: 1 });
  });

  it('a required-null or non-durable store is a 503 before any authority check, read or audit', async () => {
    const w = world();
    expect(await code(exportCase({ ...w.deps, objects: null }, req))).toBe('recovery-unavailable');
    expect(await code(exportCase({ ...w.deps, profile: 'production' }, req))).toBe('recovery-unavailable'); // a test stand-in is no production fallback
    expect(w.calls).toMatchObject({ authorize: 0, checkRevocation: 0, originalsGet: 0, store: 0, exportAll: 0 }); expect(w.calls.audit).toEqual([]);
  });

  it.each([['revoked session', 'revoked', 'invalid-session'], ['foreign client', 'denyWith', 'wrong-client'], ['no case grant', 'denyWith', 'forbidden']] as const)('%s refuses before any byte and records a scoped denial', async (_n, knob, expected) => {
    const w = world();
    if (knob === 'revoked') w.k.revoked = true; else w.k.denyWith = expected;
    expect(await code(exportCase(w.deps, req))).toBe(expected);
    expect(w.calls.originalsGet).toBe(0); expect(w.calls.packageFile).toBe(0); expect(w.calls.exportAll).toBe(0); expect(w.objects.map.size).toBe(0); expect(w.objects.gets).toEqual([]);
    if (knob === 'denyWith') expect(w.calls.audit.map((e) => e.outcome)).toContain('denied');
  });

  it('refuses input that names a foreign case, and revocation after the bytes were read releases nothing', async () => {
    const w = world();
    expect(await code(exportCase(w.deps, { ...req, caseId: '../other' }))).toBe('invalid-request');
    const foreign = world(); const orig = foreign.deps.store.versionsOf; foreign.deps.store.versionsOf = async (a) => (await orig(a)).map((v) => ({ ...v, case_id: 'case-other' as never }));
    expect(await code(exportCase(foreign.deps, req))).toBe('foreign-input'); expect(foreign.objects.map.size).toBe(0);
    const late = world(); let n = 0; late.deps.identity.checkRevocation = async () => { if (++n === 2) throw Object.assign(new Error('x'), { code: 'invalid-session' }); };
    expect(await code(exportCase(late.deps, req))).toBe('invalid-session'); expect(lookup(late.objects, 'manifest.json')).toEqual([]);
  });

  it('an audit fault refuses before any byte: an unrecorded read is not allowed', async () => {
    const w = world(); w.k.auditDown = true;
    expect(await code(exportCase(w.deps, req))).toBe('audit-unavailable'); expect(w.calls.originalsGet).toBe(0); expect(w.objects.map.size).toBe(0);
  });

  it.each([['bytes', 'changed-original'], ['size', 'changed-original'], ['missing', 'missing-original']] as const)('an original whose %s disagree fails truthfully with no manifest', async (tamper, expected) => {
    const w = world(); w.k.tamper = tamper;
    expect(await code(exportCase(w.deps, req))).toBe(expected);
    expect(lookup(w.objects, 'manifest.json')).toEqual([]);
    expect(await code(verifyExport(w.deps, { caseId: CASE, exportId: 'exp-1', expectedManifestSha256: '0'.repeat(64) }))).toBe('export-incomplete');
  });

  it('a repeated export id is refused and the first export is untouched', async () => {
    const w = world(); const r = await exportCase(w.deps, req);
    const before = new Map(w.objects.map);
    expect(await code(exportCase(w.deps, req))).toBe('export-exists');
    expect(w.objects.map).toEqual(before); expect(await code(verifyExport(w.deps, pin(r)))).toBe('resolved');
  });

  it('partial, corrupt and mis-pinned exports fail verification and are never reported complete', async () => {
    const w = world(); const r = await exportCase(w.deps, req);
    const mk = lookup(w.objects, 'manifest.json')[0]!, blobs = lookup(w.objects, '/blobs/');
    const lost = blobs[0]!, saved = w.objects.map.get(lost)!;
    w.objects.map.delete(lost); expect(await code(verifyExport(w.deps, pin(r)))).toBe('export-incomplete');
    const flipped = new Uint8Array(saved); flipped[0] ^= 1; w.objects.map.set(lost, flipped); expect(await code(verifyExport(w.deps, pin(r)))).toBe('export-corrupt');
    w.objects.map.set(lost, saved.slice(0, saved.length - 1)); expect(await code(verifyExport(w.deps, pin(r)))).toBe('export-corrupt');
    w.objects.map.set(lost, saved); expect(await code(verifyExport(w.deps, pin(r)))).toBe('resolved');
    expect(await code(verifyExport(w.deps, { ...pin(r), expectedManifestSha256: '1'.repeat(64) }))).toBe('manifest-mismatch');
    const m = w.objects.map.get(mk)!; w.objects.map.set(mk, enc(new TextDecoder().decode(m).replace('"rows":2', '"rows":3')));
    expect(await code(verifyExport(w.deps, { ...pin(r), expectedManifestSha256: await sha256Hex(w.objects.map.get(mk)!) }))).toBe('manifest-invalid'); // accounting no longer sums
  });

  it('a storage fault part-way leaves no manifest, so no partial export exists, and a retry under the same id succeeds', async () => {
    const w = world(); w.objects.failPutAt = 2;
    expect(await code(exportCase(w.deps, req))).toBe('storage-unavailable'); expect(lookup(w.objects, 'manifest.json')).toEqual([]);
    w.objects.failPutAt = null; expect(await code(exportCase(w.deps, req))).toBe('resolved');
  });

  it('a case that moves mid-export is refused as torn, not exported', async () => {
    const w = world(); const orig = w.deps.assets.get; w.deps.assets.get = async (a) => { w.k.revision = 'rev-2'; return orig(a); };
    expect(await code(exportCase(w.deps, req))).toBe('export-raced'); expect(lookup(w.objects, 'manifest.json')).toEqual([]);
  });

  it('bounds are checked on declared sizes before the first byte is read', async () => {
    const w = world(); expect(await code(exportCase({ ...w.deps, limits: { maxFileBytes: 4 } }, req))).toBe('export-too-large'); expect(w.calls.originalsGet).toBe(0);
    expect(await code(exportCase({ ...w.deps, limits: { maxFiles: 2 } }, req))).toBe('export-too-large');
    expect(await code(exportCase({ ...w.deps, limits: { maxTotalBytes: 40 } }, { ...req, exportId: 'exp-2' }))).toBe('export-too-large');
  });

  it("a foreign client's manifest is refused before any blob is read", async () => {
    const w = world(); const r = await exportCase(w.deps, req);
    const b = world({ clientId: 'client-b' as never }); const mk = `recovery/exports/client-b/${CASE}/exp-1/manifest.json`;
    b.objects.map.set(mk, w.objects.map.get(`recovery/exports/${CLIENT}/${CASE}/exp-1/manifest.json`)!);
    expect(await code(verifyExport(b.deps, pin(r)))).toBe('foreign-input'); expect(b.objects.gets).toEqual([mk]);
  });
  it('a store that silently stores different bytes, or a manifest that appears first, fails the export instead of reporting it', async () => {
    const w = world(); const put = w.objects.putIfAbsent.bind(w.objects);
    w.objects.putIfAbsent = async (a) => put({ ...a, bytes: a.key.includes('/blobs/') ? a.bytes.slice(0, a.bytes.length - 1) : a.bytes });
    expect(await code(exportCase(w.deps, req))).toBe('export-corrupt'); expect(lookup(w.objects, 'manifest.json')).toEqual([]);
    const r = world(); const real = r.objects.putIfAbsent.bind(r.objects);
    r.objects.putIfAbsent = async (a) => { if (a.key.endsWith('manifest.json')) r.objects.map.set(a.key, enc('{}')); return real(a); };
    expect(await code(exportCase(r.deps, req))).toBe('export-exists');
    expect(new TextDecoder().decode(r.objects.map.get(lookup(r.objects, 'manifest.json')[0]!))).toBe('{}');
  });

  it('an original whose listed size disagrees with its own metadata is a changed original', async () => {
    const w = world(); const list = w.deps.assets.originals; w.deps.assets.originals = async (a) => (await list(a)).map((o) => ({ ...o, size: o.size + 1 }));
    expect(await code(exportCase(w.deps, req))).toBe('changed-original');
  });
});
