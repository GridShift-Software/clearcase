import { it, expect } from 'vitest';
import { fixture, CASE, RV1, written } from './helpers.ts';
it('replays register replacement from its stable request after the anchored row is deleted', async () => {
 const { make, audit, db } = fixture(); const work = make();
 const anchor = await work.anchorFor({ caseId: CASE, resultsVersion: RV1, ref: 'D-001' });
 const first = written(await work.putRow({ caseId: CASE, store: 'time', rowId: 'r1', fields: { hours: 1 }, anchor, expected: { kind: 'absent' }, operationId: 'create' }));
 const request = { rowId: 'r1', fields: { hours: 2 }, expected: first.version, operationId: 'replace' };
 const registers = work.registers.open({ caseId: CASE, store: 'time' });
 audit.state.down = true;
 await expect(registers.replace(request)).rejects.toMatchObject({ code: 'audit-unavailable', outcome: 'written-unaudited' });
 audit.state.down = false;
 const current = (await registers.rows())[0];
 written(await work.deleteRow({ caseId: CASE, store: 'time', rowId: 'r1', expected: { kind: 'match', version: current.version }, operationId: 'delete' }));
 const replay = await make().registers.open({ caseId: CASE, store: 'time' }).replace(request).then(r => r, e => ({ error: e.code }));
 console.log('replace replay', replay, db.prepare("SELECT operation_id, audited_at FROM uw_operation").all());
 expect(replay).toMatchObject({ kind: 'written' });
 expect(await registers.rows()).toHaveLength(0);
});
