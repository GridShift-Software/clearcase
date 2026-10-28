import { error, redirect, type Actions, type RequestEvent } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { SESSION_COOKIE } from '$lib/server/runtime/hosted/session';
import { refuse } from '$lib/server/runtime/hosted/http';
import { signOutClerkSession, signOutScopes } from '$lib/auth/clerk/flow';
import { appCookieValue, appSessionConfig, revokeAppSession } from '$lib/auth/app-session';
import { readClerkIdentityConfig } from '$lib/auth/clerk/config';
import { SESSION_COOKIE as CLERK_SESSION_COOKIE } from '$lib/auth/clerk/session';

export function load() {
	redirect(303, '/sign-in');
}

export const actions: Actions = {
	default: async ({ locals, request, cookies, url }: RequestEvent) => {
		const double = locals.runtime.testIdentity;
		const sessionId = locals.identity.sessionId;
		if (sessionId !== null) await double?.signOut({ sessionId }).catch((e) => refuse(e));
		// A Clerk session ends at Clerk first (GRS-113): the caller's own session is revoked at the instance that issued
		// it, and only then are its cookies cleared. When Clerk cannot confirm the revocation this answers 503 and clears
		// nothing, so a session that is still live is never reported as ended.
		if (!double && appCookieValue(request ?? new Request(url)) !== null) {
			const clerk = readClerkIdentityConfig(env);
			const config = clerk.ok ? appSessionConfig(env, clerk.config.client.issuer) : null;
			if (!config) error(503, 'Sign-out is unavailable.');
			await revokeAppSession(config, request).catch((e) => refuse(e));
			cookies.delete(SESSION_COOKIE, { path: '/', secure: true });
		}
		let clear: string[] = [];
		if (!double) clear = await signOutClerkSession({ env, request: request ?? new Request(url), identity: locals.identity }).then((r) => r.clear, (e) => refuse(e));
		const secure = url.protocol === 'https:';
		for (const name of new Set([SESSION_COOKIE, CLERK_SESSION_COOKIE, ...clear])) cookies.delete(name, { path: '/', secure });
		if (!double) {
			// and every Clerk session name this deployment owns on each parent domain, where a live copy would otherwise sign the
			// browser back in once the host-only one is gone; a session cookie of another instance it may not clear means
			// sign-out has not finished, so it is never reported as done (session-renewal-live-2 re-check M3)
			const scopes = await signOutScopes({ env, request: request ?? new Request(url), url }).catch((e) => refuse(e));
			for (const { name, domain } of scopes.parents) cookies.delete(name, { path: '/', domain, secure });
			if (scopes.unowned.length) error(409, "Sign-out may not have finished: this browser holds a sign-in cookie ClearCase may not remove. Sign out again, and if this repeats, clear this site's cookies.");
		}
		redirect(303, '/sign-in');
	},
};
