import { redirect, type Actions, type RequestEvent } from '@sveltejs/kit';
import { SESSION_COOKIE } from '$lib/server/runtime/hosted/session';
import { refuse } from '$lib/server/runtime/hosted/http';

export function load() {
	redirect(303, '/sign-in');
}

export const actions: Actions = {
	default: async ({ locals, cookies, url }: RequestEvent) => {
		const sessionId = locals.identity.sessionId;
		if (sessionId !== null) await locals.runtime.testIdentity?.signOut({ sessionId }).catch((e) => refuse(e));
		cookies.delete(SESSION_COOKIE, { path: '/', secure: url.protocol === 'https:' });
		redirect(303, '/sign-in');
	},
};
