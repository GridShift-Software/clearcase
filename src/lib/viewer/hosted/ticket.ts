/** Session-bound authority for one original. Revocation is deliberately bounded by the 15-minute expiry. Never log a ticket. */
export interface TicketClaims { caseId: string; assetId: string; sha256: string; etag: string; size: number; mediaType: string; mediaFamily: string; filename: string; subject: string; issuer?: string; clientId: string }
export type AssetTicket = TicketClaims & { exp: number };
const encoder = new TextEncoder();
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const decode = (s: string) => Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')), c => c.charCodeAt(0));
const keyOf = (secret: string) => crypto.subtle.importKey('raw', encoder.encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign','verify']);
export async function mintTicket(claims: TicketClaims, secret: string, now = Math.floor(Date.now()/1000)): Promise<string> {
 if (!secret) throw new Error('asset-ticket-unavailable');
 const payload = encode(encoder.encode(JSON.stringify({...claims,exp:now+900})));
 return `${payload}.${encode(new Uint8Array(await crypto.subtle.sign('HMAC',await keyOf(secret),encoder.encode(payload))))}`;
}
export async function verifyTicket(ticket: string, secret: string, caseId: string, assetId: string, now = Math.floor(Date.now()/1000)): Promise<AssetTicket|null> {
 try {
  if (!secret || ticket.length > 8192) return null;
  const [payload,signature,...rest] = ticket.split('.');
  if (!payload || !signature || rest.length || !/^[\w-]+$/.test(payload) || !/^[\w-]+$/.test(signature)) return null;
  if (!await crypto.subtle.verify('HMAC',await keyOf(secret),decode(signature),encoder.encode(payload))) return null;
  const c = JSON.parse(new TextDecoder().decode(decode(payload)));
  if (c.caseId !== caseId || c.assetId !== assetId || !Number.isSafeInteger(c.exp) || c.exp <= now || c.exp > now+900 || !/^[a-f0-9]{64}$/.test(c.sha256) || !Number.isSafeInteger(c.size) || c.size < 0) return null;
  for (const k of ['etag','mediaType','mediaFamily','filename','subject','clientId']) if (typeof c[k] !== 'string' || !c[k] || c[k].length > 1024) return null;
  return c;
 } catch { return null; }
}
