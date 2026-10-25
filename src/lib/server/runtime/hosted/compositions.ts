import {setIntakeComposition} from '../../../submissions/composition.ts';
import type {IntakePorts} from '../../../submissions/ports.ts';
import {setOperatorDownloadComposition} from '../../../submissions/download/composition.ts';
import type {OperatorDownloadPorts} from '../../../submissions/download/ports.ts';
import {setNativeImportComposition} from '../../../results-review/native/composition.ts';
import type {NativeImportPorts} from '../../../results-review/native/ports.ts';
import {setPublicationComposition} from '../../../publication/hosted/composition.ts';
import {setReadinessComposition,type PublicationReadinessPorts} from '../../../publication/hosted/readiness.ts';
import {setRecoveryComposition,type NativeRecoveryBinding} from '../../../recovery/hosted/composition.ts';

export interface NativeRequestCompositions {
 readonly intake: IntakePorts | null;
 readonly downloads: OperatorDownloadPorts | null;
 readonly imports?:NativeImportPorts|null;
 readonly publication?:PublicationReadinessPorts|null;
 /** Trusted parent only: this request's own source options (the receiving target is `source.target`) plus its configured app origin. Absent means the recovery routes answer 503. */
 readonly recovery?:NativeRecoveryBinding|null;
}
// Object identity, not path, cookie, session id or the last request. Unknown requests always fail closed.
const requests=new WeakMap<Request,NativeRequestCompositions>();
let installed=false;
export function bindNativeRequestCompositions(request:Request,ports:NativeRequestCompositions):void {
 requests.set(request,Object.freeze({...ports}));
}
function executionContext(platform:unknown):{waitUntil(work:Promise<void>):void}|null {
 if(typeof platform!=='object'||platform===null)return null;
 const context=(platform as {context?:unknown}).context;
 if(typeof context!=='object'||context===null||typeof (context as {waitUntil?:unknown}).waitUntil!=='function')return null;
 return context as {waitUntil(work:Promise<void>):void};
}
/** Isolate setup only. Every resolution still requires this exact request and its actual execution context. */
export function installNativeCompositions():void {
 if(installed)return;installed=true;
 setIntakeComposition(({request})=>requests.get(request)?.intake??null);
 setNativeImportComposition(({request})=>requests.get(request)?.imports??null);
 setPublicationComposition(({request})=>requests.get(request)?.publication??null);
 setReadinessComposition(({request})=>requests.get(request)?.publication??null);
 setRecoveryComposition(({request})=>requests.get(request)?.recovery??null);
 setOperatorDownloadComposition(({request,platform})=>{
  const ports=requests.get(request)?.downloads,context=executionContext(platform);
  if(!ports||!context)return null;
  return {...ports,waitUntil:(work)=>context.waitUntil(work)};
 });
}
