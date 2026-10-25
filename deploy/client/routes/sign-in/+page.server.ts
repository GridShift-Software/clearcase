import { error, fail, redirect, type Actions, type RequestEvent } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { SESSION_COOKIE } from '$lib/server/runtime/hosted/session';
import { refuse } from '$lib/server/runtime/hosted/http';
import { codeOf } from '$lib/server/runtime/errors';
import { id } from '$lib/server/runtime/ids';
import { clerkSignInTarget } from '$lib/auth/clerk/config';
import { devBrowserOf, prepareSignIn, safeReturnTo } from '$lib/auth/clerk/flow';

const IDENTITY = /^([a-z0-9][a-z0-9-]{0,62})\/([A-Za-z0-9._-]{1,64})$/;
const unconfigured = () => error(503, { message: 'No sign-in provider is configured for this deployment.', code: 'identity-unavailable' });
// The hosted-gate profile signs in through its test identity double. Production signs in at this client's Clerk
// application (GRS-113), which is invite-only: the page links there and holds no key.
// The page data never carries the dev browser; only the POST's redirect hands it to the portal.
const clerk = (url?: URL, request?: Request) => clerkSignInTarget(env, safeReturnTo(url?.searchParams.get('returnTo')), 'client', request ? devBrowserOf(request) : null);

export async function load({ locals, url }: RequestEvent) {
	const double = locals.runtime.testIdentity;
	if (double) {
		const options = await double.options().catch((e) => refuse(e));
		return { provider: double.provider, href: null, options: options.map((o) => ({ value: `${o.clientId}/${o.subject}`, label: o.label })) };
	}
	const target = clerk(url);
	if (!target) unconfigured();
	return { provider: 'clerk', href: target!.href, options: [] };
}

export const actions: Actions = {
	default: async ({ request, locals, cookies, url }: RequestEvent) => {
		const double = locals.runtime.testIdentity;
		if (!double) {
			const target = clerk(url, request);
			if (!target) unconfigured();
			// One browser session per origin: a session of the other identity is signed out first, an ambiguous one refused.
			const prepared = await prepareSignIn({ env, request, identity: locals.identity, target: 'client' }).catch((e) => refuse(e));
			for (const name of prepared.clear) cookies.delete(name, { path: '/', secure: url?.protocol === 'https:' });
			if (prepared.action === 'refuse') return fail(409, { message: 'We could not tell which session is yours. It has been cleared; sign in again.' });
			redirect(303, target!.href, { external: [new URL(target!.href).origin] });
		}
		const value = (await request.formData()).get('identity');
		const match = typeof value === 'string' ? IDENTITY.exec(value) : null;
		if (!match) return fail(400, { message: 'Choose a test identity.' });
		const session = await double.signIn({ clientId: id('client', match[1]!), subject: match[2]! }).catch((e) => (codeOf(e) === 'unauthenticated' ? null : refuse(e)));
		if (!session) return fail(400, { message: 'That test identity does not exist.' });
		cookies.set(SESSION_COOKIE, session.sessionId, { path: '/', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', expires: new Date(session.expiresAt) });
		redirect(303, '/cases');
	},
};
