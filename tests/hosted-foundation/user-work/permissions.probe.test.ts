import { it, expect } from 'vitest';
import { fixture, CASE } from './helpers.ts';
it('requires explicit authority before an unassigned member can reserve a client-wide table', async () => {
 const { db, make } = fixture();
 const stranger = make('unassigned');
 await expect(stranger.notesFor({ caseId: CASE, target: null })).rejects.toMatchObject({ code: 'forbidden' });
 const definition = { name: 'costs', owner: 'unassigned', description: 'Reserved without a case grant', scope: 'case' as const, columns: [{ name: 'case_id', type: 'TEXT' as const, notNull: true }, { name: 'id', type: 'TEXT' as const }], primaryKey: ['id'] };
 const refusal = await stranger.defineTable({ definition }).then(() => null, e => e.code);
 console.log('unassigned definition result', refusal, db.prepare('SELECT name, owner FROM uw_table_definition').all());
 expect(refusal).toBe('forbidden');
});
