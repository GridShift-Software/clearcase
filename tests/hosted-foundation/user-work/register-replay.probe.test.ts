import { it, expect } from 'vitest';
import { fixture, CASE, RV1, written } from './helpers.ts';
import { appendOnly } from './world.ts';
import { createD1UserWork } from '../../../src/lib/user-work/hosted/index.ts';
import { CLIENT, d1, LIMITS } from './world.ts';
it('replays register replacement from its stable request after the anchored row is deleted', async () => {
 // The append-and-replay path: a sink without atomic audit leaves the replace durable and unacknowledged.
 const { auth, audit, db, reader } = fixture();
 const make = () => createD1UserWork({ db: d1(db), config: { clientId: CLIENT, limits: LIMITS }, identity: auth.identity('editor'), audit: appendOnly(audit.sink), store: reader.reader, now: () => new Date('2026-10-25T00:00:00.000Z') });
 const work = make();
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
