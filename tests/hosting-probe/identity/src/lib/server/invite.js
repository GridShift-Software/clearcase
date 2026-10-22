// Invitations (GRS-108): a Clerk invitation lets the address sign up to that Clerk instance, which is invite-only
// (restricted); the app invitation in D1 says what the person becomes here. Neither carries a case grant, and the Clerk
// invitation carries no metadata.
import { error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { recordInvitation, validEmail } from './access.js';
import { body, created } from './http.js';

/**
 * Invites the email in the request body as `role` of `app` through `inst`. The probe creates the Clerk invitation with
 * notify off and returns its link to the inviter; the hosted app lets Clerk send it (GRS-113).
 */
export async function invite(event, inst, app, role) {
	const { email } = await body(event.request);
	if (!validEmail(email)) error(400, 'a valid email is required');
	let invitation;
	try {
		invitation = await inst.clerk.invitations.createInvitation({ emailAddress: email, notify: false, ignoreExisting: true, redirectUrl: `${env.APP_ORIGIN}/login` });
	} catch {
		error(502, 'Clerk refused the invitation');
	}
	await recordInvitation(event, app, email, role);
	return created({ role, url: invitation.url });
}
