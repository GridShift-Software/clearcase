import { redirect, type Actions, type RequestEvent } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { SESSION_COOKIE } from '$lib/server/runtime/hosted/session';
import { refuse } from '$lib/server/runtime/hosted/http';
import { signOutClerkSession } from '$lib/auth/clerk/flow';
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
		let clear: string[] = [];
		if (!double) clear = await signOutClerkSession({ env, request: request ?? new Request(url), identity: locals.identity }).then((r) => r.clear, (e) => refuse(e));
		const secure = url.protocol === 'https:';
		for (const name of new Set([SESSION_COOKIE, CLERK_SESSION_COOKIE, ...clear])) cookies.delete(name, { path: '/', secure });
		redirect(303, '/sign-in');
	},
};
