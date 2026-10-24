import { error, fail, redirect, type Actions, type RequestEvent } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { refuse } from '$lib/server/runtime/hosted/http';
import { clerkSignInTarget } from '$lib/auth/clerk/config';
import { prepareSignIn, safeReturnTo } from '$lib/auth/clerk/flow';

// The per-client operator sign-in (GRS-113): ClearCase staff reach this client's origin through the internal staff Clerk
// instance, on the client's own Worker. There is no staff host and no third Worker. A staff session still reaches a case
// only when the case authorizer (GRS-114) grants it. The hosted-gate profile has no operator sign-in.
const unconfigured = () => error(503, { message: 'No operator sign-in is configured for this deployment.', code: 'identity-unavailable' });
const staff = (url?: URL) => clerkSignInTarget(env, safeReturnTo(url?.searchParams.get('returnTo')), 'staff');

export async function load({ locals, url }: RequestEvent) {
	if (locals.runtime.testIdentity) error(404, { message: 'Not found.' });
	const target = staff(url);
	if (!target) unconfigured();
	return { provider: 'clerk-staff', href: target!.href, options: [] };
}

export const actions: Actions = {
	default: async ({ request, locals, cookies, url }: RequestEvent) => {
		if (locals.runtime.testIdentity) error(404, { message: 'Not found.' });
		const target = staff(url);
		if (!target) unconfigured();
		const prepared = await prepareSignIn({ env, request, identity: locals.identity, target: 'staff' }).catch((e) => refuse(e));
		for (const name of prepared.clear) cookies.delete(name, { path: '/', secure: url.protocol === 'https:' });
		if (prepared.action === 'refuse') return fail(409, { message: 'We could not tell which session is yours. It has been cleared; sign in again.' });
		redirect(303, target!.href, { external: [new URL(target!.href).origin] });
	},
};
