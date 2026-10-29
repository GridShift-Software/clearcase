// GRS-276: what a client sees on hosted. The case list shows a human name or none and the case's display label; the shared
// pages hide the pipeline's internals and the views hosted never serves, but only inside the hosted shell (the context
// AppShell sets from the hosted layout), so the local pilot keeps them. Unit renders only; no browser.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import CasesPage from '../../../deploy/client/routes/cases/+page.svelte';
import { load as casesLoad } from '../../../deploy/client/routes/cases/+page.server.ts';
import FreshnessWidget from '../../../src/lib/views/system/FreshnessWidget.svelte';
import OriginalOpen from '../../../src/lib/components/OriginalOpen.svelte';
import CourtBundlePage from '../../../src/routes/v/[vid]/bundles/court_bundle_tab/+page.svelte';
import { displayName } from '../../../src/lib/auth/display-name.ts';

vi.mock('$app/navigation', () => ({ goto: () => Promise.resolve(), invalidateAll: () => Promise.resolve(), afterNavigate: () => {}, beforeNavigate: () => {} }));
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://127.0.0.1/cases/c1/v/x/bundles/court_bundle_tab'), shallow: null } }));

const RAW_ID = 'user_3LK2uSUYzzrF0MLXIGsgigcwT6N';
const hosted = new Map<string, unknown>([['clearcase:hosted', () => true], ['clearcase:base', () => '/cases/c1/v']]);
const html = (C: unknown, props: Record<string, unknown>, context?: Map<string, unknown>) => render(C as never, { props, ...(context ? { context } : {}) } as never).body;

describe('the case list', () => {
  const info = (caseLabel: string | null, kind: 'published' | 'none' = 'published') => ({ caseId: 'v5-demo', caseLabel, href: '/cases/v5-demo', documents: null, publication: kind === 'published' ? { kind, resultsVersion: 'sha256:x' } : { kind } });
  const load = (identity: Record<string, unknown>, cases = [info('A v B')]) => casesLoad({ locals: { identity, store: { listCases: async () => cases } }, url: new URL('https://x.invalid/cases') } as never);

  it('shows a human name when the session carries one, and nothing when it carries only the subject', () => {
    expect(displayName({ name: 'Ada Lovelace', principal: { subject: RAW_ID } })).toBe('Ada Lovelace');
    expect(displayName({ name: RAW_ID, principal: { subject: RAW_ID } })).toBeNull();
    expect(displayName({ name: 'user_other', principal: { subject: RAW_ID } })).toBeNull();
    expect(displayName({ name: 'a-viewer', principal: { subject: 'a-viewer' } })).toBeNull();
    expect(displayName({ name: '  ', principal: { subject: RAW_ID } })).toBeNull();
    expect(displayName({ principal: null })).toBeNull();
    // An email configured as the name claim is an address, not a name: show nothing (276 review).
    expect(displayName({ name: 'synthetic.viewer@example.invalid', principal: { subject: RAW_ID } })).toBeNull();
    expect(displayName({ name: 'Viewer <synthetic@example.invalid>', principal: { subject: RAW_ID } })).toBeNull();
  });

  it('never sends or renders the raw Clerk ID', async () => {
    const data = await load({ name: RAW_ID, principal: { subject: RAW_ID } });
    expect(JSON.stringify(data)).not.toContain(RAW_ID);
    const body = html(CasesPage, { data });
    expect(body).not.toContain(RAW_ID);
    expect(body).not.toContain('Signed in as');
    expect(body).toContain('data-auth-state="signed-in"');
    expect(body).toContain('id="sign-out"');
  });

  it('shows the signed-in name beside Sign out, the display label as the case name and a neutral state for unpublished cases', async () => {
    const named = html(CasesPage, { data: await load({ name: 'Ada Lovelace', principal: { subject: RAW_ID } }) });
    expect(named).toContain('Signed in as <span data-testid="account-name">Ada Lovelace</span>');
    expect(named).toContain('data-case-id="v5-demo" data-action="open-case" href="/cases/v5-demo"><span class="case-name">A v B</span>');
    expect(named).toContain('<span class="case-open">Open</span>');
    const none = html(CasesPage, { data: await load({ principal: { subject: RAW_ID } }, [info('A v B', 'none')]) });
    expect(none).toContain('No results yet');
    expect(none).not.toContain('(results not published)');
  });

  it('falls back to the case id only when no label exists anywhere', async () => {
    expect((await load({ principal: { subject: RAW_ID } }, [info(null)])).cases[0]!.label).toBe('v5-demo');
  });
});

