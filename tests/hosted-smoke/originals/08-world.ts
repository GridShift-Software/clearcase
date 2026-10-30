import { MIGRATION, MANIFEST, d1 } from '../../hosted-foundation/provisioning/world';
import { createCaseAuthorizer } from '../../../src/lib/tenancy/authorizer';
import { d1GrantRepository } from '../../../src/lib/tenancy/d1-grants';
import { d1CaseDirectory } from '../../../src/lib/tenancy/case-directory';
import { resolveExactDeployment, validateClientManifest } from '../../../src/lib/tenancy/manifest';
import { createCloudResults, type StorageEvent } from '../../../src/lib/results/hosted';
import type { Identity } from '../../../src/lib/server/runtime/contracts';
import { deployment, grantedIdentity, ids, BUDGETS } from '../../hosted-foundation/storage/fixture';
import { counters, countedD1, countedR2, routeEvent } from '../../hosted-foundation/budget/harness';
import { serveAsset } from '../../../src/lib/viewer/hosted/route';
import { load } from '../../../deploy/client/routes/cases/[caseId]/originals/[assetId]/view/+page.server';
export async function originalWorld({ allowLegacyBuffer = false } = {}) {
 const dep = deployment('client-a',['case-a','case-b']), c = counters();
 const hash = 'a'.repeat(64), key = `orig/${hash}`;
 dep.bucket.setRaw(key,new Uint8Array([1,2,3,4]));
 const etag = (await dep.bucket.head(key))!.etag;
 dep.db.exec('INSERT INTO rs_original (sha256,size,object_key,etag,media_family) VALUES (?,?,?,?,?)',hash,4,key,etag,'pdf');
 dep.db.exec('INSERT INTO rs_case_original (case_id,asset_id,sha256,filename,media_type,finalized_at) VALUES (?,?,?,?,?,?)','case-a','asset-a',hash,'synthetic.pdf','application/pdf','2026-10-28T00:00:00Z');
 const db = countedD1(dep.db,c);
 // MemoryR2 predates the streaming API: retain its storage and implement R2's conditional range response.
 const bucket = countedR2({...dep.bucket, head:dep.bucket.head.bind(dep.bucket),put:dep.bucket.put.bind(dep.bucket), async get(k:string, o?: {range?:{offset:number;length:number};onlyIf?:{etagMatches:string}}) {
  const object = await dep.bucket.get(k);
  if (!object || !k.startsWith('orig/')) return object;
  if (o?.onlyIf && o.onlyIf.etagMatches !== object.etag) return {...object};
  const bytes = new Uint8Array(await object.arrayBuffer());
  const body = o?.range ? bytes.slice(o.range.offset,o.range.offset+o.range.length) : bytes;
  return {...object, arrayBuffer:async()=>{if (allowLegacyBuffer && !o?.onlyIf) return bytes.buffer; throw new Error('object buffering forbidden');},body:new ReadableStream<Uint8Array>({start(s){s.enqueue(body);s.close();}})};
 }},c);
 const events: StorageEvent[] = [], pending: Promise<unknown>[] = [];
 const base = grantedIdentity(ids.clientA,['case-a']).identity;
 if(base.kind!=='verified') throw new Error('identity');
 dep.db.sqlite.exec(MIGRATION);
 const {clientIssuer: _issuer,...tuple}=MANIFEST.clients[0];
 const resource = resolveExactDeployment(validateClientManifest(MANIFEST),tuple);
 const identity: Identity = {...base,principal:{...base.principal,issuer:resource.clientIssuer}, async authorize(a) {
  const nativeDb=countedD1(d1(dep.db.sqlite),c);
  const auth=createCaseAuthorizer({deployment:resource,grants:d1GrantRepository(nativeDb),cases:d1CaseDirectory({db:nativeDb,deployment:resource}),audit:{append:async e=>({eventId:e.eventId})},now:()=>new Date('2026-10-28T00:00:00Z')});
  await auth.authorizeCase({...a,principal:this.principal!,sessionId:this.sessionId!});
 }};
 for(const caseId of ['case-a','case-b']) dep.db.exec(`INSERT INTO tenant_case_grants (grant_id,client_id,scope,case_id,issuer,subject,principal_kind,role,slot,state,version,created_operation_id,request,created_by_issuer,created_by_subject,created_at) VALUES (?,?,'case',?,?,'user-a','client','viewer','content','active',1,?,'[]','seed','seed','2026-10-28T00:00:00.000Z')`,caseId,ids.clientA,caseId,resource.clientIssuer,caseId);

 const locals = (who:Identity = identity) => {
  const results = createCloudResults({bindings:{db,bucket},clientId:ids.clientA,budgets:BUDGETS,identity:who,record:async e=>{events.push(e);},stateRevision:async()=>{throw new Error('unused');}});
  return {identity:who,...results};
 };
 const event = (who:Identity, path:string, params={caseId:'case-a',assetId:'asset-a'}, headers={}) => routeEvent(locals(who) as never,params,`https://example.invalid${path}`,{headers});
 return {dep,c,identity,events,pending,locals,event,key,
  view:(who=identity,assetId='asset-a')=>load(event(who,'/cases/case-a/originals/'+assetId+'/view',{caseId:'case-a',assetId})),
  get:(who:Identity,path:string,params={caseId:'case-a',assetId:'asset-a'},headers={})=>serveAsset(event(who,path,params,headers),'original','GET')};
}
