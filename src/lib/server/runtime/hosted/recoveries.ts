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
 /** Diagnostic snapshot of the durable case cursor, never returned to clients or needed for continuation. */
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
type CursorKind='cases'|'candidate'|'signoff'|'operation';
type CursorRow={after_at:string;after_id:string|null;revision:number};
type Cursor=CursorRow&{caseId:string;kind:CursorKind};
type PageKey={key_at:string;key_id:string};
/** Private traversal state only: source rows and exact ACK/receipt checks remain the settlement authority. */
function cursorStore(db:PublicationD1Database,clientId:ClientId){
 async function read(caseId:string,kind:CursorKind):Promise<Cursor>{
  // A fresh first-primary read also resolves a write whose response/bookmark was lost.
  const row=await db.withSession('first-primary').prepare(`SELECT after_at,after_id,revision FROM native_audit_recovery_cursor WHERE client_id=? AND case_id=? AND kind='${kind}'`)
   .bind(clientId,caseId).first<CursorRow>();
  if(!row||typeof row.after_at!=='string'||(row.after_id!==null&&typeof row.after_id!=='string')||
   !Number.isSafeInteger(row.revision)||row.revision<0||row.revision>=Number.MAX_SAFE_INTEGER||
   (row.after_id===null&&row.after_at!==''))throw contractError('storage-unavailable');
  return {...row,caseId,kind};
 }
 return {
  async load(caseId:string,kind:CursorKind):Promise<Cursor>{
   try{
    await db.withSession('first-primary').prepare(`INSERT INTO native_audit_recovery_cursor (client_id,case_id,kind) VALUES (?,?,'${kind}') ON CONFLICT (client_id,case_id,kind) DO NOTHING`)
     .bind(clientId,caseId).run();
   }catch{ /* An insert can commit despite a lost answer; primary readback decides. No request DDL. */ }
   return read(caseId,kind);
  },
  async advance(cursor:Cursor,rows:PageKey[],limit:number):Promise<Cursor>{
   // Lookahead isn't attempted. A fully consumed page wraps, so failures and inserts behind the key are retried.
   const next=rows.length>limit?rows[limit-1]:null;
   try{
    await db.withSession('first-primary').prepare(`UPDATE native_audit_recovery_cursor SET after_at=?,after_id=?,revision=revision+1 WHERE client_id=? AND case_id=? AND kind='${cursor.kind}' AND revision=?`)
     .bind(next?.key_at??'',next?.key_id??null,clientId,cursor.caseId,cursor.revision).run();
   }catch{ /* Includes commit-with-lost-ACK. Never blindly retry a stale cursor write. */ }
   const saved=await read(cursor.caseId,cursor.kind);
   // A newer revision may be ours or another run's. Both already attempted their page; neither may be overwritten.
   // Revision increments even on wrap to prevent ABA when a slow run resumes after a complete traversal.
   if(saved.revision<=cursor.revision)throw contractError('storage-unavailable');
   return saved;
  },
 };
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
  // afterCaseId is a validated legacy hint only. Durable state, not caller-selected scope, drives discovery.
  const cursors=cursorStore(db,clientId),caseCursor=await cursors.load('','cases');
  const cases=await db.withSession('first-primary').prepare("SELECT '' AS key_at,case_id AS key_id FROM rs_case WHERE (? IS NULL OR case_id>?) ORDER BY case_id LIMIT ?")
   .bind(caseCursor.after_id,caseCursor.after_id,budget.maxCases+1).all<PageKey>();
  const page=cases.results.slice(0,budget.maxCases);
  const out:NativeRecoveryProgress={scannedCases:0,candidateSettled:0,signoffSettled:0,operationSettled:0,failures:0,nextCaseCursor:null};
  for(const row of page){
   if(!validCaseId(row.key_id))throw contractError('integrity');
   const scope={clientId,caseId:row.key_id as import('../contracts.ts').CaseId};
   out.scannedCases++;
   try{
    const cursor=await cursors.load(scope.caseId,'candidate');
    const rows=await db.withSession('first-primary').prepare(`SELECT '' AS key_at,i.candidate_id AS key_id FROM native_candidate_audit_intent i
     WHERE i.client_id=? AND i.case_id=? AND (? IS NULL OR i.candidate_id>?)
     AND NOT EXISTS (SELECT 1 FROM native_candidate_audit_settlement s WHERE s.client_id=i.client_id AND s.case_id=i.case_id AND s.candidate_id=i.candidate_id)
     ORDER BY i.candidate_id LIMIT ?`)
     .bind(clientId,scope.caseId,cursor.after_id,cursor.after_id,budget.maxCandidateIntentsPerCase+1).all<PageKey>();
    for(const item of rows.results.slice(0,budget.maxCandidateIntentsPerCase))try{
     // Hydrate individually: one malformed source must not abort the rest of the selected page.
     const repository=d1NativeCandidateRepository(db.withSession('first-primary'));
     const intent=await repository.auditIntent({...scope,candidateId:item.key_id});
     const ack=await recovery.candidate.appendCommitted(intent);
     if(ack.eventId!==intent.event.eventId)throw contractError('integrity');
     await repository.settleAudit(intent);out.candidateSettled++;
    }catch{out.failures++;}
    await cursors.advance(cursor,rows.results,budget.maxCandidateIntentsPerCase);
   }catch{out.failures++;}
   try{
    const cursor=await cursors.load(scope.caseId,'signoff');
    const rows=await db.withSession('first-primary').prepare(`SELECT signed_at AS key_at,signoff_id AS key_id FROM pub_signoff
     WHERE client_id=? AND case_id=? AND state='recorded' AND (? IS NULL OR (signed_at,signoff_id)>(?,?))
     ORDER BY signed_at,signoff_id LIMIT ?`)
     .bind(clientId,scope.caseId,cursor.after_id,cursor.after_at,cursor.after_id,budget.maxSignoffsPerCase+1).all<PageKey>();
    for(const item of rows.results.slice(0,budget.maxSignoffsPerCase))try{
     const ledger=d1PublicationLedger(db.withSession('first-primary'));
     const record=await ledger.signoff({...scope,signoffId:item.key_id});
     if(!record||record.state!=='recorded')continue;
     const ack=await recovery.publication.append(record.auditEvent);
     if(ack.eventId!==record.auditEvent.eventId)throw contractError('integrity');
     // Settlement retains invalidatedAt: delivering an old fact cannot revive approval.
     await ledger.settleSignoff({...scope,signoffId:record.signoffId});out.signoffSettled++;
    }catch{out.failures++;}
    await cursors.advance(cursor,rows.results,budget.maxSignoffsPerCase);
   }catch{out.failures++;}
   try{
    const cursor=await cursors.load(scope.caseId,'operation');
    const rows=await db.withSession('first-primary').prepare(`SELECT o.at AS key_at,o.operation_id AS key_id FROM pub_operation o
     JOIN pub_apply_receipt r ON r.client_id=o.client_id AND r.case_id=o.case_id AND r.operation_id=o.operation_id
     WHERE o.client_id=? AND o.case_id=? AND o.state IN ('pending','failed','applied') AND (? IS NULL OR (o.at,o.operation_id)>(?,?))
     ORDER BY o.at,o.operation_id LIMIT ?`)
     .bind(clientId,scope.caseId,cursor.after_id,cursor.after_at,cursor.after_id,budget.maxOperationsPerCase+1).all<PageKey>();
    for(const item of rows.results.slice(0,budget.maxOperationsPerCase))try{
     const key={...scope,operationId:item.key_id};
     const ledger=d1PublicationLedger(db.withSession('first-primary'));
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
    await cursors.advance(cursor,rows.results,budget.maxOperationsPerCase);
   }catch{out.failures++;}
  }
  out.nextCaseCursor=(await cursors.advance(caseCursor,cases.results,budget.maxCases)).after_id;
  return out;
 }});
}
