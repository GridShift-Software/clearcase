// SQL/component diagnostics with injected delivery/storage faults; not native acceptance evidence.
import {afterEach,describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {nativeRecoveryRunner} from '../../../src/lib/server/runtime/hosted/recoveries.ts';
import {d1PublicationPublisher} from '../../../src/lib/publication/hosted/d1-publisher.ts';
import type {PublicationD1Database} from '../../../src/lib/publication/hosted/d1-publisher.ts';
import type {PublicationD1Statement} from '../../../src/lib/publication/hosted/ledger.ts';
import {World,CLIENT,CASE,OTHER_CASE} from '../audit-recovery/harness.ts';
const migration='src/lib/server/runtime/hosted/migrations/0001_audit_recovery_cursor.sql';
const worlds:World[]=[];
afterEach(()=>{for(const w of worlds.splice(0))w.close();});
async function world(){const w=await new World().ready();worlds.push(w);w.db.sql.exec(readFileSync(migration,'utf8'));return w;}
const budget={maxCases:2,maxCandidateIntentsPerCase:1,maxSignoffsPerCase:1,maxOperationsPerCase:1};
function runner(w:World,extra:Partial<Parameters<typeof nativeRecoveryRunner>[0]>={}){
 return nativeRecoveryRunner({db:w.db,clientId:CLIENT,budget,recovery:w.recovery(),
  receipts:d1PublicationPublisher({db:w.db,clientId:CLIENT,checkSession:async()=>{}}),...extra})!;
}
function cursor(w:World,kind:string,caseId:string=CASE){
 return w.db.rows<{after_id:string|null;revision:number}>(
  'SELECT after_id,revision FROM native_audit_recovery_cursor WHERE client_id=? AND case_id=? AND kind=?',CLIENT,caseId,kind)[0];
}
// Only cursor writes are intercepted. All source reads, verification, ACKs and settlements use the real SQL components.
function intercept(w:World,write:(sql:string,commit:()=>Promise<unknown>)=>Promise<unknown>):PublicationD1Database{
 return {withSession(constraint){const primary=w.db.withSession(constraint);return {
  prepare(sql){
   const wrap=(s:PublicationD1Statement):PublicationD1Statement=>({
    bind:(...v)=>wrap(s.bind(...v)),first:<T>()=>s.first<T>(),all:<T>()=>s.all<T>(),
    run:()=>/^UPDATE native_audit_recovery_cursor/.test(sql)?write(sql,()=>s.run()):s.run(),
   });return wrap(primary.prepare(sql));
  },batch:(s)=>primary.batch(s),
 };}};
}
function barrier(){let release=()=>{};const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}

describe('durable bounded recovery continuation',()=>{
 it('advances past permanent candidate delivery failure, survives restart and retries the retained failure',async()=>{
  const w=await world();await w.candidate('1');await w.candidate('2');
  const attempts:string[]=[];
  const recovery=()=>{const trusted=w.recovery();return {...trusted,candidate:{appendCommitted:async(intent:Parameters<typeof trusted.candidate.appendCommitted>[0])=>{
   attempts.push(intent.candidateId);
   if(intent.candidateId==='candidate-1')throw Error('permanent candidate delivery fault');
   return trusted.candidate.appendCommitted(intent);
  }}};};
  expect(await runner(w,{recovery:recovery()}).run()).toMatchObject({candidateSettled:0,failures:1});
  w.restart(); // A new process/runner has no caller-supplied continuation.
  expect(await runner(w,{recovery:recovery()}).run()).toMatchObject({candidateSettled:1,failures:0});
  expect(await runner(w,{recovery:recovery()}).run()).toMatchObject({candidateSettled:0,failures:1});
  expect(attempts).toEqual(['candidate-1','candidate-2','candidate-1']);
  expect(w.db.rows('SELECT candidate_id FROM native_candidate_audit_settlement')).toEqual([{candidate_id:'candidate-2'}]);
  expect((await w.repository.candidate({clientId:CLIENT,caseId:CASE,candidateId:'candidate-1'}))?.current).toBe(false);
  expect(w.db.rows('SELECT * FROM rs_publication')).toEqual([]);
  expect(w.db.sessions.every(s=>s==='first-primary')).toBe(true);
 });
 it('isolates malformed candidate hydration within a page without settling or deleting the bad source',async()=>{
  const w=await world();const prepare=w.db.prepare.bind(w.db);
  // Seed a malformed original SQL source at INSERT time, without removing any immutability/integrity trigger.
  w.db.prepare=(sql)=>{
   const statement=prepare(sql);
   return sql.startsWith('INSERT INTO native_candidate_audit_intent')?{...statement,bind:(...values)=>{
    values[4]='{';values[5]='0'.repeat(64);return statement.bind(...values);
   }}:statement;
  };
  try{await expect(w.candidate('1')).rejects.toBeDefined();}finally{w.db.prepare=prepare;}
  await w.candidate('2');
  expect(await runner(w,{budget:{...budget,maxCandidateIntentsPerCase:2}}).run()).toMatchObject({candidateSettled:1,failures:1});
  w.restart();
  expect(await runner(w).run()).toMatchObject({candidateSettled:0,failures:1});
  expect(w.db.rows('SELECT candidate_id FROM native_candidate_audit_intent ORDER BY candidate_id')).toEqual([{candidate_id:'candidate-1'},{candidate_id:'candidate-2'}]);
  expect(w.db.rows('SELECT candidate_id FROM native_candidate_audit_settlement')).toEqual([{candidate_id:'candidate-2'}]);
 });
 it('advances past a malformed oldest signoff rejected by the real port and eventually reattempts it',async()=>{
  const w=await world();await w.candidate();await w.settleCandidates();
  const first=await w.signoff('candidate-1','signoff-operation-0001');
  // A malformed event can be recorded in the source ledger, but cannot be delivered by the trusted recovery port.
  const bad=await w.signoff('candidate-1','signoff-operation-0002',{...first.auditEvent,eventId:'malformed-signoff',
   object:{...first.auditEvent.object,id:'so-signoff-operation-0002'}});
  // Insert the valid later source with a lexically later ID; signed_at ties exercise the composite key.
  const good=await w.signoff('candidate-1','signoff-operation-0003');
  await w.ledger.settleSignoff({clientId:CLIENT,caseId:CASE,signoffId:first.signoffId});
  const attempts:string[]=[];
  const recovery=()=>{const trusted=w.recovery();return {...trusted,publication:{append:async(event:Parameters<typeof trusted.publication.append>[0])=>{
   attempts.push(event.object.id);return trusted.publication.append(event);
  }}};};
  expect(await runner(w,{recovery:recovery()}).run()).toMatchObject({signoffSettled:0,failures:1});
  w.restart();
  expect(await runner(w,{recovery:recovery()}).run()).toMatchObject({signoffSettled:1,failures:0});
  expect(await runner(w,{recovery:recovery()}).run()).toMatchObject({signoffSettled:0,failures:1});
  expect(attempts).toEqual([bad.signoffId,good.signoffId,bad.signoffId]);
  expect(await w.ledger.signoff({clientId:CLIENT,caseId:CASE,signoffId:bad.signoffId})).toMatchObject({state:'recorded'});
  expect(await w.ledger.signoff({clientId:CLIENT,caseId:CASE,signoffId:good.signoffId})).toMatchObject({state:'audited'});
 });
 it('advances past a mismatched oldest operation receipt without applying anything, then retries it',async()=>{
  const w=await world();await w.candidate();await w.settleCandidates();const so=await w.signoff();await runner(w).run();
  const bad=await w.operation(so,'publish-operation-0001');expect((await w.apply(bad)).kind).toBe('applied');
  const good=await w.operation(so,'publish-operation-0002','withdraw');expect((await w.apply(good)).kind).toBe('applied');
  const pointer=w.db.rows('SELECT * FROM rs_publication');const attempts:string[]=[];
  const receipts=()=>{const trusted=d1PublicationPublisher({db:w.db,clientId:CLIENT,checkSession:async()=>{}});return {receipt:async(key:Parameters<typeof trusted.receipt>[0])=>{
   attempts.push(key.operationId);const found=await trusted.receipt(key);
   return key.operationId===bad.operationId&&found?{intent:{...found.intent,requestSha256:'0'.repeat(64)}}:found;
  }};};
  expect(await runner(w,{receipts:receipts()}).run()).toMatchObject({operationSettled:0,failures:1});
  w.restart();
  expect(await runner(w,{receipts:receipts()}).run()).toMatchObject({operationSettled:1,failures:0});
  expect(await runner(w,{receipts:receipts()}).run()).toMatchObject({operationSettled:0,failures:1});
  expect(attempts).toEqual([bad.operationId,good.operationId,bad.operationId]);
  expect(await w.ledger.operation({clientId:CLIENT,caseId:CASE,operationId:bad.operationId})).toMatchObject({state:'pending'});
  expect(await w.ledger.operation({clientId:CLIENT,caseId:CASE,operationId:good.operationId})).toMatchObject({state:'audited'});
  expect(w.db.rows('SELECT * FROM rs_publication')).toEqual(pointer);
 });
 it('persists deployment-wide case paging, wraps and discovers cases inserted behind the cursor',async()=>{
  const w=await world();w.db.insert('rs_case',{case_id:'case-c'});w.db.insert('rs_case',{case_id:'case-d'});
  const next=async()=>{w.restart();return runner(w,{budget:{...budget,maxCases:1}}).run();};
  const outputs=[];
  for(let n=0;n<4;n++)outputs.push(await next());
  expect(outputs.map(o=>o.scannedCases)).toEqual([1,1,1,1]);
  expect(outputs.map(o=>o.nextCaseCursor)).toEqual([CASE,OTHER_CASE,'case-c',null]);
  expect(cursor(w,'cases','').after_id).toBeNull();
  w.db.insert('rs_case',{case_id:'case-0'});
  expect(await next()).toMatchObject({scannedCases:1,nextCaseCursor:'case-0'});
 });
 it('still requires exact signoff and operation ACKs on retries and never changes their publication pointer',async()=>{
  const w=await world();await w.candidate();await w.settleCandidates();const so=await w.signoff();
  const wrong={...w.recovery(),publication:{append:async()=>({eventId:'wrong-ack'})}};
  expect(await runner(w,{recovery:wrong}).run()).toMatchObject({signoffSettled:0,failures:1});
  expect(await w.ledger.signoff({clientId:CLIENT,caseId:CASE,signoffId:so.signoffId})).toMatchObject({state:'recorded'});
  expect(await runner(w).run()).toMatchObject({signoffSettled:1,failures:0});
  const op=await w.operation(so);expect((await w.apply(op)).kind).toBe('applied');
  const pointer=w.db.rows('SELECT * FROM rs_publication');
  expect(await runner(w,{recovery:wrong}).run()).toMatchObject({operationSettled:0,failures:1});
  expect(await w.ledger.operation({clientId:CLIENT,caseId:CASE,operationId:op.operationId})).toMatchObject({state:'pending'});
  expect(await runner(w).run()).toMatchObject({operationSettled:1,failures:0});
  expect(w.db.rows('SELECT * FROM rs_publication')).toEqual(pointer);
 });
 it('enforces per-kind and global attempt budgets even with lookahead and failed deliveries',async()=>{
  const w=await world();await w.candidate('1');await w.candidate('2');await w.candidate('3');await w.settleCandidates();
  const so=await w.signoff('candidate-1','signoff-operation-0001');
  await w.signoff('candidate-2','signoff-operation-0002');await w.signoff('candidate-3','signoff-operation-0003');
  await w.ledger.settleSignoff({clientId:CLIENT,caseId:CASE,signoffId:so.signoffId});
  const op1=await w.operation(so,'publish-operation-0001');expect((await w.apply(op1)).kind).toBe('applied');
  const op2=await w.operation(so,'publish-operation-0002','withdraw');expect((await w.apply(op2)).kind).toBe('applied');
  await w.candidate('4');await w.candidate('5');await w.candidate('6');
  const attempts={candidate:0,signoff:0,operation:0};
  const recovery={candidate:{appendCommitted:async()=>{attempts.candidate++;throw Error('permanent');}},
   publication:{append:async(event:Parameters<ReturnType<World['recovery']>['publication']['append']>[0])=>{
    if(event.action==='publication.signoff')attempts.signoff++;else attempts.operation++;
    throw Error('permanent');
   }}};
  const limited={maxCases:1,maxCandidateIntentsPerCase:2,maxSignoffsPerCase:1,maxOperationsPerCase:1};
  expect(await runner(w,{budget:limited,recovery}).run()).toMatchObject({scannedCases:1,failures:4,candidateSettled:0,signoffSettled:0,operationSettled:0});
  expect(attempts).toEqual({candidate:2,signoff:1,operation:1});
  expect(Object.values(attempts).reduce((sum,n)=>sum+n,0)).toBe(4);
 });
 it.each(['before','after'])('handles lost case cursor acknowledgement %s commit without a caller cursor',async(when)=>{
  const w=await world();let faulted=false;
  const db=intercept(w,async(sql,commit)=>{
   if(!faulted&&sql.includes("kind='cases'")){faulted=true;if(when==='after')await commit();throw Error('lost case cursor answer');}
   return commit();
  });
  const invoke=runner(w,{db,budget:{...budget,maxCases:1}}).run();
  if(when==='before')await expect(invoke).rejects.toBeDefined();
  else expect(await invoke).toMatchObject({scannedCases:1,nextCaseCursor:CASE});
  expect(cursor(w,'cases','')).toMatchObject({after_id:when==='after'?CASE:null,revision:when==='after'?1:0});
  w.restart();
  expect(await runner(w,{budget:{...budget,maxCases:1}}).run()).toMatchObject({scannedCases:1,nextCaseCursor:when==='after'?null:CASE});
 });
 it('ignores caller continuation hints, requires installed schema and keeps migration installation idempotent',async()=>{
  const w=await world();
  expect(await runner(w,{budget:{...budget,maxCases:1}}).run('case-z')).toMatchObject({nextCaseCursor:CASE});
  const saved=cursor(w,'cases','');w.db.sql.exec(readFileSync(migration,'utf8'));
  expect(cursor(w,'cases','')).toEqual(saved);
  w.db.sql.exec('DROP TABLE native_audit_recovery_cursor');
  await expect(runner(w).run()).rejects.toBeDefined();
  expect(w.db.rows('SELECT * FROM native_candidate_audit_settlement')).toEqual([]);
 });
 it.each(['cases','candidate','signoff','operation'])('does not let overlapping stale %s cursors regress after a wrap (ABA)',async(kind)=>{
  const w=await world();await w.candidate('1');await w.candidate('2');await w.settleCandidates();
  const so1=await w.signoff('candidate-1','signoff-operation-0001');
  await w.signoff('candidate-2','signoff-operation-0002');
  // Two receipt-bearing sources, left pending for delivery.
  await w.ledger.settleSignoff({clientId:CLIENT,caseId:CASE,signoffId:so1.signoffId});
  const op1=await w.operation(so1,'publish-operation-0001');expect((await w.apply(op1)).kind).toBe('applied');
  const op2=await w.operation(so1,'publish-operation-0002','withdraw');expect((await w.apply(op2)).kind).toBe('applied');
  // For the candidate variant add two pending candidates after setup settled the first two.
  await w.candidate('3');await w.candidate('4');
  const recovery={candidate:{appendCommitted:async()=>{throw Error('hold pending');}},publication:{append:async()=>{throw Error('hold pending');}}};
  const paused=barrier(),resume=barrier();let held=false;
  const db=intercept(w,async(sql,commit)=>{
   if(!held&&sql.includes(`kind='${kind}'`)){held=true;paused.release();await resume.promise;}
   return commit();
  });
  const options={budget:{...budget,maxCases:1},recovery};
  const stale=runner(w,{...options,db}).run();await paused.promise;
  try{
   for(let n=0;n<4;n++)await runner(w,options).run();
   const before=cursor(w,kind,kind==='cases'?'':CASE);
   expect(before.revision).toBeGreaterThanOrEqual(2);
   resume.release();await stale;
   expect(cursor(w,kind,kind==='cases'?'':CASE)).toEqual(before);
  }finally{resume.release();await stale;}
 });
 it.each(['before','after'])('handles a lost cursor acknowledgement %s commit with primary readback',async(when)=>{
  const w=await world();await w.candidate('1');await w.candidate('2');let faulted=false;
  const db=intercept(w,async(sql,commit)=>{
   if(!faulted&&sql.includes("kind='candidate'")){faulted=true;if(when==='after')await commit();throw Error('lost cursor answer');}
   return commit();
  });
  const recovery={...w.recovery(),candidate:{appendCommitted:async()=>{throw Error('permanent');}}};
  await runner(w,{db,recovery}).run();
  expect(cursor(w,'candidate')).toMatchObject({after_id:when==='after'?'candidate-1':null,revision:when==='after'?1:0});
  w.restart();
  const attempts:string[]=[];
  const trusted=w.recovery();const traced={...trusted,candidate:{appendCommitted:async(intent:Parameters<typeof trusted.candidate.appendCommitted>[0])=>{
   attempts.push(intent.candidateId);throw Error('permanent');
  }}};
  await runner(w,{recovery:traced}).run();
  expect(attempts).toEqual([when==='after'?'candidate-2':'candidate-1']);
  expect(w.db.rows('SELECT * FROM native_candidate_audit_settlement')).toEqual([]);
 });
});
