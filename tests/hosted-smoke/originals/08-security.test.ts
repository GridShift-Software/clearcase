import { id } from '../../../src/lib/server/runtime/ids';
import { expect, it } from 'vitest';
import { mintTicket, verifyTicket } from '../../../src/lib/viewer/hosted/ticket';
import { rangedRead } from '../../../src/lib/storage/cloud/objects';
import { singleRange } from '../../../src/lib/results/hosted/assets';
const claims = { caseId: 'case-a', assetId: 'asset-a', sha256: 'a'.repeat(64), etag: 'stored-tag', size: 258_000_000, mediaType: 'application/pdf', filename: 'synthetic.pdf', mediaFamily: 'pdf', subject: 'user-a', clientId:'client-a', issuer:'synthetic' };
it('binds every ticket claim and rejects expiry, another key, case, asset and tampering', async () => {
 const t = await mintTicket(claims, 'key-a', 1000);
 expect(await verifyTicket(t, 'key-a', 'case-a', 'asset-a', 1001)).toMatchObject(claims);
 for (const [key, c, a, now] of [['key-b','case-a','asset-a',1001], ['key-a','case-b','asset-a',1001], ['key-a','case-a','asset-b',1001], ['key-a','case-a','asset-a',1900]] as const)
  expect(await verifyTicket(t,key,c,a,now)).toBeNull();
 expect(await verifyTicket(t+'x','key-a','case-a','asset-a',1001)).toBeNull();
 // Grant revocation intentionally has no input here: a minted ticket remains usable for its 15-minute lifetime.
 expect(await verifyTicket(t,'key-a','case-a','asset-a',1899)).not.toBeNull();
});
it('streams one conditional ranged R2 read without buffering, and rejects moved etags', async () => {
 const calls: unknown[] = [];
 const bucket = { get: async (...args: unknown[]) => { calls.push(args); return { size: claims.size, etag: claims.etag, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1,2])); c.close(); } }) }; } };
 const r = await rangedRead(bucket, 'orig/'+claims.sha256, claims, {start: 0,end: 1});
 expect(r.kind).toBe('ok');
 expect(calls).toEqual([['orig/'+claims.sha256, {range:{offset:0,length:2},onlyIf:{etagMatches:claims.etag}}]]);
 expect(await rangedRead({get:async()=>({size:claims.size,etag:'changed'})}, 'key',claims,null)).toEqual({kind:'changed'});
 expect(await rangedRead({get:async()=>null}, 'key',claims,null)).toEqual({kind:'missing'});
});
it('rejects multi-range, unsatisfiable and malformed ranges', () => {
 for (const h of ['bytes=0-1,3-4','bytes=5-4','bytes=258000000-','bytes=-0','bytes=a-b']) expect(singleRange(h,claims.size)).toBeNull();
 expect(singleRange('bytes=-2',10)).toEqual({start:8,end:9});
});

it('presigns exactly one object for 600 seconds on the EU S3 endpoint', async () => {
 const { presignOriginal } = await import('../../../src/lib/viewer/hosted/presign');
 const url = new URL(await presignOriginal({accountId:'a'.repeat(32),bucket:'synthetic',sha256:claims.sha256,accessKeyId:'synthetic-key',secretAccessKey:'synthetic-secret',now:new Date('2026-10-28T00:00:00Z')}));
 expect(url.hostname).toBe('a'.repeat(32)+'.eu.r2.cloudflarestorage.com');
 expect(url.pathname).toBe('/synthetic/orig/'+claims.sha256);
 expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
 expect(url.searchParams.get('X-Amz-Date')).toBe('20261028T000000Z');
 expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
});

it('delivers stored families with one read and preserves sandbox headers', async () => {
 const { serveFastOriginal } = await import('../../../src/lib/viewer/hosted/original-delivery');
 for (const [mediaFamily,mediaType,filename,inline] of [['email-text','message/rfc822','synthetic.eml',true],['image','image/jpeg','synthetic.jpg',true],['download','application/vnd.ms-outlook','synthetic.msg',false],['download','application/msword','synthetic.doc',false]] as const) {
  let reads=0;
  const row = {...claims,mediaFamily,mediaType,filename,objectKey:'orig/'+claims.sha256};
  const r = await serveFastOriginal({fast:{locate:async()=>row,record:()=>{},get:async()=>{reads++;return new Response('synthetic',{headers:{'content-disposition':'attachment','content-security-policy':"sandbox; default-src 'none'"}});}},asset:{kind:'original',caseId:id('case','case-a'),assetId:'asset-a'},method:'GET',url:new URL('https://example.invalid/cases/case-a/originals/asset-a'),headers:new Headers({'sec-fetch-dest':'empty'})});
  expect(reads).toBe(1);
  expect(r.headers.get('content-disposition')?.startsWith('inline')).toBe(inline);
  expect(r.headers.get('content-security-policy')).toContain('sandbox');
  if (filename.endsWith('.eml')) expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8');
 }
});

it('L5 signs attachment and octet-stream presentation and refuses missing account',async()=>{
 const {presignOriginal}=await import('../../../src/lib/viewer/hosted/presign');
 const options={accountId:'a'.repeat(32),bucket:'synthetic',sha256:claims.sha256,accessKeyId:'synthetic-key',secretAccessKey:'synthetic-secret'};
 const url=new URL(await presignOriginal(options));
 expect(url.searchParams.get('response-content-disposition')).toBe('attachment');
 expect(url.searchParams.get('response-content-type')).toBe('application/octet-stream');
 await expect(presignOriginal({...options,accountId:''})).rejects.toThrow('download-unavailable');
 const {readFileSync}=await import('node:fs');
 expect(readFileSync('src/lib/viewer/hosted/original-delivery.ts','utf8')).not.toContain('fb4c31b91c5d89b7a54afbdc34823170');
});

it('L5 canonical query uses byte order across response and X-Amz parameters',async()=>{
 const {presignOriginal}=await import('../../../src/lib/viewer/hosted/presign');
 const url=new URL(await presignOriginal({accountId:'a'.repeat(32),bucket:'synthetic',sha256:claims.sha256,accessKeyId:'synthetic-key',secretAccessKey:'synthetic-secret'}));
 const keys=[...url.searchParams.keys()].filter(k=>k!=='X-Amz-Signature');
 expect(keys).toEqual([...keys].sort());
});
