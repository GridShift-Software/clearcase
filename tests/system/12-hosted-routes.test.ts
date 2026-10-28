// Sprint ticket 12: the hosted documents list and document page over a published synthetic version. The list answers the
// unfiltered request from one shard and every other request from the list pages with the local model's own totals; the
// document page reads its shard, makes one links call for its own original and states the three original states.
import { isHttpError } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { load as docLoad } from '../../deploy/client/routes/cases/[caseId]/v/[version]/doc/[ref]/+page.server.ts';
import { load as documentsLoad } from '../../deploy/client/routes/cases/[caseId]/v/[version]/evidence/documents/+page.server.ts';
import { documentsModel } from '../../src/lib/views/evidence/documents.ts';
import type { ListPage } from '../../src/lib/views/payloads/list.ts';
import type { RequestServices } from '../../src/lib/server/runtime/contracts.ts';
import { grantedIdentity, ids } from '../hosted-foundation/storage/fixture.ts';
import { CASE_ID, locals, published, type BuiltCase, type Deployment } from '../publication/shards/world.ts';
import { docCase, KID_GONE, KID_OK, NO_FILE, PARENT } from '../publication/shards/12-world.ts';

let b: BuiltCase, dep: Deployment;
beforeAll(async () => {
  b = await docCase(); dep = await published(b);
  // The originals the case loader (07) stored: one row per asset the page links, none for the file that was not supplied.
  for (const ref of [KID_OK, PARENT]) {
    const hash = Buffer.from(ref.padEnd(32, '_')).toString('hex');
    dep.db.sqlite.prepare('INSERT INTO rs_original (sha256, size, object_key, etag, media_family) VALUES (?, 4, ?, ?, ?)').run(hash, `orig/${hash}`, 'e', 'pdf');
    dep.db.sqlite.prepare('INSERT INTO rs_case_original (case_id, asset_id, sha256, filename, media_type, finalized_at) VALUES (?, ?, ?, ?, ?, ?)').run(CASE_ID, ref, hash, `${ref}.pdf`, ref === KID_OK ? 'application/pdf' : 'message/rfc822', '2001-01-01T00:00:00Z');
  }
}, 120_000);
afterAll(() => b?.cleanup());

const rv = () => b.built.record.resultsVersion;
const base = () => `/cases/${CASE_ID}/v`;
const event = (l: RequestServices, params: Record<string, string>, search = '') =>
  ({ locals: { ...l }, params: { caseId: CASE_ID, version: rv(), ...params }, url: new URL(`https://client-a.example.invalid/cases/${CASE_ID}/v/x${search}`) }) as never;
const rows = () => Array.from({ length: b.built.manifest.counts.listPages }, (_, i) => JSON.parse(new TextDecoder().decode(b.files.get(`list/page-${i + 1}.json`)!)) as ListPage).flatMap((p) => p.rows);
async function status(run: () => unknown): Promise<number | 'ok'> {
  try { await run(); return 'ok'; } catch (e) { if (isHttpError(e)) return e.status; throw e; }
}
// The hosted viewer route is what production wires; the harness world has none.
const withViewer = (l: RequestServices): RequestServices => ({ ...l, assets: { ...l.assets, links: async (a) => ({ ...(await l.assets.links(a)), viewerHref: `/cases/${CASE_ID}/originals/${a.asset.assetId}/view` }) } });