describe('the shared pages inside the hosted shell', () => {
  const fresh = { builtAt: '2026-10-01 10:00', documents: 3, viaRescan: 0, lastScan: null, href: '/v/x/system/rescan_tab' };
  it('the freshness card keeps its stamp and drops the rescan link', () => {
    const local = html(FreshnessWidget, { data: fresh, ctx: {} });
    expect(local).toContain('Rescan &amp; Update');
    const onHosted = html(FreshnessWidget, { data: fresh, ctx: {} }, hosted);
    expect(onHosted).toContain('id="freshness-stamp"');
    expect(onHosted).not.toMatch(/Rescan|rescanned/);
  });

  const original = { file: 'present', preview: 'none', text: '', mediaType: 'application/pdf', flags: [], self: null,
    original: { path: 'CORRESPONDENCE/Hard copy letter (1).pdf', sha256: 'cea5360929d1'.padEnd(64, '0'), size: 629129, mediaType: 'application/pdf', status: 'verified', downloadOnly: false } };
  const links = { presentation: 'viewer', open: '/o', download: '/d', viewer: '/viewer' };
  it('the original card hides the case folder path and the hash, and keeps the type, the size and the links', () => {
    const local = html(OriginalOpen, { state: original, links });
    expect(local).toContain('CORRESPONDENCE/Hard copy letter (1).pdf');
    expect(local).toContain('sha256 cea5360929d1');
    const onHosted = html(OriginalOpen, { state: original, links }, hosted);
    expect(onHosted).not.toMatch(/CORRESPONDENCE|sha256|Direct original/);
    expect(onHosted).toContain('application/pdf, 629,129 bytes');
    expect(onHosted).toContain('id="open-original"');
    expect(onHosted).toContain('id="download-original"');
  });
  it('a missing stored original says so without the path or the restore instruction', () => {
    const onHosted = html(OriginalOpen, { state: original, links, onDisk: 'missing-original' }, hosted);
    expect(onHosted).toContain('This original is not available right now.');
    expect(onHosted).not.toMatch(/CORRESPONDENCE|case folder|Restore/);
    expect(html(OriginalOpen, { state: original, links, onDisk: 'missing-original' })).toContain('Restore the file at that path in the case folder');
  });
});

describe('the Court Bundle list', () => {
  const row = { n: 1, key: 'A', desc: 'Item', date: '', blank: false, missing: false, review: false, pages: 2, from: 1, to: 2, sliceUrl: '', caselines: null, parts: [] };
  const bundle = (no: string, over: Record<string, unknown> = {}) => ({ no, name: `Bundle ${no}`, title: `Bundle ${no}`, note: '', rows: [row], pages: 2, indexPages: 1, file: '', indexFile: '', ...over });
  const none = { file: null, indexFile: null, rows: [{ slice: null, parts: [], caselines: null }] };
  const header = Object.fromEntries(['court', 'judge', 'intro', 'caseNo', 'claimant', 'claimantRole', 'defendant', 'defendantRole'].map((k) => [k, '']));
  const data = (isHosted: boolean) => ({
    ...(isHosted ? { hosted: true } : {}), present: true, version: { id: 'sha256:x', titleName: 'Case' }, content: { examples: {}, docxCreator: null, allIndexesFileName: null },
    bundles: [bundle('1', { file: 'v5/bundle.pdf', indexFile: 'v5/index.pdf' }), bundle('2', { id: 'saved-1', file: '' })],
    links: [none, { ...none, file: { ref: 'saved-1', page: null } }], files: { 'saved-1': '/cases/c1/v/x/bundles/court_bundle_tab/assembled?id=saved-1' }, downloads: {},
    header, headerStored: false, headerHash: 'h',
  });
  const rows = (body: string) => [...body.matchAll(/<tr data-no="([^"]*)">([\s\S]*?)<\/tr>/g)].map((m) => [m[1], m[2]!] as const);

  it('hosted says nothing about the unavailable PDFs of a v5 bundle and still links a saved bundle\'s stored PDF', () => {
    const [v5, saved] = rows(html(CourtBundlePage, { data: data(true) }, hosted));
    expect(v5![1]).not.toContain('not available on hosted');
    expect(v5![1]).not.toMatch(/Bundle PDF|Index PDF/);
    expect(v5![1]).toContain('>Open</button>');
    expect(saved![1]).toContain('href="/cases/c1/v/x/bundles/court_bundle_tab/assembled?id=saved-1"');
    expect(saved![1]).toContain('Bundle PDF');
  });
  it('the local page keeps its wording', () => {
    const [v5] = rows(html(CourtBundlePage, { data: data(false) }));
    expect(v5![1]).toContain('Bundle PDF');
    expect(v5![1]).toContain('Index PDF');
  });
});
