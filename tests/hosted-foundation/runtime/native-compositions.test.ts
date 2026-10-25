// Request routing/retention unit tests only; synthetic authority and storage collaborators are not live-boundary proof.
import {beforeAll,describe,expect,it,vi} from 'vitest';
import type {Identity} from '../../../src/lib/server/runtime/contracts.ts';
import {id} from '../../../src/lib/server/runtime/ids.ts';
import {bindNativeRequestCompositions,installNativeCompositions} from '../../../src/lib/server/runtime/hosted/compositions.ts';
import {intakeControllerFor} from '../../../src/lib/submissions/composition.ts';
import {operatorDownloadControllerFor} from '../../../src/lib/submissions/download/composition.ts';
import type {IntakePorts,SubmissionRepository} from '../../../src/lib/submissions/ports.ts';
import type {OperatorDownloadPorts} from '../../../src/lib/submissions/download/ports.ts';
beforeAll(()=>installNativeCompositions());
const unused=async():Promise<never>=>{throw Error('unexpected unit collaborator call');};
function fixture(client='client-a',kind:'client'|'staff'='client'){
 const clientId=id('client',client),list=vi.fn(async()=>[]),authorizeUpload=vi.fn(async()=>{}),authorize=vi.fn(async()=>{});
 const identity:Identity={kind:'verified',clientId,principal:{issuer:'https://synthetic.clerk.test',subject:'user_'+client,kind},sessionId:id('session','session_'+client),checkRevocation:async()=>{},authorize};
 const repository:SubmissionRepository={declare:unused,upload:unused,markStored:unused,reserveRevision:unused,commitRevision:unused,revision:unused,list};
 const intake:IntakePorts={clientId,budget:{maxMetadataBytes:4096,maxFileBytes:1024},authorizeUpload,originals:{declare:unused,put:unused,finalize:unused},repository,now:()=>new Date('2026-10-25T10:00:00.000Z')};
 const append=vi.fn(async(event:{eventId:string})=>({eventId:event.eventId}));
 const downloads:OperatorDownloadPorts={clientId,authorizeOperate:async()=>{},repository,assets:{metadata:unused,get:unused},audit:{append},now:intake.now};
 return{intake,downloads,identity,list,authorizeUpload,authorize,append};
}
const request=()=>new Request('https://client-a.test/cases/synthetic/submissions');
const input=(r:Request,identity:Identity)=>({request:r,url:new URL(r.url),params:{caseId:'synthetic'},identity});
describe('exact native request composition',()=>{
 it('keeps an unknown request unavailable after another request was admitted',async()=>{
  const f=fixture(),r=request(),clone=new Request(r);
  bindNativeRequestCompositions(r,{intake:f.intake,downloads:f.downloads});
  expect((await (await intakeControllerFor({request:r,platform:undefined})).list(input(r,f.identity))).status).toBe(200);
  expect((await (await intakeControllerFor({request:clone,platform:undefined})).list(input(clone,f.identity))).status).toBe(503);
  expect(f.list).toHaveBeenCalledOnce();expect(f.authorize).toHaveBeenCalledOnce();expect(f.authorizeUpload).not.toHaveBeenCalled();
 });
 it('separates overlapping requests with the same URL and does not reuse the latest binding',async()=>{
  const a=fixture(),b=fixture('client-b'),ra=request(),rb=request();
  bindNativeRequestCompositions(ra,{intake:a.intake,downloads:a.downloads});
  bindNativeRequestCompositions(rb,{intake:b.intake,downloads:b.downloads});
  const [one,two]=await Promise.all([(await intakeControllerFor({request:ra,platform:null})).list(input(ra,a.identity)),(await intakeControllerFor({request:rb,platform:null})).list(input(rb,b.identity))]);
  expect(one.status).toBe(200);expect(two.status).toBe(200);
  expect(a.list).toHaveBeenCalledOnce();expect(b.list).toHaveBeenCalledOnce();
  expect(a.list).toHaveBeenCalledWith({clientId:'client-a',caseId:'synthetic'});
  expect(b.list).toHaveBeenCalledWith({clientId:'client-b',caseId:'synthetic'});
 });
 it('copies the top-level mapping instead of retaining a caller-mutable scope object',async()=>{
  const a=fixture(),b=fixture('client-b'),r=request(),scope={intake:a.intake,downloads:a.downloads};
  bindNativeRequestCompositions(r,scope);scope.intake=b.intake;
  expect((await (await intakeControllerFor({request:r,platform:null})).list(input(r,a.identity))).status).toBe(200);
  expect(a.list).toHaveBeenCalledOnce();expect(b.list).not.toHaveBeenCalled();
 });
 it('refuses operator release without a real request execution context',async()=>{
  const f=fixture(),r=request();bindNativeRequestCompositions(r,{intake:f.intake,downloads:f.downloads});
  const controller=await operatorDownloadControllerFor({request:r,platform:{context:{}}});
  expect((await controller.list(input(r,f.identity))).status).toBe(503);
  expect(f.list).not.toHaveBeenCalled();expect(f.append).not.toHaveBeenCalled();
 });
 it('retains the terminal audit in this request context after response EOF',async()=>{
  const f=fixture('client-a','staff'),r=request(),work:Promise<void>[]=[];
  const context={waitUntil(job:Promise<void>){expect(this).toBe(context);work.push(job);}};
  bindNativeRequestCompositions(r,{intake:f.intake,downloads:f.downloads});
  const response=await (await operatorDownloadControllerFor({request:r,platform:{context}})).list(input(r,f.identity));
  expect(response.status).toBe(200);await response.arrayBuffer();await Promise.all(work);
  expect(work.length).toBeGreaterThan(0);expect(f.append.mock.calls.length).toBe(2);
 });
});
