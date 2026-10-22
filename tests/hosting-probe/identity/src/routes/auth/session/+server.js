import { json } from '#lib/server/http.js';
import { mfaRequired } from '#lib/server/identity.js';

/** The caller's verified session and this app's membership role (null before enrolment); no case content. */
export function GET({ locals }) {
	const { principal, role } = locals.access;
	return json({ app: principal.app, subject: principal.subject, role, mfaRequired: mfaRequired() });
}
