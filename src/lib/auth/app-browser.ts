import { appCookieValue, appSessionConfig, appSetCookie, readAppSession, signAppSession, slideAppSession } from './app-session.ts';
import { readClerkIdentityConfig } from './clerk/config.ts';
import { cookiePairs, presentedToken } from './clerk/session.ts';

/** An unverified hint selects the staff flow only; that flow still verifies the credential. */
export function clerkBrowserNeeded(env: Readonly<Record<string, unknown>>, request: Request): boolean {
	if (appCookieValue(request) !== null) return false;
	const url = new URL(request.url), path = url.pathname;
	// Deployments without app-session bindings retain the Clerk protocol.
	if (env.CLEARCASE_SESSION_KEY === undefined && env.SESSIONS === undefined) return true;
	if (cookiePairs(request).some(({ name }) => name === '__Host-clearcase_staff_refresh') || ['__clerk_handshake', '__clerk_handshake_nonce', '__clearcase_staff_hs'].some((name) => url.searchParams.has(name))) return true;
	if (path === '/sign-in' && request.method === 'GET' && !url.search && !cookiePairs(request).some(({ name }) => name === '__client_uat' || name === '__clerk_db_jwt' || name.startsWith('__session'))) return false;
	if (path === '/sign-in' || path === '/sign-in/operator') return true;
	const config = readClerkIdentityConfig(env), token = presentedToken(request);
	if (!config.ok || !token || token === 'malformed') return false;
	try {
		const claims: unknown = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
		return typeof claims === 'object' && claims !== null && 'iss' in claims && claims.iss === config.config.staff.issuer;
	} catch { return false; }
}
export async function appSessionRefresh(env: Readonly<Record<string, unknown>>, request: Request): Promise<{ setCookies: string[] } | null> {
	const path = new URL(request.url).pathname;
	if (path === '/sign-in' || path === '/sign-in/operator' || path === '/sign-out') return null;
	const value = appCookieValue(request);
	if (value === null) return null;
	const clerk = readClerkIdentityConfig(env);
	const config = clerk.ok ? appSessionConfig(env, clerk.config.client.issuer) : null;
	if (!config) return null;
	const session = await readAppSession(config, value);
	const next = session && slideAppSession(session);
	return { setCookies: next ? [appSetCookie(await signAppSession(config, next), next)] : [] };
}