describe('12 hosted documents list', () => {
  test('no filter: the default model, the route base and the case total', async () => {
    const d = await documentsLoad(event(locals(dep), {}));
    expect(d.base).toBe(base());
    expect(d.model).toEqual(documentsModel(rows(), { bundle: null, q: '', page: null }));
    expect(d.total).toBe(b.built.manifest.counts.documents);
    expect(await documentsLoad(event(locals(dep), {}, '?page=1'))).toEqual(d);
  });

  test('a bundle narrows to its 60-row page with the bundle total, the same as the local model', async () => {
    const d = await documentsLoad(event(locals(dep), {}, '?bundle=Bulk%20A'));
    expect(d.model).toEqual(documentsModel(rows(), { bundle: 'Bulk A', q: '', page: null }));
    expect([d.model.bundle, d.model.page.slice.length, d.model.page.total, d.model.page.pages]).toEqual(['Bulk A', 60, 230, 4]);
    expect(d.model.bundles.find((x) => x.name === 'Bulk A')?.count).toBe(230);
    expect(d.total).toBe(b.built.manifest.counts.documents);
    const second = await documentsLoad(event(locals(dep), {}, '?bundle=Bulk%20A&page=2'));
    expect([second.model.page.page, second.model.page.from, second.model.page.to]).toEqual([2, 61, 120]);
    expect(second.model.page.slice.map((r) => r.ref)).not.toEqual(d.model.page.slice.map((r) => r.ref));
  });

  test('a filter text is applied inside the bundle, and an unknown bundle falls back with its notice', async () => {
    const hit = await documentsLoad(event(locals(dep), {}, '?bundle=Bulk%20A&q=BK-0001'));
    expect(hit.model.page.slice.map((r) => r.ref)).toEqual(['BK-0001']);
    const none = await documentsLoad(event(locals(dep), {}, '?bundle=Bulk%20A&q=nothing-matches'));
    expect([none.model.page.total, none.model.page.slice.length]).toEqual([0, 0]);
    const unknown = await documentsLoad(event(locals(dep), {}, '?bundle=No%20Such'));
    expect(unknown.model.unknownBundle).toBe(true);
  });

  test('a case without a grant is refused', async () => {
    const l = locals(dep, { identity: grantedIdentity(ids.clientA, []).identity });
    expect([403, 404]).toContain(await status(() => documentsLoad(event(l, {}))));
  });
});

describe('12 hosted document page', () => {
  test('a stored original: one links call, the presentation from the media type, no notes', async () => {
    const d = await docLoad(event(withViewer(locals(dep)), { ref: KID_OK }, '?page=3'));
    expect([d.ref, d.source, d.base, d.page, d.onDisk, d.notes]).toEqual([KID_OK, 'results', base(), 3, null, []]);
    expect(d.links).toEqual({ presentation: 'viewer', open: `/cases/${CASE_ID}/originals/${KID_OK}`, download: `/cases/${CASE_ID}/originals/${KID_OK}?download=1`, viewer: `/cases/${CASE_ID}/originals/${KID_OK}/view` });
    expect(d.fields.subject).toBe(`Synthetic ${KID_OK}`);
    expect(d.parent).toEqual({ ref: PARENT, exists: true });
  });

  test('a file that was not supplied has no links and no links call', async () => {
    let calls = 0;
    const l = locals(dep);
    const counted = { ...l, assets: { ...l.assets, links: async (a: never) => { calls++; return l.assets.links(a); } } } as RequestServices;
    for (const ref of [KID_GONE, NO_FILE]) {
      const d = await docLoad(event(counted, { ref }));
      expect([d.links, d.onDisk, d.state.file]).toEqual([{ presentation: null, open: null, download: null, viewer: null }, null, 'missing']);
    }
    expect(calls).toBe(0);
  });

  test('an e-mail lists its attachments inside the message and the documents extracted from it, without per-attachment links', async () => {
    let calls = 0;
    const l = locals(dep);
    const counted = { ...l, assets: { ...l.assets, links: async (a: never) => { calls++; return l.assets.links(a); } } } as RequestServices;
    const d = await docLoad(event(counted, { ref: PARENT }));
    expect(calls).toBe(1);
    expect(d.children).toEqual([KID_OK, KID_GONE]);
    expect(d.attachments.length).toBeGreaterThan(0);
    expect(d.attachments.every((x) => x.links === null)).toBe(true);
    expect(d.attachments.filter((x) => x.kind === 'embedded').every((x) => x.route === 'parent' && x.via === PARENT)).toBe(true);
  });

  test('an original the case loader never stored is reported as not available, not as a failure', async () => {
    const d = await docLoad(event(locals(dep), { ref: 'BK-0001' }));
    expect([d.links.open, d.onDisk]).toEqual([null, 'not-found']);
  });

  test('an unknown or malformed ref is 404', async () => {
    for (const ref of ['ZZ-9999', '..', 'a/b', '%00', 'x'.repeat(200)]) expect(await status(() => docLoad(event(locals(dep), { ref })))).toBe(404);
  });
});
