// GRS-284 (NAV-01): the Notes page links Chronology to the current version's chronology in the case's version shell,
// `/cases/<case>/v/<version>/chronology`, where a row opens its document and previews its original. Driven through the
// real notes load over the scripted RequestServices of doubles.ts and rendered by SSR; no browser.
import { render } from 'svelte/server';
import { expect, it, vi } from 'vitest';
import NotesPage from '../../../deploy/client/routes/cases/[caseId]/notes/+page.svelte';
import { load as notesLoad } from '../../../deploy/client/routes/cases/[caseId]/notes/+page.server.ts';
import { CASE, RV, event, fake } from './doubles.ts';
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));
vi.mock('$app/navigation', () => ({ goto: () => Promise.resolve(), invalidateAll: () => Promise.resolve(), beforeNavigate: () => {}, afterNavigate: () => {} }));

it('the Notes page links Chronology to the current version\'s chronology in the version shell', async () => {
  const data = await notesLoad(event(fake({ publication: { kind: 'published', resultsVersion: RV } }).services, { caseId: CASE }));
  const current = `/cases/${CASE}/v/${encodeURIComponent(RV)}/chronology`;
  expect(data.chronologyHref).toBe(current);
  const body = render(NotesPage, { props: { data, form: null } }).body;
  expect(body).toContain(`data-action="open-chronology" href="${current}"`);
  expect(body).not.toContain('/views/');
});
