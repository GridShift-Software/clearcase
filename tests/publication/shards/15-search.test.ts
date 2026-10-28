// Sprint ticket 15: the search index shard and the hosted search routes over a published synthetic version: the builder
// writes `search/index.json` from the document rows, the page finds the synthetic documents by reference, file name
// fragment, subject word and sender, the export is the CSV of the query, and `/search` redirects to the view.
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { GET as exportGet } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/evidence/search/export/+server.ts';
import { load as searchLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/evidence/search/+page.server.ts';
import { load as redirectLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/search/+page.server.ts';
import { hostedStatus } from '../../../src/lib/views/hosted/availability.ts';
import type { SearchIndex } from '../../../src/lib/views/evidence/search.ts';
import { grantedIdentity, ids } from '../../hosted-foundation/storage/fixture.ts';
import { builtCase, CASE_ID, locals, published, type BuiltCase, type Deployment } from './world.ts';

let b: BuiltCase, dep: Deployment;
beforeAll(async () => { b = await builtCase(); dep = await published(b); }, 120_000);
afterAll(() => b?.cleanup());

const rv = () => b.built.record.resultsVersion;
const event = (search: string, l = locals(dep)) => ({ locals: l, params: { caseId: CASE_ID, version: rv() }, url: new URL(`https://client-a.example.invalid/cases/${CASE_ID}/v/x/evidence/search${search}`) }) as never;
const view = (search: string) => searchLoad(event(search)) as Promise<Awaited<ReturnType<typeof searchLoad>>>;
const refsOf = (d: Awaited<ReturnType<typeof view>>) => (d.result?.kind === 'results' ? d.result.page.slice.map((x) => x.ref) : null);
async function status(run: () => unknown): Promise<number | string> {
  try { await run(); return 'ok'; } catch (e) {
    if (isHttpError(e)) return e.status;
    if (isRedirect(e)) return `${e.status} ${e.location}`;
    throw e;
  }
}
const index = () => JSON.parse(new TextDecoder().decode(b.files.get('search/index.json'))) as SearchIndex;

describe('15 search index shard', () => {
  test('the builder writes one row per document, with the fields search reads and no full text', () => {
    const idx = index();
    expect(idx.rows).toHaveLength(b.built.manifest.counts.documents);
    expect(Object.keys(idx.rows[0]!).sort()).toEqual(['amount', 'bundle', 'cc', 'date', 'docType', 'excerpt', 'file', 'filename', 'ref', 'sender', 'subject', 'textStatus', 'to']);
    expect(b.built.manifest.shards.some((s) => s.name === 'search/index.json')).toBe(true);
  });
});

describe('15 hosted search routes', () => {
  test('search is ported; the view is idle before a query', async () => {
    expect(hostedStatus('search')).toBe('ported');
    const d = await view('');
    expect(d).toMatchObject({ submitted: false, result: { kind: 'idle' }, failed: [], exportName: { name: 'search.csv', note: null }, base: `/cases/${CASE_ID}/v` });
    expect(d.coverage.documents).toBe(b.built.manifest.counts.documents);
  });

  test('a reference, a file name fragment, a subject word and a sender each find their document', async () => {
    expect(refsOf(await view('?q=BK-0042'))).toEqual(['BK-0042']);
    expect(refsOf(await view('?q=bk-0107%20synthetic'))).toEqual(['BK-0107']);
    expect(refsOf(await view('?q=Synthetic%20BK-0199'))).toEqual(['BK-0199']);
    const bySender = await view('?sender=test%20sender');
    expect(bySender.result?.kind === 'results' && bySender.result.page.total).toBeGreaterThanOrEqual(230);
  });

  test('results are 50 a page and the query is echoed back', async () => {
    const d = await view('?q=Synthetic&page=2');
    expect(d.query.q).toBe('Synthetic');
    expect(d.result?.kind === 'results' && [d.result.page.page, d.result.page.slice.length]).toEqual([2, 50]);
  });

  test('a bad date is reported, not searched', async () => {
    expect((await view('?q=x&from=nope')).result).toMatchObject({ kind: 'invalid' });
  });

  test('the export is the CSV of the query, in index order, with a link to each document', async () => {
    const res = (await exportGet(event('?q=BK-004&type=&bundle=&sender=&from=&to=&amin=&amax=&status='))) as Response;
    expect(res.headers.get('content-type')).toMatch(/^text\/csv/);
    const lines = (await res.text()).trim().split(/\r?\n/);
    expect(lines[0]).toBe('ref,date,filename,subject,sender,doc_type,bundle,amount,text_status,url');
    expect(lines).toHaveLength(11); // BK-0040 to BK-0049
    expect(lines[1]).toContain('BK-0040');
    expect(lines[1]).toContain(`/cases/${CASE_ID}/v/${encodeURIComponent(rv())}/doc/BK-0040`);
    expect(await status(() => exportGet(event('?from=2002-13-01')))).toBe(400);
  });

  test('/search redirects to the view and keeps the query', async () => {
    expect(await status(() => redirectLoad(event('?q=BK-0042')))).toBe(`303 /cases/${CASE_ID}/v/${encodeURIComponent(rv())}/evidence/search?q=BK-0042`);
  });

  test('without a grant the view, the export and the redirect are 403 or 404 and read no shard', async () => {
    let reads = 0;
    const counted = { get: (k: string) => { reads++; return dep.bucket.get(k); } };
    const l = locals(dep, { identity: grantedIdentity(ids.clientA, []).identity, bucket: counted });
    expect([403, 404]).toContain(await status(() => searchLoad(event('?q=a', l))));
    expect([403, 404]).toContain(await status(() => exportGet(event('', locals(dep, { identity: grantedIdentity(ids.clientA, []).identity, bucket: counted })))));
    expect([403, 404]).toContain(await status(() => redirectLoad(event('', locals(dep, { identity: grantedIdentity(ids.clientA, []).identity, bucket: counted })))));
    expect(reads).toBe(0);
  });
});
