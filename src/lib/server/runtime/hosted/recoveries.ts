import {canonicalJson} from '../../../case-package/canonical.ts';
import type {AuditSink, ClientId} from '../contracts.ts';
import {contractError} from '../errors.ts';
import {validCaseId} from '../audit-identifiers.ts';
import {d1NativeCandidateRepository} from '../../../results-review/native/repository.ts';
import type {CandidateAuditRecovery} from '../../../results-review/native/ports.ts';
import {d1PublicationLedger} from '../../../publication/hosted/ledger.ts';
import type {PublicationD1Database} from '../../../publication/hosted/d1-publisher.ts';
import type {StoragePublisher} from '../../../publication/hosted/ports.ts';

export interface NativeRecoveryBudget {
 maxCases:number;
 maxCandidateIntentsPerCase:number;
 maxSignoffsPerCase:number;
 maxOperationsPerCase:number;
}
export interface NativeRecoveryProgress {
 scannedCases:number;
 candidateSettled:number;
 signoffSettled:number;
 operationSettled:number;
 failures:number;
 /** Internal scheduler cursor; null wraps the next invocation to the first case. Never returned to clients. */
 nextCaseCursor:string|null;
}
function budgetOf(value:unknown):Readonly<NativeRecoveryBudget>|null {
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const v=value as Record<string,unknown>;
 const keys=['maxCases','maxCandidateIntentsPerCase','maxSignoffsPerCase','maxOperationsPerCase'] as const;
 if(keys.some(k=>!Number.isSafeInteger(v[k])||Number(v[k])<1||Number(v[k])>20))return null;
 const b=Object.fromEntries(keys.map(k=>[k,Number(v[k])])) as unknown as NativeRecoveryBudget;
 if(b.maxCases*(b.maxCandidateIntentsPerCase+b.maxSignoffsPerCase+b.maxOperationsPerCase)>100)return null;
 return Object.freeze(b);
}
/**
 * Trusted scheduler/queue work, independent of any uploader/reviewer's identity or selected case.
 * Source-owned recovery ports MUST verify committed historical envelopes; acknowledgements precede settlement.
 * This runner never calls publish/withdraw, creates an approval, uses a request audit sink, or infers application
 * from pointer equality. Installing a periodic scheduler is a separate parent/deployment hook.
 */
export function nativeRecoveryRunner(a:{
 db:PublicationD1Database;clientId:ClientId;budget:unknown;
 recovery:Readonly<{candidate:CandidateAuditRecovery;publication:Readonly<AuditSink>}>;
 receipts:Pick<StoragePublisher,'receipt'>;
}):{run(afterCaseId?:string|null):Promise<NativeRecoveryProgress>}|null {
 const budget=budgetOf(a.budget);
 if(!budget||typeof a.db?.withSession!=='function'||typeof a.recovery?.candidate?.appendCommitted!=='function'||
  typeof a.recovery?.publication?.append!=='function'||typeof a.receipts?.receipt!=='function'||
  typeof a.clientId!=='string'||!/^[a-z0-9][a-z0-9-]{0,62}$/.test(a.clientId))return null;
 const {db,clientId,recovery,receipts}=a;
 return Object.freeze({async run(afterCaseId:string|null=null):Promise<NativeRecoveryProgress>{
  if(afterCaseId!==null&&!validCaseId(afterCaseId))throw new TypeError('invalid internal case cursor');
  const primary=db.withSession('first-primary');
  const binding=await primary.prepare("SELECT client_id FROM rs_storage_identity WHERE singleton=1 AND client_id=? AND layout='clearcase.rs/1'").bind(clientId).first();
  if(!binding)throw contractError('storage-unavailable');
  const cases=await primary.prepare('SELECT case_id FROM rs_case WHERE (? IS NULL OR case_id>?) ORDER BY case_id LIMIT ?')
   .bind(afterCaseId,afterCaseId,budget.maxCases+1).all<{case_id:string}>();
  const page=cases.results.slice(0,budget.maxCases);
  const out:NativeRecoveryProgress={scannedCases:0,candidateSettled:0,signoffSettled:0,operationSettled:0,failures:0,
   nextCaseCursor:cases.results.length>budget.maxCases?page.at(-1)!.case_id:null};
  const repository=d1NativeCandidateRepository(primary),ledger=d1PublicationLedger(primary);
  for(const row of page){
   if(!validCaseId(row.case_id))throw contractError('integrity');
   const scope={clientId,caseId:row.case_id as import('../contracts.ts').CaseId};
   out.scannedCases++;
   try{
    const intents=await repository.pendingAudits({...scope,limit:budget.maxCandidateIntentsPerCase});
    for(const intent of intents)try{
     const ack=await recovery.candidate.appendCommitted(intent);
     if(ack.eventId!==intent.event.eventId)throw contractError('integrity');
     await repository.settleAudit(intent);out.candidateSettled++;
    }catch{out.failures++;}
   }catch{out.failures++;}
   try{
    const rows=await primary.prepare("SELECT signoff_id FROM pub_signoff WHERE client_id=? AND case_id=? AND state='recorded' ORDER BY signed_at,signoff_id LIMIT ?")
     .bind(clientId,scope.caseId,budget.maxSignoffsPerCase).all<{signoff_id:string}>();
    for(const item of rows.results)try{
     const record=await ledger.signoff({...scope,signoffId:item.signoff_id});
     if(!record||record.state!=='recorded')continue;
     const ack=await recovery.publication.append(record.auditEvent);
     if(ack.eventId!==record.auditEvent.eventId)throw contractError('integrity');
     // Settlement retains invalidatedAt: delivering an old fact cannot revive approval.
     await ledger.settleSignoff({...scope,signoffId:record.signoffId});out.signoffSettled++;
    }catch{out.failures++;}
   }catch{out.failures++;}
   try{
    const rows=await primary.prepare("SELECT o.operation_id FROM pub_operation o JOIN pub_apply_receipt r ON r.client_id=o.client_id AND r.case_id=o.case_id AND r.operation_id=o.operation_id WHERE o.client_id=? AND o.case_id=? AND o.state IN ('pending','failed','applied') ORDER BY o.at,o.operation_id LIMIT ?")
     .bind(clientId,scope.caseId,budget.maxOperationsPerCase).all<{operation_id:string}>();
    for(const item of rows.results)try{
     const key={...scope,operationId:item.operation_id};
     const record=await ledger.operation(key);
     if(!record||!['pending','failed','applied'].includes(record.state))continue;
     const receipt=await receipts.receipt(key);
     const {state:_state,reason:_reason,...intent}=record;
     if(!receipt||canonicalJson(receipt.intent)!==canonicalJson(intent))throw contractError('integrity');
     // The recovery port independently verifies this exact receipt/source again before delivery.
     const ack=await recovery.publication.append(record.auditEvent);
     if(ack.eventId!==record.auditEvent.eventId)throw contractError('integrity');
     if(record.state!=='applied')await ledger.finishOperation({...key,state:'applied',reason:null});
     await ledger.settleOperation(key);out.operationSettled++;
    }catch{out.failures++;}
   }catch{out.failures++;}
  }
  return out;
 }});
}
