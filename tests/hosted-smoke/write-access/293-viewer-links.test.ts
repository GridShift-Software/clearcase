// GRS-293: page links and the CaseLines subtitle as the pages render them. On hosted, a CaseLines search hit (and its Go to
// page, which follows the same link) and the document page's Open-at-page link ask the native viewer for the page in its
// `page` query parameter, which its load reads (tests/hosted-foundation/budget/293-viewer-navigation.test.ts follows these
// links into it); the local pilot keeps its PDF `#page=` fragment. A viewer's CaseLines subtitle never offers adding
// documents, even when the imported copy does; an editor and the local pilot keep the imported copy. Synthetic data only.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('$app/navigation', () => ({ goto: () => Promise.resolve(), beforeNavigate: () => {}, afterNavigate: () => {}, invalidateAll: () => Promise.resolve() }));
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }), applyAction: async () => {} }));
vi.mock('$app/state', () => ({ page: { url: new URL('https://synthetic.invalid/cases/c/v/x/bundles/caselines_tab'), route: { id: null }, params: {} } }));
import WithAccess from './WithAccess.svelte';
import CaseLinesPage from '../../../src/routes/v/[vid]/bundles/caselines_tab/+page.svelte';
import OriginalOpen from '../../../src/lib/components/OriginalOpen.svelte';
import { bundleLinks } from '../../../src/lib/views/bundles/links.hosted.ts';
import { hrefOf } from '../../../src/lib/views/bundles/links.ts';
import { viewerPageHref } from '../../../src/lib/viewer/hosted/page-link.ts';

type Access = 'viewer' | 'editor' | 'local';
const html = (page: unknown, props: Record<string, unknown>, access: Access) =>
  access === 'local' ? render(page as never, { props } as never).body : render(WithAccess, { props: { canWrite: access === 'editor', page: page as never, props } }).body;
const VIEW = '/cases/case-a/originals/D-001/view';
const hosted = bundleLinks({ paths: { 'PLEADINGS/Synthetic bundle.pdf': { ref: 'D-001' } } } as never, 'case-a');
const caselines = (o: { subtitle?: string | null; files?: Record<string, string>; downloads?: Record<string, string> } = {}) => ({ data: {
  version: { id: 'rv-1', titleName: 'Synthetic matter' }, hosted: true, content: { name: 'Synthetic bundle', note: null, subtitle: o.subtitle ?? null }, pages: 3,
  bundle: { ref: 'D-001', page: null }, files: o.files ?? hosted.files, downloads: o.downloads ?? hosted.downloads,
  cover: { indexed: 3, withoutText: 0, emptyPages: [] }, q: 'synthetic', qTooLong: false,
  search: { total: 1, occurrences: 1, hits: [{ p: 2, pre: 'a ', mid: 'synthetic', post: ' word', count: 1 }] }, links: [],
} });

describe('293 the page-link contract', () => {
  it('the hosted native viewer takes the page as a query parameter, keeping its other parameters and fragment', () => {
    expect(viewerPageHref(VIEW, 2)).toBe(`${VIEW}?page=2`);
    expect(viewerPageHref(`${VIEW}?zoom=fit#top`, 2)).toBe(`${VIEW}?zoom=fit&page=2#top`);
    expect(viewerPageHref(`${VIEW}?page=9&zoom=fit`, 2)).toBe(`${VIEW}?page=2&zoom=fit`);
    for (const page of [null, undefined, 0]) expect(viewerPageHref(`${VIEW}?zoom=fit`, page)).toBe(`${VIEW}?zoom=fit`);
  });
  it('every other viewer keeps the PDF fragment exactly as before', () => {
    for (const href of ['/viewer', '/synthetic/bundle.pdf', 'http://127.0.0.1:5174/o/abc?x=1', '/cases/case-a/originals/D-001', '/cases/case-a/originals/D-001/viewer'])
      expect(viewerPageHref(href, 2)).toBe(`${href}#page=2`);
    expect(hrefOf('rv-1', { 'D-001': '/synthetic/bundle.pdf' }, { ref: 'D-001', page: 4 })).toBe('/synthetic/bundle.pdf#page=4');
    expect(hrefOf('rv-1', {}, { ref: 'D-002', page: 4 })).toBe('/v/rv-1/doc/D-002?page=4');
  });
});

describe('293 CaseLines', () => {
  for (const access of ['viewer', 'editor'] as const)
    it(`a hosted ${access}'s search hit opens the native viewer at that page; Open in app opens it plainly`, () => {
      const body = html(CaseLinesPage, caselines(), access);
      expect(body).toContain(`href="${VIEW}?page=2" data-p="2"`);
      expect(body).toContain(`href="${VIEW}" id="cl-open"`);
      expect(body).not.toContain('#page=');
    });
  it('the local pilot keeps the fragment link', () => {
    const body = html(CaseLinesPage, caselines({ files: { 'D-001': '/synthetic/bundle.pdf' }, downloads: {} }), 'local');
    expect(body).toContain('href="/synthetic/bundle.pdf#page=2" data-p="2"');
  });

  const ADDING = 'The consolidated synthetic court bundle (Pleadings) — open, download, search, and add documents';
  it('a viewer never reads an imported offer to add documents; an editor and the local pilot keep the imported copy', () => {
    const viewer = html(CaseLinesPage, caselines({ subtitle: ADDING }), 'viewer');
    expect(viewer).not.toMatch(/add documents/i);
    expect(viewer).toContain('The consolidated court bundle — open, download and search');
    for (const access of ['editor', 'local'] as const) expect(html(CaseLinesPage, caselines({ subtitle: ADDING }), access), access).toContain(ADDING);
  });
  it('imported copy that offers nothing to add is kept for a viewer, and the defaults stay by role', () => {
    const plain = 'The consolidated synthetic court bundle (Pleadings) — open, download and search';
    expect(html(CaseLinesPage, caselines({ subtitle: plain }), 'viewer')).toContain(plain);
    expect(html(CaseLinesPage, caselines(), 'viewer')).toContain('The consolidated court bundle — open, download and search');
    expect(html(CaseLinesPage, caselines(), 'editor')).toContain('The consolidated court bundle — open, download, search, and add documents');
  });
});

describe('293 the document page Open control', () => {
  const state = { file: 'present', preview: 'none', text: '', mediaType: 'application/pdf', flags: [], self: null,
    original: { path: 'SYNTHETIC/letter.pdf', sha256: '0'.repeat(64), size: 10, mediaType: 'application/pdf', status: 'verified', downloadOnly: false } };
  const shell = new Map<string, unknown>([['clearcase:hosted', () => true], ['clearcase:base', () => '/cases/case-a/v']]);
  const open = (viewer: string, page: number | null, context?: Map<string, unknown>) =>
    render(OriginalOpen as never, { props: { state, links: { presentation: 'viewer', open: '/o', download: '/d', viewer }, page }, ...(context ? { context } : {}) } as never).body;
  it('on hosted opens the native viewer at the page by its query parameter', () => {
    expect(open(VIEW, 2, shell)).toContain(`href="${VIEW}?page=2"`);
    expect(open(VIEW, 2, shell)).toContain('Open at page 2');
    expect(open(VIEW, null, shell)).toContain(`href="${VIEW}"`);
  });
  it('locally keeps the PDF fragment', () => {
    expect(open('/viewer', 2)).toContain('href="/viewer#page=2"');
    expect(open('/viewer', null)).toContain('href="/viewer"');
  });
});
