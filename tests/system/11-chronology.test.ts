// Sprint ticket 11: the hosted chronology over a published synthetic version with two list pages (06's world), and the
// shared page with its split pane, rendered as the local and hosted routes render it. The page load reads only the
// facets; the list endpoint serves one page shard as stored, or every page joined for the filters and the CSV export.
import { isHttpError } from '@sveltejs/kit';
import { render } from 'svelte/server';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { load as pageLoad } from '../../deploy/client/routes/cases/[caseId]/v/[version]/chronology/+page.server.ts';
import { GET as listGet } from '../../deploy/client/routes/cases/[caseId]/v/[version]/chronology/list.json/+server.ts';
import { GET as originalGet } from '../../deploy/client/routes/cases/[caseId]/v/[version]/chronology/original/[ref]/+server.ts';
import type { ChronologyListRow } from '../../src/lib/local-case/model.ts';
import { facetsOf } from '../../src/lib/local-case/chronology.ts';
import { memoryShardBucket, memoryShardCache } from '../../src/lib/server/runtime/memory-shards.ts';
import type { ListPage } from '../../src/lib/views/payloads/list.ts';
import ChronologyPane from '../../src/lib/views/evidence/ChronologyPane.svelte';
import { grantedIdentity, ids } from '../hosted-foundation/storage/fixture.ts';
import { builtCase, CASE_ID, EXTRA_ROWS, locals, published, type BuiltCase, type Deployment } from '../publication/shards/world.ts';

const nav = vi.hoisted(() => ({ url: new URL('https://client-a.example.invalid/') }));
vi.mock('$app/state', () => ({ page: { get url() { return nav.url; }, state: {} } }));
vi.mock('$app/navigation', () => ({ replaceState: () => {}, goto: () => Promise.resolve(), invalidateAll: () => Promise.resolve() }));

let b: BuiltCase, dep: Deployment;
beforeAll(async () => { b = await builtCase(); dep = await published(b); }, 120_000);
afterAll(() => b?.cleanup());

const rv = () => b.built.record.resultsVersion;
const base = `/cases/${CASE_ID}/v`;
const listUrl = (q: string) => new URL(`https://client-a.example.invalid${base}/${encodeURIComponent(rv())}/chronology/list.json${q}`);
const event = (l = locals(dep), url = listUrl(''), params: Record<string, string> = {}) =>
  ({ locals: l, params: { caseId: CASE_ID, version: rv(), ...params }, url, request: new Request(url) }) as never;
async function status(run: () => unknown): Promise<number | string> {
  try { const r = await run(); return r instanceof Response ? r.status : 'ok'; } catch (e) {
    if (isHttpError(e)) return e.status;
    throw e;
  }
}
const list = async (q: string, l = locals(dep)) => (await listGet(event(l, listUrl(q)))) as Response;

