// Server renders of the hosted case pages with hostile synthetic case text: every filename, subject, label, tally key
// and note body reaches the HTML as escaped text, never as markup. Unit doubles only; no browser.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import CasePage from '../../../deploy/client/routes/cases/[caseId]/+page.svelte';
import ChronologyPage from '../../../deploy/client/routes/cases/[caseId]/views/[resultsVersion]/chronology/+page.svelte';
import NotesPage from '../../../deploy/client/routes/cases/[caseId]/notes/+page.svelte';
import { load as caseLoad } from '../../../deploy/client/routes/cases/[caseId]/+page.server.ts';
import { load as chronoLoad } from '../../../deploy/client/routes/cases/[caseId]/views/[resultsVersion]/chronology/+page.server.ts';
import { load as notesLoad } from '../../../deploy/client/routes/cases/[caseId]/notes/+page.server.ts';
import { CASE, RV, event, fake, seedNote } from './doubles.ts';
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));
vi.mock('$app/navigation', () => ({ goto: () => Promise.resolve(), invalidateAll: () => Promise.resolve(), beforeNavigate: () => {}, afterNavigate: () => {} }));

const published = { kind: 'published' as const, resultsVersion: RV };
const html = (C: unknown, props: Record<string, unknown>) => render(C as never, { props } as never).body;
const safe = (body: string) => {
  expect(body).not.toMatch(/<img/i);
  expect(body).toContain('&lt;img src=x onerror=alert(1)>');
};

describe('hosted case pages escape case text', () => {
  it('the case page with a published overview', async () => {
    const data = await caseLoad(event(fake({ publication: published }).services, { caseId: CASE }));
    const body = html(CasePage, { data });
    safe(body);
    expect(body).toContain('data-overview-state="published"');
    expect(body).toContain(`href="/cases/${CASE}/v/${encodeURIComponent(RV)}/chronology"`);
    expect(body).toContain('id="count-documents" data-count="3"');
  });

  it('the case page while results are pending keeps the designed waiting state and the originals', async () => {
    const data = await caseLoad(event(fake({ publication: { kind: 'none' } }).services, { caseId: CASE }));
    const body = html(CasePage, { data });
    expect(body).toContain('data-results-state="pending"');
    expect(body).not.toContain('data-overview-state');
    expect(body).toContain('data-action="open-original"');
    expect(body).toContain('data-action="view-original"');
    expect(body).toContain('href="/cases/case-a1/originals/DOC-001/view"');
    expect(body).toContain('data-action="open-original" data-asset-id="DOC-001" href="/cases/case-a1/originals/DOC-001"');
    safe(body);
  });

  it('only offers a PDF reader link, preserving encoded server URLs and escaping filenames', () => {
    const data = { caseId: 'case/a&b', label: 'Case', results: null, overview: null, originals: { state: 'available' as const, items: [
      { assetId: 'asset/a&b', filename: '<img src=x onerror=alert(1)>.pdf', mediaType: 'application/pdf', size: 10, href: '/cases/case%2Fa%26b/originals/asset%2Fa%26b' },
      { assetId: 'other', filename: 'scan.tiff', mediaType: 'image/tiff', size: 20, href: '/cases/case%2Fa%26b/originals/other' },
    ] }, notes: { state: 'unavailable' as const, count: 0, href: '/cases/case%2Fa%26b/notes' } };
    const body = html(CasePage, { data });
    expect(body).toContain('href="/cases/case%2Fa%26b/originals/asset%2Fa%26b/view"');
    expect(body).toContain('href="/cases/case%2Fa%26b/originals/asset%2Fa%26b">&lt;img src=x onerror=alert(1)>.pdf</a>');
    expect(body).not.toContain('data-asset-id="other" href="/cases/case%2Fa%26b/originals/other/view"');
    expect(body).toContain('data-action="open-original" data-asset-id="other" href="/cases/case%2Fa%26b/originals/other"');
  });

  it('the chronology', async () => {
    const data = await chronoLoad(event(fake({ publication: published }).services, { caseId: CASE, resultsVersion: RV }, `https://client-a.example.invalid/cases/${CASE}/views/x/chronology`));
    const body = html(ChronologyPage, { data });
    safe(body);
    expect(body).toContain('data-asset-id="DOC-001"');
  });

  it('the notes page, including a refused save that keeps the user\'s text', async () => {
    const f = fake({ publication: published });
    seedNote(f, 'n1', 'v1', '<script>alert(1)</script>');
    const data = await notesLoad(event(f.services, { caseId: CASE }));
    const body = html(NotesPage, { data, form: { op: 'add', message: 'kept', body: 'my <b>draft</b>' } });
    expect(body).not.toContain('<script>alert');
    expect(body).toContain('&lt;script>alert(1)&lt;/script>');
    expect(body).toContain('my &lt;b>draft&lt;/b>');
    expect(body).toContain('data-note-version="v1"');
  });
});
