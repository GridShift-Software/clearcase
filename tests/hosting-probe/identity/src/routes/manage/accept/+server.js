import { json } from '@sveltejs/kit';
import { acceptInvitation } from '#lib/server/access.js';
import { instances, verifiedEmail } from '#lib/server/identity.js';

/** A Global Admin (a staff session) takes up this client instance's provisioning invitation and becomes its instance admin. */
export async function POST({ locals }) {
	const { principal } = locals.access;
	const r = await acceptInvitation(principal, await verifiedEmail(instances().staff, principal.subject), 'staff', ['instance_admin']);
	return json(r.role ? { role: r.role } : { error: 'denied', reason: r.reason }, { status: r.status, headers: r.reason ? { 'x-probe-denial': r.reason } : {} });
}
