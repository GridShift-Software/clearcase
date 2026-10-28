import { expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers',()=>({env:{CLEARCASE_ASSET_TICKET_KEY:'synthetic-test-key'}}));
import { isHttpError } from '@sveltejs/kit';
import { originalWorld } from './08-world';
import { fastOriginals } from '../../../src/lib/viewer/hosted/fast-original';
it('M1 route uses fast originals; wrong case is 404 before original R2 read',async()=>{
 const w=await originalWorld();
 expect(fastOriginals(w.locals().assets)).toBeDefined();
 const r=await w.get(w.identity,'/cases/case-b/originals/asset-a',{caseId:'case-b',assetId:'asset-a'}).catch(e=>{if(isHttpError(e)) return new Response(null,{status:e.status});throw e;});
 expect(r.status).toBe(404);
 // Only the storage identity marker may be read; no original bytes.
 expect(w.dep.bucket.gets).toBe(1);
});
it('M1 moved ETag answers 412 with no bytes through serveAsset',async()=>{
 const w=await originalWorld(), p=await w.view();
 if(p.view.state!=='available') throw new Error('fixture');
 w.dep.bucket.tamper(w.key,b=>b);
 const r=await w.get(w.identity,p.view.srcHref);
 expect(r.status).toBe(412);expect((await r.arrayBuffer()).byteLength).toBe(0);
});
it('M1 ticket for another asset is refused without R2',async()=>{
 const w=await originalWorld(), p=await w.view();
 if(p.view.state!=='available') throw new Error('fixture');
 w.c.reset();
 const r=await w.get(w.identity,p.view.srcHref.replace('/asset-a?','/asset-b?'),{caseId:'case-a',assetId:'asset-b'});
 expect(r.status).toBe(404);expect(w.c.r2).toBe(0);
});
it('M1 not-found maps to missing Original not supplied state',async()=>{
 const w=await originalWorld();
 expect((await w.view(w.identity,'missing')).view).toMatchObject({state:'unavailable',reason:'missing'});
 expect(await w.locals().assets.availability({asset:{kind:'original',caseId:'case-a' as never,assetId:'missing'}})).toMatchObject({kind:'unavailable',reason:'missing'});
});
