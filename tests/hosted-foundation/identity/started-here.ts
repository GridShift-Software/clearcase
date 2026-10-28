// GRS-268: a handshake return counts only in the browser that started that handshake. Tests that model the return of a
// handshake this browser started, without driving its start, use startedHere to add what the start would have left:
// the binding id in the URL and its cookie in the Cookie header. A request that carries no handshake token, or a binding
// already, is passed as it is. What a return without a binding gets is pinned in handshake-binding.test.ts.
import { expect } from 'vitest';
import { readClerkIdentityConfig } from '../../../src/lib/auth/clerk/config.ts';
import { HANDSHAKE_BINDING_PARAM, startHandshakeBinding } from '../../../src/lib/auth/clerk/flow.ts';

export async function startedHere(request: Request, env: Readonly<Record<string, unknown>>): Promise<Request> {
	const url = new URL(request.url);
	if (!url.searchParams.has('__clerk_handshake') || url.searchParams.has(HANDSHAKE_BINDING_PARAM)) return request;
	const read = readClerkIdentityConfig(env);
	if (!read.ok) return request;
	const { id, setCookies } = await startHandshakeBinding(read.config, new Request(url));
	url.searchParams.set(HANDSHAKE_BINDING_PARAM, id);
	const pair = setCookies.at(-1)!.split(';')[0]!, cookie = request.headers.get('cookie');
	const headers = new Headers(request.headers);
	headers.set('cookie', cookie ? `${cookie}; ${pair}` : pair);
	return new Request(url, { method: request.method, headers });
}
/** `handshake`, whose every return is one this browser started (startedHere). */
export function bindingStarted<H extends { handle(request: Request): Promise<unknown> }>(handshake: H, env: Readonly<Record<string, unknown>>): H {
	return { ...handshake, handle: async (request: Request) => handshake.handle(await startedHere(request, env)) } as H;
}
const CONSUME = /^__Host-clearcase_hs_[A-Za-z0-9_-]{22}=; Max-Age=0; Path=\/; SameSite=Lax; HttpOnly; Secure$/;
const BINDING_SET = /^__Host-clearcase_hs_([A-Za-z0-9_-]{22})=\d{1,12}\.[A-Za-z0-9_-]{43}; Max-Age=120; Path=\/; SameSite=Lax; HttpOnly; Secure$/;
/** A bound return's answer without its first directive, which must be the delete of its binding cookie. */
export function consumed<O extends { setCookies: string[] }>(o: O): O {
	expect(o.setCookies[0]).toMatch(CONSUME);
	return { ...o, setCookies: o.setCookies.slice(1) };
}
/** A handshake start's answer without its binding: the id in the redirect_url and the one cookie that holds it, which must agree. */
export function startedBound<O extends { location: string; setCookies: string[] }>(o: O): O {
	const to = new URL(o.location), back = new URL(to.searchParams.get('redirect_url')!), id = back.searchParams.get(HANDSHAKE_BINDING_PARAM);
	const at = o.setCookies.findIndex((c) => BINDING_SET.test(c));
	expect(at).toBeGreaterThanOrEqual(0);
	expect(BINDING_SET.exec(o.setCookies[at]!)![1]).toBe(id);
	back.searchParams.delete(HANDSHAKE_BINDING_PARAM);
	to.searchParams.set('redirect_url', back.href);
	return { ...o, location: to.href, setCookies: o.setCookies.filter((_, i) => i !== at) };
}
