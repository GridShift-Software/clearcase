import { error, fail, redirect, type Actions, type RequestEvent } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { refuse } from '$lib/server/runtime/hosted/http';
import { clerkSignInTarget, type StaffDevBrowser } from '$lib/auth/clerk/config';
import { prepareSignIn, signInReturn, signInReturnCookie, staffDevBrowserOf } from '$lib/auth/clerk/flow';

// The per-client operator sign-in (GRS-113): ClearCase staff reach this client's origin through the internal staff Clerk
// instance, on the client's own Worker. There is no staff host and no third Worker. A staff session still reaches a case
// only when the case authorizer (GRS-114) grants it. The hosted-gate profile has no operator sign-in.
// The staff portal returns here, to this exact URL, so the hook takes the staff handshake; a verified staff session then
// goes on to the target the POST kept in its state cookie.
const unconfigured = () => error(503, { message: 'No operator sign-in is configured for this deployment.', code: 'identity-unavailable' });
// The page data never carries the dev browser; only the POST's redirect hands the staff one to the portal.
const staff = (devBrowser: StaffDevBrowser | null = null) => clerkSignInTarget(env, 'staff', devBrowser);

export async function load({ locals, url, request, cookies }: RequestEvent) {
	if (locals.runtime.testIdentity) error(404, { message: 'Not found.' });
	if (locals.identity.kind === 'verified' && locals.identity.principal.kind === 'staff') {
		const back = await signInReturn(env, request, url, 'staff');
		cookies.delete(back.clear, { path: '/', secure: true });
		redirect(303, back.location);
	}
	const target = staff();
	if (!target) unconfigured();
	return { provider: 'clerk-staff', href: target!.href, options: [] };
}

export const actions: Actions = {
	default: async ({ request, locals, cookies, url }: RequestEvent) => {
		if (locals.runtime.testIdentity) error(404, { message: 'Not found.' });
		const target = staff(await staffDevBrowserOf(request, env));
		if (!target) unconfigured();
		const prepared = await prepareSignIn({ env, request, identity: locals.identity, target: 'staff' }).catch((e) => refuse(e));
		for (const name of prepared.clear) cookies.delete(name, { path: '/', secure: url.protocol === 'https:' });
		if (prepared.action === 'refuse') return fail(409, { message: 'We could not tell which session is yours. It has been cleared; sign in again.' });
		const state = await signInReturnCookie(env, 'staff', url.searchParams.get('returnTo'));
		if (state) cookies.set(state.name, state.value, state.options);
		redirect(303, target!.href, { external: [new URL(target!.href).origin] });
	},
};
