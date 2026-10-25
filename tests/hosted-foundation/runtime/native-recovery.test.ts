import {afterEach,describe,expect,it} from 'vitest';
import {nativeRecoveryRunner} from '../../../src/lib/server/runtime/hosted/recoveries.ts';
import {d1PublicationPublisher} from '../../../src/lib/publication/hosted/d1-publisher.ts';
import {id} from '../../../src/lib/server/runtime/ids.ts';
import {World,CLIENT,CASE,NOW} from '../audit-recovery/harness.ts';
const worlds:World[]=[];
afterEach(()=>{for(const w of worlds.splice(0))w.close();});
async function world(){const w=await new World().ready();worlds.push(w);return w;}
const budget={maxCases:2,maxCandidateIntentsPerCase:3,maxSignoffsPerCase:3,maxOperationsPerCase:3};
function runner(w:World,extra:Partial<Parameters<typeof nativeRecoveryRunner>[0]>={}){
 return nativeRecoveryRunner({db:w.db,clientId:CLIENT,budget,recovery:w.recovery(),
  receipts:d1PublicationPublisher({db:w.db,clientId:CLIENT,checkSession:async()=>{}}),...extra})!;
}
describe('native committed delivery runner (synthetic SQLite/D1 transport, not provider evidence)',()=>{
 it('settles candidates and signoffs, then proves applied operations after restart/revocation',async()=>{
  const w=await world();await w.candidate();
  expect((await runner(w).run()).candidateSettled).toBe(1);
  const so=await w.signoff();expect((await runner(w).run()).signoffSettled).toBe(1);
  const intent=await w.operation(so);expect((await w.apply(intent)).kind).toBe('applied');
  w.revoke();w.restart();
  const result=await runner(w).run();
  expect(result).toMatchObject({operationSettled:1,failures:0});
  expect((await w.ledger.operation({clientId:CLIENT,caseId:CASE,operationId:intent.operationId}))?.state).toBe('audited');
  expect((await runner(w).run()).operationSettled).toBe(0);
 });
 it('does not infer application from a pending operation or mutate the pointer',async()=>{
  const w=await world();await w.candidate();await runner(w).run();const so=await w.signoff();await runner(w).run();
  const intent=await w.operation(so);
  expect((await runner(w).run()).operationSettled).toBe(0);
  expect((await w.ledger.operation({clientId:CLIENT,caseId:CASE,operationId:intent.operationId}))?.state).toBe('pending');
  expect(w.db.rows('SELECT * FROM rs_publication')).toEqual([]);
 });
 it('leaves failed delivery pending and a later invocation recovers unchanged historical bytes',async()=>{
  const w=await world();await w.candidate();
  const recovery={...w.recovery(),candidate:{appendCommitted:async()=>{throw Error('injected delivery fault');}}};
  expect(await runner(w,{recovery}).run()).toMatchObject({candidateSettled:0,failures:1});
  expect((await w.repository.candidate({clientId:CLIENT,caseId:CASE,candidateId:'candidate-1'}))?.current).toBe(false);
  expect((await runner(w).run()).candidateSettled).toBe(1);
 });
 it('requires exact acknowledgement before candidate settlement',async()=>{
  const w=await world();await w.candidate();
  const recovery={...w.recovery(),candidate:{appendCommitted:async()=>({eventId:'wrong-ack'})}};
  expect(await runner(w,{recovery}).run()).toMatchObject({candidateSettled:0,failures:1});
  expect((await w.repository.candidate({clientId:CLIENT,caseId:CASE,candidateId:'candidate-1'}))?.current).toBe(false);
 });
 it('never revives invalidated signoff while delivering its original event',async()=>{
  const w=await world();await w.candidate();await runner(w).run();const so=await w.signoff();
  await w.ledger.invalidateSignoff({clientId:CLIENT,caseId:CASE,signoffId:so.signoffId,at:NOW,reason:'review changed'});
  expect((await runner(w).run()).signoffSettled).toBe(1);
  expect(await w.ledger.signoff({clientId:CLIENT,caseId:CASE,signoffId:so.signoffId})).toMatchObject({state:'audited',invalidatedAt:NOW});
 });
 it('paginates case discovery without caller-selected scope or unbounded counts',async()=>{
  const w=await world();const r=runner(w,{budget:{...budget,maxCases:1}});
  const first=await r.run();expect(first.scannedCases).toBe(1);expect(first.nextCaseCursor).toBe('case-a');
  const second=await r.run(first.nextCaseCursor);expect(second.scannedCases).toBe(1);expect(second.nextCaseCursor).toBeNull();
 });
 it('refuses crossed binding and invalid/missing deployment budgets',async()=>{
  const w=await world();
  await expect(runner(w,{clientId:id('client','foreign')}).run()).rejects.toBeDefined();
  for(const invalid of [null,{}, {...budget,maxCases:0},{...budget,maxCases:20},{...budget,maxCases:NaN}]){
   expect(nativeRecoveryRunner({db:w.db,clientId:CLIENT,budget:invalid,recovery:w.recovery(),receipts:{receipt:async()=>null}})).toBeNull();
  }
 });
});
