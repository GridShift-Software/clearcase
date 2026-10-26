import {describe,expect,it,vi} from 'vitest';
import {createHandle} from '../../../src/lib/server/runtime/hosted/handle.ts';
import {createUnavailableServices} from '../../../src/lib/server/runtime/unavailable.ts';
import {id} from '../../../src/lib/server/runtime/ids.ts';
const services=(client='client-a')=>createUnavailableServices({clientId:id('client',client),now:()=>new Date('2026-10-25T09:00:00.000Z')});
async function invoke(handle:ReturnType<typeof createHandle>,request:Request,resolve=vi.fn(async()=>new Response('route'))){
 const event={request,url:new URL(request.url),locals:{}};
 const response=await handle({event,resolve} as unknown as Parameters<typeof handle>[0]);
 return {response,event,resolve};
}
describe('native production handshake boundary',()=>{
 it('returns the handshake before service construction, retaining both cookies and security headers',async()=>{
  const build=vi.fn(async()=>({ready:true as const,services:services()}));
  const handshake=vi.fn(async()=>{const headers=new Headers({location:'https://client.clerk.test/v1/client/handshake'});headers.append('set-cookie','__session=synthetic; Path=/; Secure; HttpOnly');headers.append('set-cookie','__client_uat=1; Path=/; Secure');return new Response(null,{status:307,headers});});
  const out=await invoke(createHandle(build,handshake),new Request('https://client-a.test/cases'));
  expect(out.response.status).toBe(307);
  expect(out.response.headers.getSetCookie()).toHaveLength(2);
  expect(out.response.headers.get('cache-control')).toBe('no-store');
  expect(out.response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(build).not.toHaveBeenCalled();expect(out.resolve).not.toHaveBeenCalled();
 });
 it.each(['/health','/sign-out'])('never refreshes credentials before %s',async path=>{
  const handshake=vi.fn(async()=>new Response(null,{status:307}));
  const out=await invoke(createHandle(async()=>({ready:true,services:services()}),handshake),new Request('https://client-a.test'+path));
  expect(handshake).not.toHaveBeenCalled();expect(out.resolve).toHaveBeenCalledOnce();expect(out.response.status).toBe(200);
 });
 it('refuses a cross-origin write before invoking identity or handshake code',async()=>{
  const build=vi.fn(async()=>({ready:true as const,services:services()})),handshake=vi.fn(async()=>null);
  const out=await invoke(createHandle(build,handshake),new Request('https://client-a.test/cases',{method:'POST',headers:{origin:'https://foreign.test'}}));
  expect(out.response.status).toBe(403);expect(build).not.toHaveBeenCalled();expect(handshake).not.toHaveBeenCalled();expect(out.resolve).not.toHaveBeenCalled();
 });
 it('turns handshake faults into a generic unavailable answer without exposing the fault',async()=>{
  const build=vi.fn(async()=>({ready:true as const,services:services()}));
  const out=await invoke(createHandle(build,async()=>{throw Error('synthetic-private-value');}),new Request('https://client-a.test/cases'));
  expect(out.response.status).toBe(503);expect(await out.response.text()).not.toContain('synthetic-private-value');expect(build).not.toHaveBeenCalled();expect(out.resolve).not.toHaveBeenCalled();
 });
 it('keeps overlapping request services in their own locals',async()=>{
  let resume!:()=>void;const pending=new Promise<void>(r=>{resume=r;});
  const a=services('client-a'),b=services('client-b');
  const handle=createHandle(async request=>{if(request.url.endsWith('/a'))await pending;return{ready:true,services:request.url.endsWith('/a')?a:b};});
  const first=invoke(handle,new Request('https://client-a.test/a'));
  const second=await invoke(handle,new Request('https://client-a.test/b'));resume();const one=await first;
  expect((one.event.locals as typeof a).identity).toBe(a.identity);
  expect((second.event.locals as typeof b).identity).toBe(b.identity);
  expect((one.event.locals as typeof a).identity).not.toBe((second.event.locals as typeof b).identity);
 });
});
