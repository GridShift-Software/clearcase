import { describe, expect, it, vi } from 'vitest';
import { hostedWork, guarded } from '../../../src/lib/views/hosted/work-adapter.server.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import type * as C from '../../../src/lib/server/runtime/contracts.ts';
import { fixture, CASE, RV1 } from './helpers.ts';
import { SHA_A, OTHER_CASE } from './world.ts';

const VERSION = id('row-version', 'version-1'), REV = id('case-revision', 'revision-1');
const anchor: C.Anchor = { caseId: CASE, resultsVersion: RV1, refAtCreation: 'D-001', sha256: SHA_A };
const note: C.HostedNote = { id: 'note-1', body: 'Synthetic note', target: { kind: 'document', anchor }, createdAt: '2200-01-01T00:00:00Z', intact: true, status: 'here', candidates: [] };
const written = <T>(value: T): C.Written<T> => ({ kind: 'written', value, version: VERSION, caseRevision: REV });
const say = { busy: 'Busy; try again.', refused: 'Refused.', failed: 'Failed.' };

describe('16 shared hosted work adapter', () => {
  it('maps every Work method, scope, anchor, version and operation id', async () => {
    const row = { rowId: 'row-1', store: 'time', fields: { hours: 2 }, anchor, createdAt: '', updatedAt: '', intact: true, version: VERSION };
    const userWork = {
      anchorFor: vi.fn(async () => anchor), notesFor: vi.fn(async () => [{ ...note, version: VERSION }]),
      addNote: vi.fn(async () => written(note)), deleteNote: vi.fn(async () => written(true)),
      listRows: vi.fn(async () => [row]), putRow: vi.fn(async () => written({ rowId: 'row-1', repeated: false })), deleteRow: vi.fn(async () => written(true)),
      seedViews: vi.fn(async () => []), putSeedOverlay: vi.fn(async () => written(undefined)),
      listTableRows: vi.fn(async () => [{ cells: { case_id: CASE, id: 'a' }, version: VERSION }]), putTableRow: vi.fn(async () => written(undefined)),
    };
    const locals = { userWork: userWork as unknown as C.AsyncUserWork };
    const w = hostedWork(locals, CASE, RV1, { addId: 'add-one' });
    expect(await w.listRows(CASE, 'time')).toEqual([row]);
    expect(await w.putRow(CASE, 'time', null, { hours: 2 }, anchor as never)).toBe('row-1');
    expect(userWork.putRow.mock.calls[0]).toEqual([{ caseId: CASE, store: 'time', rowId: null, fields: { hours: 2 }, anchor, expected: { kind: 'absent' }, operationId: 'add-one' }]);
    expect(await w.seedViews(CASE, RV1, 'parties')).toEqual([]);
    const overlay = { caseId: CASE, datasetKey: 'parties', seedId: 'p1', baseSeedSha256: 'd'.repeat(64), fields: { text: 'Synthetic' } };
    await w.putSeedOverlay(overlay);
    expect(userWork.putSeedOverlay.mock.calls[0]).toEqual([{ caseId: CASE, overlay, expected: { kind: 'absent' }, operationId: 'add-one' }]);
    expect(await w.notesFor(CASE, RV1, 'D-001')).toMatchObject([{ body: note.body, refAtCreation: 'D-001', resultsVersion: RV1, anchorSha256: SHA_A, version: VERSION }]);
    expect(await w.addNote(CASE, RV1, 'D-001', note.body)).toMatchObject({ body: note.body, refAtCreation: 'D-001', version: VERSION });
    expect(await w.listTableRows('example', { caseId: CASE })).toEqual([{ case_id: CASE, id: 'a' }]);
    await w.putTableRow('example', { case_id: CASE, id: 'a' }, { owner: 'test' });
    expect(userWork.putTableRow.mock.calls[0]).toEqual([{ caseId: CASE, table: 'example', row: { case_id: CASE, id: 'a' }, owner: 'test', operationId: 'add-one', expected: { kind: 'absent' } }]);
    const form = new FormData(); form.set('operationId', 'edit-one'); form.set('addId', 'ignored'); form.set('version', VERSION);
    const edit = hostedWork(locals, CASE, RV1, form);
    expect(await edit.deleteNote(CASE, 'note-1')).toBe(true);
    expect(await edit.deleteRow(CASE, 'time', 'row-1')).toBe(true);
    expect(userWork.deleteNote.mock.calls[0]).toEqual([{ caseId: CASE, operationId: 'edit-one', expected: { kind: 'match', version: VERSION }, id: 'note-1' }]);
    expect(userWork.deleteRow.mock.calls[0]).toEqual([{ caseId: CASE, operationId: 'edit-one', expected: { kind: 'match', version: VERSION }, store: 'time', rowId: 'row-1' }]);
    await expect(w.deleteNote(CASE, 'note-1')).rejects.toMatchObject({ code: 'stale' });
    await expect(w.listRows(OTHER_CASE, 'time')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('uses a generated operation id when the form supplies none', async () => {
    const addNote = vi.fn(async (_a: unknown) => written(note));
    const w = hostedWork({ userWork: { anchorFor: async () => anchor, addNote } as unknown as C.AsyncUserWork }, CASE, RV1);
    await w.addNote(CASE, RV1, 'D-001', note.body);
    expect(addNote.mock.calls[0]?.[0]).toMatchObject({ operationId: expect.stringMatching(/^[a-f0-9-]{36}$/) });
  });

  it.each(['busy', 'storage-unavailable', 'audit-unavailable', 'gone', 'stale', 'invalid'])('maps %s without disclosing backend details', async code => {
    const f = fixture();
    try {
      const r = await guarded('note', { body: 'kept' }, async () => { throw contractError(code); }, say, { body: 'kept' }, hostedWork({ userWork: f.make() }, CASE, RV1));
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected refusal');
      expect(r.failure.data.values).toEqual({ body: 'kept' });
      if (['busy', 'storage-unavailable', 'audit-unavailable'].includes(code)) expect(r.failure.data).toMatchObject({ retry: true, message: say.busy });
      if (code === 'gone') expect(r.failure.data).toMatchObject({ gone: true, retry: false });
      if (code === 'stale') expect(r.failure.data.message).toContain('changed by someone else');
      if (code === 'invalid') expect(r.failure.data.message).toBe(say.refused);
    } finally { f.db.close(); }
  });

  it('replays one note through the D1 double and refuses stale deletion', async () => {
    const f = fixture();
    try {
      const local = { userWork: f.make() }, form = { operationId: 'same-note' };
      const create = () => hostedWork(local, CASE, RV1, form).addNote(CASE, RV1, 'D-001', 'Synthetic durable note');
      expect(await create()).toEqual(await create());
      expect(await hostedWork(local, CASE, RV1).notesFor(CASE, RV1, 'D-001')).toHaveLength(1);
      const saved = (await local.userWork.notesFor({ caseId: CASE, target: null }))[0]!;
      const stale = await guarded('delete', null, async w => w.deleteNote(CASE, saved.id), say, {}, hostedWork(local, CASE, RV1, { version: 'stale', operationId: 'delete-stale' }));
      expect(stale.ok ? null : stale.failure.data.message).toContain('changed by someone else');
      expect(await local.userWork.notesFor({ caseId: CASE, target: null })).toHaveLength(1);
      await hostedWork(local, CASE, RV1, { version: saved.version, operationId: 'delete-current' }).deleteNote(CASE, saved.id);
      expect(await local.userWork.notesFor({ caseId: CASE, target: null })).toHaveLength(0);
    } finally { f.db.close(); }
  });
});
