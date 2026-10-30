// GRS-268: a handshake return counts only in the browser that started that handshake. Tests that model the return of a
// handshake this browser started, without driving its start, use startedHere to add what the start would have left:
// the binding id in the URL and its cookie in the Cookie header, and for a return the client instance signed, the
// client correlation a development client start on https leaves beside it (GRS-279), so its dev browser is tied as a
// real start's is. A request that carries no handshake token, or a binding already, is passed as it is. What a return
// without a binding gets is pinned in handshake-binding.test.ts, without a correlation in client-signin-tie.test.ts.
import { expect } from 'vitest';
import { readClerkIdentityConfig, rsaJwkOf, type ClerkIdentityConfig } from '../../../src/lib/auth/clerk/config.ts';
import { DEV_BROWSER_TIE, HANDSHAKE_BINDING_PARAM, HANDSHAKE_CORRELATION, devBrowserTie, handshakeCorrelationClear, startCorrelatedHandshake, startHandshakeBinding } from '../../../src/lib/auth/clerk/flow.ts';

const clientSigned = async (config: ClerkIdentityConfig, token: string) => {
	const [header = '', payload = '', signature = ''] = token.split('.');
	try {
		const key = await crypto.subtle.importKey('jwk', rsaJwkOf(config.client.jwtKey), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
		return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, Buffer.from(signature, 'base64url'), new TextEncoder().encode(`${header}.${payload}`));
	} catch {
		return false;
	}
};
export async function startedHere(request: Request, env: Readonly<Record<string, unknown>>): Promise<Request> {
	const url = new URL(request.url);
	if (!url.searchParams.has('__clerk_handshake') || url.searchParams.has(HANDSHAKE_BINDING_PARAM)) return request;
	const read = readClerkIdentityConfig(env);
	if (!read.ok) return request;
	const { id, setCookies } = await startHandshakeBinding(read.config, new Request(url));
	url.searchParams.set(HANDSHAKE_BINDING_PARAM, id);
	const pairs = [setCookies.at(-1)!.split(';')[0]!];
	const correlation = read.config.client.publishableKey.startsWith('pk_test_') && !url.searchParams.has(HANDSHAKE_CORRELATION.client.param) && (await clientSigned(read.config, url.searchParams.get('__clerk_handshake')!))
		? await startCorrelatedHandshake(read.config, 'client', true) : null;
	if (correlation) url.searchParams.set(HANDSHAKE_CORRELATION.client.param, correlation.id), pairs.push(correlation.setCookie.split(';')[0]!);
	const cookie = request.headers.get('cookie');
	const headers = new Headers(request.headers);
	headers.set('cookie', [...(cookie ? [cookie] : []), ...pairs].join('; '));
	return new Request(url, { method: request.method, headers });
}
/** `handshake`, whose every return is one this browser started (startedHere). */
export function bindingStarted<H extends { handle(request: Request): Promise<unknown> }>(handshake: H, env: Readonly<Record<string, unknown>>): H {
	return { ...handshake, handle: async (request: Request) => handshake.handle(await startedHere(request, env)) } as H;
}
const CONSUME = /^__Host-clearcase_hs_[A-Za-z0-9_-]{22}=; Max-Age=0; Path=\/; SameSite=Lax; HttpOnly; Secure$/;
const BINDING_SET = /^__Host-clearcase_hs_([A-Za-z0-9_-]{22})=\d{1,12}\.[A-Za-z0-9_-]{43}; Max-Age=120; Path=\/; SameSite=Lax; HttpOnly; Secure$/;
/**
 * A bound return's answer without its first directive, which must be the delete of its binding cookie, nor the delete of
 * the client correlation startedHere added beside it.
 */
export function consumed<O extends { setCookies: string[] }>(o: O): O {
	expect(o.setCookies[0]).toMatch(CONSUME);
	return { ...o, setCookies: o.setCookies.slice(1).filter((c) => c !== handshakeCorrelationClear('client')) };
}
const CLIENT_CORRELATION_SET = new RegExp(`^${HANDSHAKE_CORRELATION.client.cookie}=([A-Za-z0-9_-]{43})\\.\\d{1,12}\\.[01]\\.[A-Za-z0-9_-]{43}; Path=/; Max-Age=600; SameSite=Lax; HttpOnly; Secure$`);
/**
 * A handshake start's answer without its binding: the id in the redirect_url and the one cookie that holds it, which must
 * agree. A development client start on https also carries a correlation (GRS-279, client-signin-tie.test.ts), which goes
 * the same way when present.
 */
export function startedBound<O extends { location: string; setCookies: string[] }>(o: O): O {
	const to = new URL(o.location), back = new URL(to.searchParams.get('redirect_url')!), id = back.searchParams.get(HANDSHAKE_BINDING_PARAM);
	const at = o.setCookies.findIndex((c) => BINDING_SET.test(c));
	expect(at).toBeGreaterThanOrEqual(0);
	expect(BINDING_SET.exec(o.setCookies[at]!)![1]).toBe(id);
	back.searchParams.delete(HANDSHAKE_BINDING_PARAM);
	const correlated = o.setCookies.findIndex((c) => CLIENT_CORRELATION_SET.test(c));
	if (correlated >= 0) expect(CLIENT_CORRELATION_SET.exec(o.setCookies[correlated]!)![1]).toBe(back.searchParams.get(HANDSHAKE_CORRELATION.client.param));
	else expect(back.searchParams.has(HANDSHAKE_CORRELATION.client.param)).toBe(false);
	back.searchParams.delete(HANDSHAKE_CORRELATION.client.param);
	to.searchParams.set('redirect_url', back.href);
	return { ...o, location: to.href, setCookies: o.setCookies.filter((_, i) => i !== at && i !== correlated) };
}
/** The Cookie pair that ties `devBrowser` to the client instance of `env`, as a browser's own client handshake leaves it (GRS-279). */
export async function clientTie(env: Readonly<Record<string, unknown>>, devBrowser: string): Promise<string> {
	const read = readClerkIdentityConfig(env, { keys: 'optional' });
	if (!read.ok) throw new Error(read.reason);
	return `${DEV_BROWSER_TIE.client}=${await devBrowserTie(read.config, 'client', devBrowser)}`;
}
