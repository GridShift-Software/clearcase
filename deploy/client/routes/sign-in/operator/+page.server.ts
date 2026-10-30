import { error, fail, redirect, type Actions, type RequestEvent } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { refuse } from '$lib/server/runtime/hosted/http';
import { clerkSignInTarget, type StaffDevBrowser } from '$lib/auth/clerk/config';
import { applySignInReturnChange, prepareSignIn, signInReturn, signInReturnCookie, staffDevBrowserOf } from '$lib/auth/clerk/flow';

import { appCookieValue, appSessionConfig, revokeAppSession, APP_COOKIE } from '$lib/auth/app-session';
import { readClerkIdentityConfig } from '$lib/auth/clerk/config';

// The per-client operator sign-in (GRS-113): ClearCase staff reach this client's origin through the internal staff Clerk
// instance, on the client's own Worker. There is no staff host and no third Worker. A staff session still reaches a case
// only when the case authorizer (GRS-114) grants it. The hosted-gate profile has no operator sign-in.
// The staff portal returns here, to this exact URL, so the hook takes the staff handshake; a verified staff session then
// goes on to the target the POST kept in its attempt cookie.
const unconfigured = () => error(503, { message: 'No operator sign-in is configured for this deployment.', code: 'identity-unavailable' });
// The page data never carries the dev browser; only the POST's redirect hands the staff one to the portal.
const staff = (devBrowser: StaffDevBrowser | null = null) => clerkSignInTarget(env, 'staff', devBrowser);

export async function load({ locals, url, request, cookies, isDataRequest }: RequestEvent) {
	if (locals.runtime.testIdentity) error(404, { message: 'Not found.' });
	if (locals.identity.kind === 'verified' && locals.identity.principal.kind === 'staff') {
		const back = await signInReturn(env, request, url, 'staff', isDataRequest);
		applySignInReturnChange(cookies, back.change);
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
		if (appCookieValue(request) !== null) {
			const clerk = readClerkIdentityConfig(env);
			const config = clerk.ok ? appSessionConfig(env, clerk.config.client.issuer) : null;
			if (!config) unconfigured();
			await revokeAppSession(config!, request).catch((e) => refuse(e));
			cookies.delete(APP_COOKIE, { path: '/', secure: true });
		}
		const prepared = await prepareSignIn({ env, request, identity: locals.identity, target: 'staff' }).catch((e) => refuse(e));
		for (const name of prepared.clear) cookies.delete(name, { path: '/', secure: url.protocol === 'https:' });
		if (prepared.action === 'refuse') return fail(409, { message: 'We could not tell which session is yours. It has been cleared; sign in again.' });
		const change = await signInReturnCookie(env, 'staff', url.searchParams.get('returnTo'), request);
		if (change) applySignInReturnChange(cookies, change);
		redirect(303, target!.href, { external: [new URL(target!.href).origin] });
	},
};
