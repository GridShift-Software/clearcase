// The version-scoped chronology route and the case notes route, driven through their real load functions and form
// actions with the scripted RequestServices of doubles.ts. Unit doubles only: no D1, R2, workerd or browser.
import { describe, expect, it } from 'vitest';
import { load as chronology } from '../../../deploy/client/routes/cases/[caseId]/views/[resultsVersion]/chronology/+page.server.ts';
import { actions, load as notesLoad } from '../../../deploy/client/routes/cases/[caseId]/notes/+page.server.ts';
import { CASE, OLD_RV, RV, event, fake, form, outcome, seedNote } from './doubles.ts';

const published = { kind: 'published' as const, resultsVersion: RV };
const chrono = (f: ReturnType<typeof fake>, rv: string, q = '') => outcome(chronology(event(f.services, { caseId: CASE, resultsVersion: rv }, `https://client-a.example.invalid/cases/${CASE}/views/${encodeURIComponent(rv)}/chronology${q}`)));
const act = (f: ReturnType<typeof fake>, name: 'add' | 'delete', fields: Record<string, string>) => { const r = form(fields); return outcome((actions[name] as (e: never) => unknown)(event(f.services, { caseId: CASE }, r.url, r.init))); };
const OP = '0b5f0c9e-7d7a-4c43-9c1f-2f2b8f9c0a11';

describe('version-scoped chronology', () => {
  it('serves only the current published version; a superseded, malformed, withdrawn or pending version is 404', async () => {
    const ok = await chrono(fake({ publication: published }), RV);
    expect('value' in ok && ok.value.chronology.total).toBe(3);
    for (const [pub, rv] of [[published, OLD_RV], [published, 'latest'], [{ kind: 'withdrawn' as const }, RV], [{ kind: 'none' as const }, RV]] as const) {
      const f = fake({ publication: pub });
      expect(await chrono(f, rv)).toMatchObject({ thrown: { status: 404 } });
      expect(f.calls.filter((c) => c === 'listJson')).toEqual([]);
    }
  });

  it('does not serve the published version while the store names another version active (no stale content)', async () => {
    const f = fake({ publication: published, active: OLD_RV });
    expect(await chrono(f, RV)).toMatchObject({ thrown: { status: 503 } });
    expect(f.calls).not.toContain('listJson');
  });

  it('searches with the local chronology semantics and links a row to an original only when the case lists that asset', async () => {
    const r = await chrono(fake({ publication: published }), RV, '?q=roof');
    if (!('value' in r)) throw new Error('refused');
    expect(r.value.chronology.items.map((i) => i.ref)).toEqual(['DOC-003']);
    expect(r.value.chronology.search).toBe('q=roof');
    const all = await chrono(fake({ publication: published }), RV, '?sort=amount&dir=desc');
    if (!('value' in all)) throw new Error('refused');
    const byRef = new Map(all.value.chronology.items.map((i) => [i.ref, i.originalHref]));
    expect(all.value.chronology.items[0]!.ref).toBe('DOC-002');
    expect(byRef.get('DOC-001')).toBe(`/cases/${CASE}/originals/DOC-001`);
    expect(byRef.get('DOC-003')).toBeNull(); // file missing, and not a listed original
  });

  it('keeps the rows when originals are unavailable, unlinked, and a denial fails the page', async () => {
    const r = await chrono(fake({ publication: published, fail: { originals: 'asset-unavailable' } }), RV);
    if (!('value' in r)) throw new Error('refused');
    expect(r.value.chronology.originals).toBe('unavailable');
    expect(r.value.chronology.items.every((i) => i.originalHref === null)).toBe(true);
    expect(await chrono(fake({ publication: published, fail: { getCase: 'forbidden' } }), RV)).toMatchObject({ thrown: { status: 404 } });
  });
});

