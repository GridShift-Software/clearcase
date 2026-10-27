// U16: the stager selects every original of a package from one sealed multi-file submission revision, by its manifest.
import { afterEach, describe, expect, it } from 'vitest';
import { caseId, world, docs, pdf } from './world.ts';
import { ids, submitSet } from '../storage/fixture.ts';

const worlds: ReturnType<typeof world>[] = [];
const setup = (ds = docs(3)) => { const w = world(ds); worlds.push(w); return w; };
afterEach(() => { for (const w of worlds.splice(0)) w.db.sqlite.close(); });

describe('stager over a multi-file submission revision', () => {
  it('stages and links a package whose originals span the sealed set, each verified from its own file', async () => {
    const ds = docs(3), w = setup(ds);
    const revision = await submitSet(w, caseId, 'all', ds);
    const out = await w.ports.stager.stage(await w.request(revision));
    expect(out).toMatchObject({ kind: 'staged' });
    const assets = w.db.rows<{ row_json: string }>('SELECT row_json FROM rs_asset').map((r) => JSON.parse(r.row_json) as { key: string; status: string });
    expect(assets.map((a) => [a.key, a.status])).toEqual(ds.map((d) => [d.ref, 'verified']));
    const { candidate } = await w.linked(revision);
    const link = w.db.rows<{ submission_revision_id: string; coverage_json: string }>('SELECT submission_revision_id, coverage_json FROM native_import_link')[0]!;
    expect(link.submission_revision_id).toBe(revision);
    const coverage = JSON.parse(link.coverage_json) as { mappedOriginals: { packagePath: string; submissionAssetId: string }[] };
    expect(coverage.mappedOriginals.map((m) => m.packagePath)).toEqual(ds.map((d) => d.path).sort());
    expect(new Set(coverage.mappedOriginals.map((m) => m.submissionAssetId)).size).toBe(3);
    expect(candidate).toBeTruthy();
  });

  it('refuses an original the package names that is not in the set, even when another revision of the case holds it', async () => {
    const ds = docs(3), w = setup(ds);
    const partial = await submitSet(w, caseId, 'two', ds.slice(0, 2));
    await w.upload(ds[2]!.path, ds[2]!.bytes, 'elsewhere');
    expect(await w.ports.stager.stage(await w.request(partial))).toMatchObject({ kind: 'refused', reason: 'original-link-required' });
    expect(w.db.rows('SELECT * FROM native_import_link')).toEqual([]);
  });

  it('leaves a candidate unlinked when the set holds a file the package does not name', async () => {
    const ds = docs(2), w = setup(ds);
    const revision = await submitSet(w, caseId, 'extra', [...ds, { ref: 'OD-999', path: 'DOCS/unnamed extra.pdf', bytes: pdf('extra') }]);
    const refusal = await w.linked(revision).then(() => null, (e: Error) => e.message);
    expect(refusal).toMatch(/submitted-file-unmapped/);
  });

  it('does not offer a set to the stager before it is sealed', async () => {
    const ds = docs(2), w = setup(ds);
    const open = await submitSet(w, caseId, 'open', ds, { seal: false });
    expect(await w.submissions.finalized({ clientId: ids.clientA, caseId, revisionId: open })).toEqual({ state: 'not-final' });
  });
});
