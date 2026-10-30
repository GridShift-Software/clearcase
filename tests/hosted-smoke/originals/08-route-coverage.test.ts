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
 const page=await w.view();
 if(page.view.state!=='available') throw new Error('fixture');
 w.c.reset();
 expect((await w.get(w.identity,page.view.srcHref.replace('case-a','case-b'),{caseId:'case-b',assetId:'asset-a'})).status).toBe(404);
 expect(w.c.r2).toBe(0);
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

it('finalized intake originals open and download with the asset-ticket key, including legacy metadata', async () => {
 const w = await originalWorld({ allowLegacyBuffer: true });
 const { createOriginalIntake } = await import('../../../src/lib/storage/cloud/intake');
 const { BUDGETS, QUOTAS, ids, pdf, shaOf } = await import('../../hosted-foundation/storage/fixture');
 const bytes = pdf('synthetic intake ticket read'), sha = shaOf(bytes);
 const intake = createOriginalIntake({ bindings: { db: w.dep.db, bucket: w.dep.bucket }, clientId: ids.clientA, budgets: BUDGETS, quotas: QUOTAS,
  authorize: async () => {}, now: () => new Date('2200-01-01T00:00:00Z') });
 expect(await intake.declare({ caseId: ids.caseA, operationId: 'intake-ticket', assetId: 'intake-a', filename: 'intake.pdf', mediaType: 'application/pdf', size: bytes.length, sha256: sha })).toMatchObject({ kind: 'declared' });
 expect(await intake.put({ caseId: ids.caseA, operationId: 'intake-ticket', bytes })).toMatchObject({ kind: 'stored' });
 expect(await intake.finalize({ caseId: ids.caseA, operationId: 'intake-ticket' })).toMatchObject({ kind: 'finalized' });
 const stored = w.dep.db.rows<{ etag: string; media_family: string }>('SELECT etag,media_family FROM rs_original WHERE sha256 = ?', sha)[0];
 expect(stored).toEqual({ etag: (await w.dep.bucket.head(`orig/${sha}`))!.etag, media_family: 'pdf' });
 for (const legacy of [false, true]) {
  if (legacy) w.dep.db.exec('UPDATE rs_original SET etag = NULL, media_family = NULL WHERE sha256 = ?', sha);
  await expect(fastOriginals(w.locals().assets)!.locate({ kind: 'original', caseId: ids.caseA, assetId: 'intake-a' })).resolves.toMatchObject({ etag: stored.etag, mediaFamily: 'pdf' });
  const view = await w.view(w.identity, 'intake-a');
  expect(view.view).toMatchObject({ state: 'available', mode: 'pdf' });
  if (view.view.state !== 'available') throw new Error('intake viewer unavailable');
  for (const href of [view.view.srcHref, view.view.downloadHref]) {
   const response = await w.get(w.identity, href, { caseId: 'case-a', assetId: 'intake-a' });
   expect(response.status).toBe(200);
   expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  }
  const range = await w.get(w.identity, view.view.srcHref, { caseId: 'case-a', assetId: 'intake-a' }, { range: 'bytes=2-5' });
  expect(range.status).toBe(206);
  expect(new Uint8Array(await range.arrayBuffer())).toEqual(bytes.slice(2, 6));
 }
 // A legacy row cannot turn verification off: corrupt bytes still release nothing.
 w.dep.bucket.tamper(`orig/${sha}`, b => { b[0] ^= 1; return b; });
 await expect(w.view(w.identity, 'intake-a')).rejects.toMatchObject({ status: 410, body: { code: 'changed-original' } });
});
