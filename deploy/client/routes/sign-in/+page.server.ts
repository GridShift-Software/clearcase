import { error, fail, redirect, type Actions, type RequestEvent } from '@sveltejs/kit';
import { SESSION_COOKIE } from '$lib/server/runtime/hosted/session';
import { refuse } from '$lib/server/runtime/hosted/http';
import { codeOf } from '$lib/server/runtime/errors';
import { id } from '$lib/server/runtime/ids';

const IDENTITY = /^([a-z0-9][a-z0-9-]{0,62})\/([A-Za-z0-9._-]{1,64})$/;
function provider(locals: App.Locals) {
	const double = locals.runtime.testIdentity;
	if (!double) error(503, { message: 'No sign-in provider is configured for this deployment.', code: 'identity-unavailable' });
	return double;
}

export async function load({ locals }: RequestEvent) {
	const double = provider(locals);
	const options = await double.options().catch((e) => refuse(e));
	return { provider: double.provider, options: options.map((o) => ({ value: `${o.clientId}/${o.subject}`, label: o.label })) };
}

export const actions: Actions = {
	default: async ({ request, locals, cookies, url }: RequestEvent) => {
		const double = provider(locals);
		const value = (await request.formData()).get('identity');
		const match = typeof value === 'string' ? IDENTITY.exec(value) : null;
		if (!match) return fail(400, { message: 'Choose a test identity.' });
		const session = await double.signIn({ clientId: id('client', match[1]!), subject: match[2]! }).catch((e) => (codeOf(e) === 'unauthenticated' ? null : refuse(e)));
		if (!session) return fail(400, { message: 'That test identity does not exist.' });
		cookies.set(SESSION_COOKIE, session.sessionId, { path: '/', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', expires: new Date(session.expiresAt) });
		redirect(303, '/cases');
	},
};