describe('11 hosted chronology routes', () => {
  test('the page load returns the facets shard, the first list page, the list endpoint, the CSV name and the route base', async () => {
    const reads: string[] = [];
    const counted = { get: (k: string) => { reads.push(k.split('/').slice(2).join('/')); return dep.bucket.get(k); } };
    const data = await pageLoad(event(locals(dep, { bucket: counted, cache: null })));
    expect(data.listHref).toBe(`${base}/${rv()}/chronology/list.json`);
    expect(data.originalBase).toBe(`${base}/${rv()}/chronology/original`);
    expect(data.base).toBe(base);
    expect(data.exportName).toEqual({ name: 'chronology.csv', note: null });
    expect(data.facets.bundles.map(([v]) => v)).toEqual(expect.arrayContaining(['Bulk A', 'Bulk B']));
    expect(data.facets.years.map(([v]) => v)).toEqual(expect.arrayContaining(['2000', '2004']));
    expect(data.first.page).toBe(1);
    expect(data.first.rows).toHaveLength(200);
    expect(reads.sort()).toEqual(['list/facets.json', 'list/page-1.json']);
  });

  test('?page=n serves that page shard with immutable private caching; page 1 is the default; past the end is 404', async () => {
    const one = await list('?page=1');
    expect(one.status).toBe(200);
    expect(one.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(one.headers.get('etag')).toBeTruthy();
    const p1 = (await one.json()) as ListPage;
    expect(p1.page).toBe(1);
    expect(p1.pages).toBeGreaterThanOrEqual(2);
    expect(p1.total).toBeGreaterThan(EXTRA_ROWS);
    expect(p1.rows).toHaveLength(200);
    const p2 = (await (await list('?page=2')).json()) as ListPage;
    expect(p2.page).toBe(2);
    expect(((await (await list('')).json()) as ListPage).rows.map((r) => r.ref)).toEqual(p1.rows.map((r) => r.ref));
    expect(await status(() => list(`?page=${p1.pages + 1}`))).toBe(404);
    for (const bad of ['?page=0', '?page=-1', '?page=x', '?page=1e3', '?page=01']) expect(await status(() => list(bad)), bad).toBe(400);
  });

  test('a matching If-None-Match is a 304 without a body', async () => {
    const etag = (await list('?page=2')).headers.get('etag')!;
    const url = listUrl('?page=2');
    const r = (await listGet({ ...(event(locals(dep), url) as object), request: new Request(url, { headers: { 'if-none-match': etag } }) } as never)) as Response;
    expect(r.status).toBe(304);
    expect(await r.text()).toBe('');
  });

  test('?all=1 joins every page in order: every row once, and the facets the publisher counted', async () => {
    const pages: ChronologyListRow[] = [];
    const first = (await (await list('?page=1')).json()) as ListPage;
    for (let n = 1; n <= first.pages; n++) pages.push(...((await (await list(`?page=${n}`)).json()) as ListPage).rows);
    const all = (await (await list('?all=1')).json()) as ListPage;
    expect(all.total).toBe(first.total);
    expect(all.rows.map((r) => r.ref)).toEqual(pages.map((r) => r.ref));
    expect(new Set(all.rows.map((r) => r.ref)).size).toBe(all.total);
    const facets = await pageLoad(event());
    expect(facetsOf(all.rows)).toEqual(facets.facets);
  });

  test('warm, the list endpoint reads no shard from storage', async () => {
    let reads = 0;
    const counted = { get: (k: string) => { reads++; return dep.bucket.get(k); } };
    const cache = memoryShardCache();
    await list('?page=2', locals(dep, { bucket: counted, cache }));
    expect(reads).toBe(1);
    await list('?page=2', locals(dep, { bucket: counted, cache }));
    expect(reads).toBe(1);
  });

  test('a case without a grant, or a version that is not the published one, is refused before any shard is read', async () => {
    let reads = 0;
    const counted = { get: (k: string) => { reads++; return dep.bucket.get(k); } };
    const denied = locals(dep, { identity: grantedIdentity(ids.clientA, []).identity, bucket: counted });
    expect([403, 404]).toContain(await status(() => listGet(event(denied, listUrl('?page=1')))));
    expect([403, 404]).toContain(await status(() => pageLoad(event(denied))));
    expect([403, 404]).toContain(await status(() => originalGet(event(denied, listUrl(''), { ref: 'BK-0000' }))));
    const other = locals(dep, { bucket: counted });
    expect(await status(() => listGet(event(other, listUrl('?all=1'), { version: `sha256:${'0'.repeat(64)}` })))).toBe(404);
    expect(reads).toBe(0);
  });

  // The shard world has no originals catalogue (08's); an assets handle answers for any asset the way 08's reader does,
  // and records what it was asked, so a refusal is seen to come before any asset is looked up or a ticket minted.
  function assetsDouble() {
    const asked: string[] = [];
    const metadata = (id: string) => ({ filename: `${id} Synthetic.pdf`, mediaType: 'application/pdf', size: 40 });
    const assets = {
      metadata: async ({ asset }: { asset: { assetId: string } }) => { asked.push(asset.assetId); return metadata(asset.assetId); },
      links: async ({ asset }: { asset: { assetId: string } }) => ({ originalHref: `/cases/${CASE_ID}/originals/${asset.assetId}`, downloadHref: `/cases/${CASE_ID}/originals/${asset.assetId}?download=1` }),
      availability: async ({ asset }: { asset: { assetId: string } }) => ({ kind: 'available', metadata: metadata(asset.assetId) }),
    };
    return { asked, l: () => ({ ...locals(dep), assets }) as never };
  }
  const original = (l: never, ref: string, params: Record<string, string> = {}) => originalGet(event(l, listUrl(''), { ref, ...params }));
  const allRefs = async () => ((await (await list('?all=1')).json()) as ListPage).rows;

  test("the original endpoint answers a document's own original as private, uncached JSON", async () => {
    const d = assetsDouble();
    const r = (await original(d.l(), 'BK-0000')) as Response;
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    const body = (await r.json()) as { view: Record<string, unknown>; viewHref: string; notesHref: string };
    expect(body.view).toMatchObject({ state: 'available', mode: 'pdf', filename: 'BK-0000 Synthetic.pdf', srcHref: `/cases/${CASE_ID}/originals/BK-0000` });
    expect(body.viewHref).toBe(`/cases/${CASE_ID}/originals/BK-0000/view`);
    expect(body.notesHref).toBe(`/cases/${CASE_ID}/originals/BK-0000/notes`);
    expect(d.asked).toEqual(['BK-0000']);
  });

  test('a ref with no document in the version, or a malformed one, is 404 before any asset is looked up', async () => {
    const d = assetsDouble();
    for (const ref of ['ZZ-9999', 'BK-9999', '../x', '', 'a b']) expect(await status(() => original(d.l(), ref)), ref).toBe(404);
    expect(d.asked).toEqual([]);
  });

  test('a version that is not the published one is 404 before any asset is looked up', async () => {
    const d = assetsDouble();
    for (const version of [`sha256:${'0'.repeat(64)}`, 'latest']) expect(await status(() => original(d.l(), 'BK-0000', { version })), version).toBe(404);
    expect(d.asked).toEqual([]);
  });

  test("an asset id that is not a document's own (a package file, an attachment) is 404; so is a document without its own original", async () => {
    const d = assetsDouble();
    const rows = await allRefs();
    const docs = new Set(rows.map((r) => r.ref));
    const originals = JSON.parse(new TextDecoder().decode(b.files.get('originals.json')!)) as { id: string }[];
    const notDocuments = originals.map((o) => o.id).filter((id) => !docs.has(id));
    expect(notDocuments.length).toBeGreaterThan(0); // the synthetic package carries package files
    for (const id of [...notDocuments.slice(0, 3), 'BK-0000.a1']) expect(await status(() => original(d.l(), id)), id).toBe(404);
    // Every synthetic document has its own original, so a copy of the shards marks one document's original missing.
    const shards = memoryShardBucket(new Map(dep.bucket.objects));
    const key = [...shards.objects.keys()].find((k) => k.endsWith('/list/page-1.json'))!;
    const page1 = JSON.parse(new TextDecoder().decode(shards.objects.get(key)!)) as ListPage;
    const gone = page1.rows[0]!.ref;
    page1.rows[0] = { ...page1.rows[0]!, file: 'missing' };
    shards.objects.set(key, new TextEncoder().encode(JSON.stringify(page1)));
    const withMissing = { ...(locals(dep, { bucket: shards, cache: null }) as object), assets: (d.l() as { assets: unknown }).assets } as never;
    expect(await status(() => original(withMissing, gone)), gone).toBe(404);
    expect(d.asked).toEqual([]);
  });
});

const row = (ref: string, o: Partial<ChronologyListRow> = {}): ChronologyListRow => ({
  ref, ord: 0, date: '2001-02-03', dateType: null, dateSource: null, docType: 'letter', bundle: 'Bulk A', subject: `Invented subject ${ref}`, filename: `${ref}.pdf`, sender: 'Invented sender', to: '',
  excerpt: '', amount: '', alsoIn: [], url: '', textStatus: 'extracted', parentRef: null, file: 'present', preview: 'inline-isolated', attachments: 0, ...o,
});
const pane = (props: Record<string, unknown>) => render(ChronologyPane, { props: { row: null, selected: null, docHref: null, onback: () => {}, ...props } as never }).body;

describe('11 chronology split pane', () => {
  test('without a selection it asks for one; the pane hook carries no ref', () => {
    const html = pane({});
    expect(html).toContain('data-testid="chronology-document-pane"');
    expect(html).not.toContain('data-ref=');
    expect(html).toContain('data-pane-state="none"');
  });

  test('a selected row not loaded yet is loading; a loaded row shows its ref, title and a link to its document page', () => {
    expect(pane({ selected: 'SX-9' })).toMatch(/data-ref="SX-9"[\s\S]*data-pane-state="loading"/);
    const html = pane({ selected: 'SX-1', row: row('SX-1'), docHref: '/v/x/doc/SX-1' });
    expect(html).toContain('data-ref="SX-1"');
    expect(html).toContain('Invented subject SX-1');
    expect(html).toMatch(/<a [^>]*href="\/v\/x\/doc\/SX-1"[^>]*>Open document page<\/a>/);
  });

  test('a missing or blocked original and a download-only original each show their own state, never an empty viewer', () => {
    expect(pane({ selected: 'SX-2', row: row('SX-2', { file: 'missing' }), docHref: '/d' })).toContain('data-pane-state="missing"');
    expect(pane({ selected: 'SX-3', row: row('SX-3', { file: 'blocked' }), docHref: '/d' })).toContain('data-pane-state="missing"');
    expect(pane({ selected: 'SX-4', row: row('SX-4', { preview: 'download' }), docHref: '/d' })).toContain('data-pane-state="download-only"');
  });

  test('locally the original opens from the document page (the originals site refuses to be framed)', () => {
    expect(pane({ selected: 'SX-5', row: row('SX-5'), docHref: '/d' })).toContain('data-pane-state="local"');
  });
});

describe('11 chronology page', () => {
  const RV = `sha256:${'e'.repeat(64)}`;
  const rows = Array.from({ length: 3 }, (_, i) => row(`SX-${i + 1}`, { ord: i, date: `200${i}-01-01`, bundle: i ? 'Bulk B' : 'Bulk A' }));
  const page = async (search: string) => {
    nav.url = new URL(`https://client-a.example.invalid${base}/${RV}/chronology${search}`);
    const Page = (await import('../../src/routes/v/[vid]/chronology/+page.svelte')).default;
    const data = { version: { id: RV, caseId: CASE_ID, titleName: 'Invented case' }, base, exportName: { name: 'chronology.csv', note: null }, listHref: '/x', facets: facetsOf(rows),
      first: { page: 1, pages: 1, total: rows.length, rows }, failed: [] };
    return render(Page, { props: { data } as never, context: new Map([['clearcase:base', () => base]]) }).body;
  };

  test('the list and the pane render side by side hooks, a Preview control per row and the year filter from the facets', async () => {
    const html = await page('');
    expect(html).toContain('data-testid="chronology-list"');
    expect(html).toContain('data-testid="chronology-document-pane"');
    expect(html.match(/aria-label="Preview SX-\d[^"]*"/g)).toHaveLength(3);
    expect(html).toMatch(/<select id="f-year"[\s\S]*<option value="2000">2000<\/option>[\s\S]*<option value="2002">2002<\/option>/);
    expect(html).toContain(`href="${base}/${encodeURIComponent(RV)}/doc/SX-1"`);
  });

  test('?doc= selects that row: the pane carries its ref and the row is marked selected', async () => {
    const html = await page('?doc=SX-2');
    expect(html).toMatch(/data-testid="chronology-document-pane"[^>]*data-ref="SX-2"|data-ref="SX-2"[^>]*data-testid="chronology-document-pane"/);
    expect(html).toMatch(/class="grid-row[^"]*selected[^"]*"[^>]*data-ref="SX-2"/);
  });

  test('a filter that matches nothing says so and offers Clear filters', async () => {
    const html = await page('?year=1999');
    expect(html).toContain('No documents match');
    expect(html).toMatch(/<button[^>]*>Clear filters<\/button>/);
    expect(html).toContain('data-count="0"');
  });
});
