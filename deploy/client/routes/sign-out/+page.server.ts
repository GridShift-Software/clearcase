import { redirect, type Actions, type RequestEvent } from '@sveltejs/kit';
import { SESSION_COOKIE } from '$lib/server/runtime/hosted/session';
import { refuse } from '$lib/server/runtime/hosted/http';
import { SESSION_COOKIE as CLERK_SESSION_COOKIE } from '$lib/auth/clerk/session';

export function load() {
	redirect(303, '/sign-in');
}

export const actions: Actions = {
	default: async ({ locals, cookies, url }: RequestEvent) => {
		const sessionId = locals.identity.sessionId;
		if (sessionId !== null) await locals.runtime.testIdentity?.signOut({ sessionId }).catch((e) => refuse(e));
		// A Clerk session also ends at Clerk: the composer revokes it with ClerkIdentityProvider.signOut (GRS-113). Here
		// the browser stops presenting it.
		cookies.delete(SESSION_COOKIE, { path: '/', secure: url.protocol === 'https:' });
		cookies.delete(CLERK_SESSION_COOKIE, { path: '/', secure: url.protocol === 'https:' });
		redirect(303, '/sign-in');
	},
};
