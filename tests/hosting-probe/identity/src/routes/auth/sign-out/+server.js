import { error } from '@sveltejs/kit';
import { json } from '#lib/server/http.js';
import { instances } from '#lib/server/identity.js';

/** Ends the caller's session in Clerk, so its token is refused on the next request even before it expires. */
export async function POST({ locals }) {
	try {
		await instances().own.clerk.sessions.revokeSession(locals.access.principal.session);
	} catch {
		error(502, 'the session could not be revoked');
	}
	return json({ signedOut: true });
}
