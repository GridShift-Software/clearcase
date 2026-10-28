import { appCookieValue, appSessionConfig, appSetCookie, readAppSession, signAppSession, slideAppSession } from './app-session.ts';
import { readClerkIdentityConfig } from './clerk/config.ts';
import { presentedToken } from './clerk/session.ts';

/** An unverified hint selects the staff flow only; that flow still verifies the credential. */
export function clerkBrowserNeeded(env: Readonly<Record<string, unknown>>, request: Request): boolean {
	if (appCookieValue(request) !== null) return false;
	const path = new URL(request.url).pathname;
	if (path === '/sign-in' || path === '/sign-in/operator') return true;
	const config = readClerkIdentityConfig(env), token = presentedToken(request);
	if (!config.ok || !token || token === 'malformed') return false;
	try {
		const claims: unknown = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
		return typeof claims === 'object' && claims !== null && 'iss' in claims && claims.iss === config.config.staff.issuer;
	} catch { return false; }
}
export async function appSessionRefresh(env: Readonly<Record<string, unknown>>, request: Request): Promise<{ setCookies: string[] } | null> {
	const value = appCookieValue(request);
	if (value === null) return null;
	const clerk = readClerkIdentityConfig(env);
	const config = clerk.ok ? appSessionConfig(env, clerk.config.client.issuer) : null;
	if (!config) return null;
	const session = await readAppSession(config, value);
	const next = session && slideAppSession(session);
	return { setCookies: next ? [appSetCookie(await signAppSession(config, next), next)] : [] };
}