describe('case notes through AsyncUserWork', () => {
  it('loads independently of results: a pending case still shows notes and offers no annotation version', async () => {
    const f = fake({ publication: { kind: 'none' } });
    seedNote(f, 'n1', 'v1', 'hello');
    const r = await outcome(notesLoad(event(f.services, { caseId: CASE })));
    if (!('value' in r)) throw new Error('refused');
    expect(r.value.notes).toMatchObject({ state: 'available', items: [{ id: 'n1', version: 'v1', body: 'hello' }] });
    expect(r.value.resultsVersion).toBeNull();
    expect(f.calls[0]).toBe('getCase');
  });

  it('saves a case note durably with the form\'s operation id, after the authorized case read', async () => {
    const f = fake({ publication: { kind: 'withdrawn' } });
    const r = await act(f, 'add', { body: 'Check the roof invoice', operationId: OP });
    expect(r).toMatchObject({ thrown: { status: 303, location: `/cases/${CASE}/notes?saved=1` } });
    expect(f.calls.slice(0, 2)).toEqual(['getCase', 'addNote']);
    expect(f.writes).toEqual([{ caseId: CASE, expected: { kind: 'absent' }, operationId: OP, target: { kind: 'case' }, body: 'Check the roof invoice' }]);
  });

  it('annotates a document only against the current published version; a moved version is 409 with the text kept', async () => {
    const f = fake({ publication: published });
    expect(await act(f, 'add', { body: 'Disputed', ref: 'DOC-002', resultsVersion: RV, operationId: OP })).toMatchObject({ thrown: { status: 303 } });
    expect(f.writes[0]).toMatchObject({ target: { kind: 'document', anchor: { caseId: CASE, resultsVersion: RV, refAtCreation: 'DOC-002' } } });
    const g = fake({ publication: published });
    const moved = await act(g, 'add', { body: 'Old view text', ref: 'DOC-002', resultsVersion: OLD_RV, operationId: OP });
    expect(moved).toMatchObject({ value: { status: 409, data: { op: 'add', body: 'Old view text', ref: 'DOC-002' } } });
    expect(g.writes).toEqual([]);
  });

  it('a stale delete is 409 with the server\'s current version and text, and deletes nothing', async () => {
    const f = fake({ publication: published });
    seedNote(f, 'n1', 'v2', 'edited elsewhere');
    const r = await act(f, 'delete', { id: 'n1', version: 'v1', operationId: OP, confirm: 'n1' });
    expect(r).toMatchObject({ value: { status: 409, data: { op: 'delete', current: { id: 'n1', version: 'v2', body: 'edited elsewhere' } } } });
    expect(f.notes.has('n1')).toBe(true);
    const ok = await act(f, 'delete', { id: 'n1', version: 'v2', operationId: `${OP}.d0`, confirm: 'n1' });
    expect(ok).toMatchObject({ thrown: { status: 303 } });
    expect(f.notes.has('n1')).toBe(false);
  });

  it('a delete not confirmed for that note deletes nothing, after the authorized case read: the page asks, or after Cancel does not (GRS-280)', async () => {
    const f = fake({ publication: published });
    seedNote(f, 'n1', 'v1', 'kept until confirmed'); seedNote(f, 'n2', 'v1', 'another note');
    for (const [extra, confirm] of [[{}, 'n1'], [{ confirm: 'n2' }, 'n1'], [{ confirm: '' }, 'n1'], [{ cancel: 'n1' }, null], [{ cancel: 'n1', confirm: 'n1' }, null]] as const) {
      const r = await act(f, 'delete', { id: 'n1', version: 'v1', operationId: OP, ...extra });
      expect(r, JSON.stringify(extra)).toEqual({ value: { status: 400, data: { op: 'delete', confirm } } });
    }
    expect([f.calls.includes('getCase'), f.calls.includes('deleteNote')]).toEqual([true, false]);
    expect([f.notes.has('n1'), f.writes]).toEqual([true, []]);
    expect(await act(f, 'delete', { id: 'n1', version: 'v1', operationId: OP, confirm: 'n1' })).toMatchObject({ thrown: { status: 303, location: `/cases/${CASE}/notes?deleted=1` } });
    expect([f.notes.has('n1'), f.notes.has('n2')]).toEqual([false, true]);
  });

  it('a storage fault keeps the text and the operation id, so saving again repeats the same write', async () => {
    const f = fake({ publication: published, fail: { addNote: 'storage-unavailable' } });
    const r = await act(f, 'add', { body: 'Do not lose me', operationId: OP });
    expect(r).toMatchObject({ value: { status: 503, data: { op: 'add', body: 'Do not lose me', operationId: OP } } });
  });

  it('refuses an empty note or a forged operation id without writing, and a denied write is 403', async () => {
    const f = fake({ publication: published });
    expect(await act(f, 'add', { body: '   ', operationId: OP })).toMatchObject({ value: { status: 400 } });
    expect(await act(f, 'add', { body: 'x', operationId: 'bad id with spaces' })).toMatchObject({ value: { status: 400, data: { body: 'x' } } });
    expect(f.writes).toEqual([]);
    const d = fake({ publication: published, fail: { addNote: 'forbidden' } });
    expect(await act(d, 'add', { body: 'x', operationId: OP })).toMatchObject({ thrown: { status: 403 } });
  });
});
