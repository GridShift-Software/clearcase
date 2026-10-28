import type { Principal } from '../server/runtime/contracts.ts';
import { cookiePairs } from './clerk/session.ts';
import { contractError } from '../server/runtime/errors.ts';

export const APP_COOKIE = 'clearcase_session';
export const SESSION_WINDOW = 8 * 60 * 60;
export const SESSION_MAX = 24 * 60 * 60;
export interface SessionKV {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, options: { expirationTtl: number }): Promise<unknown>;
}
export interface AppSession {
	sid: string; subject: string; issuer: string; principalKind: Principal['kind']; name: string;
	iat: number; exp: number; max: number; refreshed: number;
}
export interface AppSessionConfig { key: string; clientId: string; origin: string; issuer: string; sessions: SessionKV }
export function appSessionConfig(env: Readonly<Record<string, unknown>>, issuer: string): AppSessionConfig | null {
	const { CLEARCASE_SESSION_KEY: key, CLEARCASE_CLIENT_ID: clientId, CLEARCASE_APP_ORIGIN: origin, SESSIONS: sessions } = env;
	if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key) || typeof clientId !== 'string' || !clientId || typeof origin !== 'string' || !origin || typeof sessions !== 'object' || sessions === null || !('get' in sessions) || typeof sessions.get !== 'function' || !('put' in sessions) || typeof sessions.put !== 'function') return null;
	return { key, clientId, origin, issuer, sessions: sessions as SessionKV };
}
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const nowSeconds = () => Math.floor(Date.now() / 1000);
const keyOf = (config: AppSessionConfig) => crypto.subtle.importKey('raw', new TextEncoder().encode(config.key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
const message = (config: AppSessionConfig, body: string) => new TextEncoder().encode(JSON.stringify(['clearcase-session-v1', config.clientId, config.origin, config.issuer, body]));
export function appCookieValue(request: Request): string | null {
	const header = request.headers.get('cookie') ?? '';
	if (/,\s*clearcase_session\s*=/.test(header)) return 'malformed';
	const values = cookiePairs(request).filter((p) => p.name === APP_COOKIE);
	if (!values.length) return null;
	return values.length === 1 ? values[0]!.value : 'malformed';
}
export async function signAppSession(config: AppSessionConfig, session: AppSession): Promise<string> {
	const body = encode(new TextEncoder().encode(JSON.stringify(session)));
	return `${body}.${encode(new Uint8Array(await crypto.subtle.sign('HMAC', await keyOf(config), message(config, body))))}`;
}
export async function readAppSession(config: AppSessionConfig, value: string, now = nowSeconds(), expired = false): Promise<AppSession | null> {
	try {
		if (value.length > 3800 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return null;
		const [body, signature] = value.split('.');
		if (!await crypto.subtle.verify('HMAC', await keyOf(config), decode(signature!), message(config, body!))) return null;
		const s: unknown = JSON.parse(new TextDecoder().decode(decode(body!)));
		if (typeof s !== 'object' || s === null || !('sid' in s) || typeof s.sid !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(s.sid) || !('subject' in s) || typeof s.subject !== 'string' || !s.subject || s.subject.length > 128 || !('issuer' in s) || s.issuer !== config.issuer || !('principalKind' in s) || s.principalKind !== 'client' || !('name' in s) || typeof s.name !== 'string' || s.name.length > 200 || !('iat' in s) || typeof s.iat !== 'number' || !('exp' in s) || typeof s.exp !== 'number' || !('max' in s) || typeof s.max !== 'number' || !('refreshed' in s) || typeof s.refreshed !== 'number') return null;
		const { iat, exp, max, refreshed } = s;
		if (![iat, exp, max, refreshed].every(Number.isSafeInteger) || iat > now || refreshed < iat || refreshed > now || max !== iat + SESSION_MAX || exp > max || exp > refreshed + SESSION_WINDOW || exp <= refreshed || now >= max || (!expired && now >= exp)) return null;
		return { sid: s.sid, subject: s.subject, issuer: s.issuer, principalKind: s.principalKind, name: s.name, iat, exp, max, refreshed };
	} catch { return null; }
}
export async function mintAppSession(config: AppSessionConfig, identity: { sid: string; subject: string; name: string }, now = nowSeconds()): Promise<AppSession> {
	return { ...identity, issuer: config.issuer, principalKind: 'client', iat: now, refreshed: now, exp: now + SESSION_WINDOW, max: now + SESSION_MAX };
}
export function slideAppSession(session: AppSession, now = nowSeconds()): AppSession | null {
	return now < session.exp && now < session.max && now - session.refreshed > 300 ? { ...session, refreshed: now, exp: Math.min(now + SESSION_WINDOW, session.max) } : null;
}
export const appCookieOptions = (session: AppSession) => ({ path: '/', httpOnly: true, secure: true, sameSite: 'lax' as const, expires: new Date(session.exp * 1000) });
export const appSetCookie = (value: string, session: AppSession) => `${APP_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Expires=${new Date(session.exp * 1000).toUTCString()}`;
export async function revokeAppSession(config: AppSessionConfig, request: Request): Promise<void> {
	const value = appCookieValue(request);
	const session = value ? await readAppSession(config, value, nowSeconds(), true) : null;
	if (!session) return;
	try { await config.sessions.put(`revoked:${session.sid}`, '1', { expirationTtl: Math.max(60, session.max - nowSeconds()) }); }
	catch { throw contractError('identity-unavailable', true); }
}
