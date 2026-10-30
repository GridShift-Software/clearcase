import { render } from 'svelte/server';
import { expect, it, vi } from 'vitest';
import NotesPage from '../../../deploy/client/routes/cases/[caseId]/notes/+page.svelte';
import { load } from '../../../deploy/client/routes/cases/[caseId]/notes/+page.server.ts';
import { CASE, RV, event, fake } from './doubles.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));
vi.mock('$app/navigation', () => ({ goto: () => Promise.resolve(), invalidateAll: () => Promise.resolve(), beforeNavigate: () => {}, afterNavigate: () => {} }));

it('16 case notes list exposes each document note body, ref and date as plain text', async () => {
  const f = fake({ publication: { kind: 'published', resultsVersion: RV } });
  f.notes.set('synthetic-note', {
    id: 'synthetic-note', body: 'Synthetic <script>note</script> body', version: id('row-version', 'note-version'),
    createdAt: '2200-03-04T12:00:00.000Z', target: { kind: 'document', anchor: { caseId: CASE, resultsVersion: RV, refAtCreation: 'DOC-001', sha256: null } },
    status: 'here', candidates: [], intact: true,
  });
  const data = await load(event(f.services, { caseId: CASE }));
  const html = render(NotesPage, { props: { data, form: null } }).body;
  expect(html).toContain('data-testid="case-notes-list"');
  expect(html).toContain('Synthetic &lt;script>note&lt;/script> body');
  expect(html).toContain('on DOC-001');
  expect(html).toContain('2200-03-04');
  expect(html).not.toContain('<script>note');
});
