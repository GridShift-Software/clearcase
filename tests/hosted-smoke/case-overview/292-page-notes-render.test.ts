// GRS-292: the case notes list and a document's My notes show page notes as plain text with their page and a link back
// to the original's viewer, and offer no control of their own: a page note is changed or deleted in the viewer only.
// Synthetic doubles and invented values only.
import { render } from 'svelte/server';
import { expect, it, vi } from 'vitest';
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));
vi.mock('$app/navigation', () => ({ goto: () => Promise.resolve(), invalidateAll: () => Promise.resolve(), beforeNavigate: () => {}, afterNavigate: () => {} }));
vi.mock('$local/doc/[ref]/+page.svelte', async () => import('../../../src/routes/v/[vid]/doc/[ref]/+page.svelte'));
import NotesPage from '../../../deploy/client/routes/cases/[caseId]/notes/+page.svelte';
import Document from '../../../deploy/client/routes/cases/[caseId]/v/[version]/doc/[ref]/+page.svelte';
import { load } from '../../../deploy/client/routes/cases/[caseId]/notes/+page.server.ts';
import { CASE, RV, event, fake, seedNote } from './doubles.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import type * as C from '../../../src/lib/server/runtime/contracts.ts';
import type { DocumentPageNote } from '../../../src/lib/views/hosted/page-note-items.ts';

const SHA = 'd'.repeat(64);
const pageRow = (rowId: string, fields: Record<string, unknown>, createdAt = '2200-05-06T07:08:09.000Z'): C.Versioned<C.WorkRegisterRow> =>
  ({ rowId, store: 'original-page-notes', anchor: null, fields: fields as C.Fields, createdAt, updatedAt: createdAt, intact: true, version: id('row-version', `v-${rowId}`) });

it('292 the case notes list shows a page note beside the case notes, read only, for a viewer too', async () => {
  const f = fake({ publication: { kind: 'published', resultsVersion: RV } });
  seedNote(f, 'case-note', 'n1', 'Synthetic case note');
  f.rows.push(pageRow('page-row', { assetId: 'DOC-001', page: 4, body: 'Synthetic <b>page</b> note', sha256: SHA }), pageRow('broken-row', { assetId: 'DOC-001', body: 'no page' }));
  for (const canWrite of [true, false]) {
    f.services.canWriteWork = async () => canWrite;
    const data = await load(event(f.services, { caseId: CASE }));
    const html = render(NotesPage, { props: { data, form: null } }).body;
    const list = html.slice(html.indexOf('data-testid="case-notes-list"'));
    expect(list).toContain('Synthetic case note');
    expect(list).toContain('Synthetic &lt;b>page&lt;/b> note');
    expect(list).toContain('2200-05-06 · page 4 of original DOC-001');
    expect(list).toContain(`href="/cases/${CASE}/originals/DOC-001/view?page=4"`);
    expect(html).toContain('1 notes and 1 page note on originals');
    expect(html).toContain('1 stored page note could not be read, so it is not shown.');
    // the page note's item carries no form: no delete here, and the case note's delete stays an editor's
    const item = html.slice(html.indexOf('data-page-note-id="page-row"'));
    expect(item.slice(0, item.indexOf('</li>'))).not.toContain('<form');
    expect(html.includes('action="?/delete"')).toBe(canWrite);
  }
  expect(f.calls.filter((c) => c === 'readNoteWork' || c === 'notesFor')).toEqual(['readNoteWork', 'readNoteWork']);
});

it('292 a case with only page notes lists them, and no notes at all still says so', async () => {
  const f = fake({ publication: { kind: 'published', resultsVersion: RV } });
  f.rows.push(pageRow('only-row', { assetId: 'DOC-002', page: 1, body: 'Synthetic only page note', sha256: SHA }));
  const html = render(NotesPage, { props: { data: await load(event(f.services, { caseId: CASE })), form: null } }).body;
  expect(html).toContain('0 notes and 1 page note on originals');
  expect(html).toContain('Synthetic only page note');
  expect(html).not.toContain('No notes on this case yet.');
  const empty = render(NotesPage, { props: { data: await load(event(fake({ publication: { kind: 'published', resultsVersion: RV } }).services, { caseId: CASE })), form: null } }).body;
  expect(empty).toContain('No notes on this case yet.');
  expect(empty).not.toContain('page note');
});

it('292 an unavailable notes read shows neither list, never an empty one', async () => {
  const f = fake({ publication: { kind: 'published', resultsVersion: RV }, fail: { notesFor: 'storage-unavailable' } });
  f.rows.push(pageRow('page-row', { assetId: 'DOC-001', page: 4, body: 'Synthetic hidden page note', sha256: SHA }));
  const html = render(NotesPage, { props: { data: await load(event(f.services, { caseId: CASE })), form: null } }).body;
  expect(html).toContain('data-notes-unavailable');
  expect(html).not.toContain('Synthetic hidden page note');
  expect(html).not.toContain('case-notes-list');
});

it('292 a document\'s My notes shows its page notes with their page and viewer link, and no control for them', () => {
  const pageNote = (rowId: string, assetId: string, page: number, body: string, here: boolean): DocumentPageNote =>
    ({ rowId, version: `v-${rowId}`, assetId, page, body, createdAt: '2200-05-06T07:08:09.000Z', sha256: SHA, intact: true, href: `/cases/${CASE}/originals/${assetId}/view?page=${page}`, here });
  const data = {
    ref: 'D-001', source: 'results', version: { id: `sha256:${'a'.repeat(64)}`, titleName: 'Synthetic matter' },
    fields: { date: '', dateType: null, dateSource: null, subject: 'Synthetic document', filename: 'synthetic.pdf', docType: '', bundle: '', sender: '', to: '', cc: '', amount: '', invoiceNo: '', size: null, textStatus: '', alsoIn: [], attachmentNames: [], excerpt: '' },
    state: { file: 'missing', original: null, self: null, flags: [] },
    links: { presentation: null, open: null, download: null, viewer: null }, onDisk: null, page: null,
    attachments: [], children: [], related: [], parent: null, notes: [], operationId: 'synthetic-operation', base: '/cases/synthetic/v',
    pageNotes: [pageNote('p1', 'D-001', 2, 'Synthetic page two', true), pageNote('p2', 'D-044', 5, 'Synthetic duplicate bytes', false)],
  };
  const html = render(Document, { props: { data, form: null } as never }).body;
  const notes = html.slice(html.indexOf('id="notes"'), html.indexOf('</ul>', html.indexOf('id="notes"')));
  expect(notes).toContain('Synthetic page two');
  expect(notes).toContain('page 2 of original D-001</small>');
  expect(notes).toContain(`href="/cases/${CASE}/originals/D-001/view?page=2"`);
  expect(notes).toContain('page 5 of original D-044, which has the same bytes as this document’s original');
  expect(notes).not.toContain('<form');
  expect(notes).not.toContain('No notes.');
  expect(render(Document, { props: { data: { ...data, pageNotes: [] }, form: null } as never }).body).toContain('No notes.');
});
