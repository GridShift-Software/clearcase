import { it, expect } from 'vitest';
import { fixture, CASE, RV1 } from './helpers.ts';
it('acknowledges a durable note on same-operation retry after its results context is withdrawn', async () => {
 const { db, audit, reader, make } = fixture(); const work = make();
 const anchor = await work.anchorFor({ caseId: CASE, resultsVersion: RV1, ref: 'D-001' });
 const request = { caseId: CASE, operationId: 'note-replay', expected: { kind: 'absent' as const }, target: { kind: 'document' as const, anchor }, body: 'Durable note' };
 audit.state.down = true;
 await expect(work.addNote(request)).rejects.toMatchObject({ code: 'audit-unavailable', outcome: 'written-unaudited' });
 audit.state.down = false; reader.state.withdrawn.add(RV1); reader.state.published = null;
 const replay = await make().addNote(request).then(r => r, e => ({ error: e.code }));
 console.log('withdrawal replay', replay, 'durable', db.prepare('SELECT audited_at FROM uw_operation').all());
 expect(replay).toMatchObject({ kind: 'written' });
 expect([...audit.events.values()].filter(e => e.action === 'user-work.note-add')).toHaveLength(1);
});
