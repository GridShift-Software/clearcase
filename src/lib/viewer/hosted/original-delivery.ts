import { env } from 'cloudflare:workers';
import type { FastOriginals } from './fast-original';
import type { AssetTicket } from './ticket';
import type { AssetRef } from '../../server/runtime/contracts';
import { servePolicy } from '../../case-package/media';
import { presignOriginal } from './presign';
import { INLINE_CSP } from './delivery';
export async function serveFastOriginal(a: {fast:FastOriginals;asset:AssetRef;method:'GET'|'HEAD';url:URL;headers:Headers;ticket?:AssetTicket}): Promise<Response> {
 const row = a.ticket ?? await a.fast.locate(a.asset);
 if (a.url.searchParams.get('download') === '1' && row.size > 100_000_000 && a.method === 'GET') {
  const cfg = JSON.parse(String(env.CLEARCASE_NATIVE_CONFIG));
  const href = await presignOriginal({accountId:String(env.R2_S3_ACCOUNT_ID ?? ''),bucket:cfg.deployment.r2Bucket,sha256:row.sha256,accessKeyId:String(env.R2_S3_ACCESS_KEY_ID ?? ''),secretAccessKey:String(env.R2_S3_SECRET_ACCESS_KEY ?? '')});
  a.fast.record(a.asset,'succeeded');
  return new Response(null,{status:302,headers:{location:href,'cache-control':'private, no-store','referrer-policy':'no-referrer'}});
 }
 const response = await a.fast.get(a.asset,{method:a.method,range:a.headers.get('range'),ifRange:a.headers.get('if-range')},a.ticket);
 const dest = a.headers.get('sec-fetch-dest');
 const inline = a.url.searchParams.get('download') !== '1' && ((row.mediaFamily === 'pdf' && dest === 'empty') || (row.mediaFamily === 'image' && (dest === 'empty' || dest === 'image')) || (row.mediaFamily === 'email-text' && row.mediaType === 'message/rfc822'));
 const headers = new Headers(response.headers);
 headers.set('vary','Range, Sec-Fetch-Dest');
 if (inline && response.ok) {
  headers.set('content-type',row.mediaFamily === 'email-text' ? 'text/plain; charset=utf-8' : row.mediaType);
  headers.set('content-disposition',servePolicy(row.mediaType,row.filename).headers['Content-Disposition']!.replace(/^attachment/,'inline'));
  headers.set('content-security-policy',row.mediaFamily === 'email-text' ? "sandbox; default-src 'none'; frame-ancestors 'self'" : INLINE_CSP);
 }
 return new Response(response.body,{status:response.status,headers});
}
