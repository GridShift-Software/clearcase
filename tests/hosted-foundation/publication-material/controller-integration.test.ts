// Real material/validator/SSR/ledger/atomic SQL/controller composition with explicit identity/audit/renderer doubles.
// NOT Clerk, native D1, SDK canvas, hosted HTTP or human approval acceptance.
import {afterEach,describe,expect,it} from 'vitest';
import {createNativePublication} from '../../../src/lib/publication/hosted/controller.ts';
import {d1PublicationPublisher} from '../../../src/lib/publication/hosted/d1-publisher.ts';
import {d1PublicationLedger} from '../../../src/lib/publication/hosted/ledger.ts';
import {createPublicationMaterialReader} from '../../../src/lib/server/runtime/hosted/publication-material.ts';
import type {CandidateSnapshot,NativePublicationPorts} from '../../../src/lib/publication/hosted/ports.ts';
import {CASE,CLIENT,NOW,world as setup} from './fixture.ts';
const worlds:Awaited<ReturnType<typeof setup>>[]=[];
afterEach(()=>{for(const w of worlds.splice(0))w.close();});
const ORIGIN='https://synthetic.invalid',SIGN='controller-signoff-0001',PUB='controller-publish-0001';
async function configured(){
 const w=await setup({textStatus:'none'});worlds.push(w);
 const who=w.options.identity;if(who.kind!=='verified')throw Error('synthetic fixture');
 w.db.exec(`INSERT INTO tenant_case_grants(grant_id,client_id,scope,case_id,issuer,subject,principal_kind,role,slot,state,
  expires_at,version,created_operation_id,request,created_by_issuer,created_by_subject,created_at)
  VALUES('controller-publisher',?,'case',?,?,?,'staff','publisher','publisher','active',NULL,1,'grant-op','{}',?,?,?)`,
  CLIENT,CASE,who.principal.issuer,who.principal.subject,who.principal.issuer,who.principal.subject,NOW);
 const ledger=d1PublicationLedger(w.db);
 const ports:NativePublicationPorts={clientId:CLIENT,candidates:createPublicationMaterialReader(w.options),
  authorize:async(a)=>{expect(a.capability).toBe('publish');expect(a.principal).toEqual(who.principal);await who.checkRevocation();},
  publisher:d1PublicationPublisher({db:w.db,clientId:CLIENT,checkSession:async()=>who.checkRevocation()}),
  ledger,audit:w.options.audit,now:w.options.now};
 const controller=createNativePublication(ports);
 const snapshot=await ports.candidates!.read(w.scope) as CandidateSnapshot;
 function request(route:string,body:unknown){
  const url=new URL('/operator/publication/'+CASE+'/'+route,ORIGIN);
  return {request:new Request(url,{method:'POST',headers:{origin:ORIGIN,'content-type':'application/json'},body:JSON.stringify(body)}),
   url,params:{caseId:CASE},identity:who};
 }
 const pin=snapshot.link.candidate;
 const body={operationId:SIGN,candidateId:pin.candidateId,
  identity:{linkId:snapshot.link.linkId,submissionRevisionId:snapshot.link.submissionRevisionId,
   submissionManifestSha256:snapshot.link.submissionManifestSha256,resultsVersion:pin.resultsVersion,
   manifestSha256:pin.manifestSha256,packageInputRevisionId:pin.packageInputRevisionId,
   diagnosticsSha256:snapshot.validation.diagnosticsSha256,validatorVersion:snapshot.validation.validatorVersion,
   snapshotRevision:snapshot.snapshotRevision},
  acknowledgements:snapshot.validation.warningFingerprints.map(fingerprint=>({fingerprint,reason:'Reviewed synthetic diagnostic'})),
  selfApproval:snapshot.preparedBy.issuer===who.principal.issuer&&snapshot.preparedBy.subject===who.principal.subject};
 return {w,who,controller,ledger,ports,body,request};
}
describe('genuine material and atomic publication controller compatibility',()=>{
 it('signs exact canonical diagnostics and publishes/replays only the durable same-operation receipt',async()=>{
  const {w,controller,body,request,ledger}=await configured();
  expect(body.identity.diagnosticsSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  const signed=await controller.signOff(request('signoffs',body));expect(signed.status).toBe(201);
  const publish={operationId:PUB,signoffId:'so-'+SIGN,expected:{kind:'none'}};
  const first=await controller.publish(request('publish',publish));expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({operationId:PUB,publication:{kind:'published',resultsVersion:w.rv}});
  const replay=await controller.publish(request('publish',publish));expect(replay.status).toBe(200);
  expect(w.db.rows('SELECT * FROM pub_apply_receipt')).toHaveLength(1);
  expect((await ledger.operation({clientId:CLIENT,caseId:CASE,operationId:PUB}))?.state).toBe('audited');
  w.state.session=false;
  expect((await controller.publish(request('publish',publish))).status).toBe(401);
  expect(w.db.rows('SELECT * FROM pub_apply_receipt')).toHaveLength(1);
 });
 it('holds genuine bytes with no source-owned renderer instead of approving byte presence',async()=>{
  const {w,ports,body,request}=await configured();
  w.options.renderChecker=null;
  const controller=createNativePublication({...ports,candidates:createPublicationMaterialReader(w.options)});
  const response=await controller.signOff(request('signoffs',body));
  expect(response.status).toBe(422);expect(await response.json()).toMatchObject({code:'preview-not-ready'});
  expect(w.db.rows('SELECT * FROM pub_signoff')).toHaveLength(0);
  expect(w.db.rows('SELECT * FROM pub_apply_receipt')).toHaveLength(0);
 });
});
