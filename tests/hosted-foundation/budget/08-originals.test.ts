import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('cloudflare:workers',()=>({env:{CLEARCASE_ASSET_TICKET_KEY:'synthetic-test-key'}}));
import { originalWorld } from '../../hosted-smoke/originals/08-world';
import { measure, assertWithinBudget } from './harness';
it('H2 measures real view and GET routes including storage gate and grant queries',async()=>{
 const w=await originalWorld();
 const page=await measure(w.c,()=>w.view());
 expect(page.thrown).toBeUndefined();
 process.stdout.write(`budget view page ${JSON.stringify(page.counts)}\n`);
 expect(page.counts).toEqual({d1:4,r2:1,clerk:0,otherFetch:0});
 assertWithinBudget('view current ceiling (09b reduces grants)',page.counts,{d1:4,r2:1,clerk:0});
 if(page.value?.view.state!=='available') throw new Error('fixture');
 const href=page.value.view.srcHref;
 const ticket=await measure(w.c,()=>w.get(w.identity,href,undefined,{range:'bytes=0-1'}));
 process.stdout.write(`budget ticketed ranged GET ${JSON.stringify(ticket.counts)}\n`);
 expect(ticket.value?.status).toBe(206);
 expect(ticket.counts).toEqual({d1:0,r2:1,clerk:0,otherFetch:0});
 const direct=await measure(w.c,()=>w.get(w.identity,'/cases/case-a/originals/asset-a'));
 process.stdout.write(`budget unticketed GET ${JSON.stringify(direct.counts)}\n`);
 expect(direct.value?.status).toBe(200);
 expect(direct.counts).toEqual({d1:4,r2:2,clerk:0,otherFetch:0});
 assertWithinBudget('direct current ceiling',direct.counts,{d1:4,r2:2,clerk:0});
});
it('H2 fast served path never hashes object bytes',()=>{
 const files=['src/lib/viewer/hosted/route.ts','src/lib/viewer/hosted/delivery.ts','src/lib/viewer/hosted/original-delivery.ts','src/lib/viewer/hosted/view-model.ts','src/lib/viewer/hosted/ticket.ts'];
 for(const file of files) expect(readFileSync(file,'utf8')).not.toMatch(/DigestStream|subtle\.digest|verifiedRead/);
 const assets=readFileSync('src/lib/results/hosted/assets.ts','utf8').split('  const fast = {')[1];
 const ranged=readFileSync('src/lib/storage/cloud/objects.ts','utf8').split('export async function rangedRead')[1];
 for(const source of [assets,ranged]) expect(source).not.toMatch(/DigestStream|subtle\.digest|digest\(|verifiedRead|arrayBuffer\(/);
 // Presign hashes only canonical signing text, never an R2 body.
 expect(readFileSync('src/lib/viewer/hosted/presign.ts','utf8')).toMatch(/subtle\.digest\('SHA-256',utf8.encode\(canonical\)\)/);
});
