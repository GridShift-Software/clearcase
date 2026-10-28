/** Query-only SigV4 GET signing. The caller supplies trusted deployment coordinates, never request input. */
const utf8 = new TextEncoder();
const hex = (a: ArrayBuffer) => [...new Uint8Array(a)].map(x=>x.toString(16).padStart(2,'0')).join('');
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hmac = async (key: Uint8Array, value: string) => new Uint8Array(await crypto.subtle.sign('HMAC',await crypto.subtle.importKey('raw',new Uint8Array(key),{name:'HMAC',hash:'SHA-256'},false,['sign']),utf8.encode(value)));
export async function presignOriginal(a: {accountId:string;bucket:string;sha256:string;accessKeyId:string;secretAccessKey:string;now?:Date}): Promise<string> {
 if (!/^[a-f0-9]{32}$/.test(a.accountId) || !/^[a-z0-9-]+$/.test(a.bucket) || !/^[a-f0-9]{64}$/.test(a.sha256) || !a.accessKeyId || !a.secretAccessKey) throw new Error('download-unavailable');
 const date = (a.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g,''), day = date.slice(0,8), scope = `${day}/auto/s3/aws4_request`;
 const host = `${a.accountId}.eu.r2.cloudflarestorage.com`, path = `/${a.bucket}/orig/${a.sha256}`;
 const query = Object.entries({'response-content-disposition':'attachment','response-content-type':'application/octet-stream','X-Amz-Algorithm':'AWS4-HMAC-SHA256','X-Amz-Credential':`${a.accessKeyId}/${scope}`,'X-Amz-Date':date,'X-Amz-Expires':'600','X-Amz-SignedHeaders':'host'}).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${enc(k)}=${enc(v)}`).join('&');
 const canonical = `GET\n${path}\n${query}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`;
 const signing = await hmac(await hmac(await hmac(await hmac(utf8.encode(`AWS4${a.secretAccessKey}`),day),'auto'),'s3'),'aws4_request');
 const signature = hex((await hmac(signing,`AWS4-HMAC-SHA256\n${date}\n${scope}\n${hex(await crypto.subtle.digest('SHA-256',utf8.encode(canonical)))}`)).buffer);
 return `https://${host}${path}?${query}&X-Amz-Signature=${signature}`;
}
