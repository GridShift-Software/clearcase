import { it, expect } from 'vitest';
import { fixture, CASE, RV1 } from './helpers.ts';
it('rolls back an unaudited fresh note, then replays a committed note after withdrawal', async () => {
 const { db, audit, reader, make } = fixture(); const work = make();
 const anchor = await work.anchorFor({ caseId: CASE, resultsVersion: RV1, ref: 'D-001' });
 const request = { caseId: CASE, operationId: 'note-replay', expected: { kind: 'absent' as const }, target: { kind: 'document' as const, anchor }, body: 'Durable note' };
 audit.state.down = true;
 await expect(work.addNote(request)).rejects.toMatchObject({ code: 'audit-unavailable', outcome: 'not-written' });
 expect(db.prepare('SELECT count(*) AS n FROM uw_note').get()).toEqual({ n: 0 });
 expect(db.prepare('SELECT count(*) AS n FROM uw_operation').get()).toEqual({ n: 0 });
 audit.state.down = false;
 const committed = await work.addNote(request);
 reader.state.withdrawn.add(RV1); reader.state.published = null;
 const replay = await make().addNote(request).then(r => r, e => ({ error: e.code }));
 expect(replay).toEqual(committed);
 expect([...audit.events.values()].filter(e => e.action === 'user-work.note-add')).toHaveLength(1);
});
