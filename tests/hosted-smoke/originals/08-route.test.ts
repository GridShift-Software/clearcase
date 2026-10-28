import { expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers',()=>({env:{CLEARCASE_ASSET_TICKET_KEY:'synthetic-test-key'}}));
import { originalWorld } from './08-world';
import type { Identity } from '../../../src/lib/server/runtime/contracts';
it('H1 binds ticket to signed-in subject and issuer before any R2 read',async()=>{
 const w=await originalWorld(), page=await w.view();
 if(page.view.state!=='available') throw new Error('fixture');
 const signedOut:Identity={...w.identity,kind:'anonymous',principal:null,sessionId:null};
 if(w.identity.kind!=='verified') throw new Error('identity');
 for(const who of [signedOut,{...w.identity,clientId:'client-b' as never},{...w.identity,principal:{...w.identity.principal,subject:'other'}},{...w.identity,principal:{...w.identity.principal,issuer:'other'}}]) {
  w.c.reset();
  expect((await w.get(who,page.view.srcHref)).status).toBe(404);
  expect(w.c.snapshot()).toMatchObject({d1:0,r2:0});
 }
 w.c.reset();
 const r=await w.get(w.identity,page.view.srcHref,undefined,{range:'bytes=0-1'});
 expect(r.status).toBe(206); expect(await r.arrayBuffer()).toEqual(new Uint8Array([1,2]).buffer);
 expect(w.c.snapshot()).toMatchObject({d1:0,r2:1});
 await new Promise(resolve=>setTimeout(resolve,20));
 expect(w.events.at(-1)).toMatchObject({subject:'user-a',outcome:'succeeded'});
 expect(new URL(page.view.downloadHref,'https://example.invalid').searchParams.has('t')).toBe(false);
});
