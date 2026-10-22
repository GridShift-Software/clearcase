import { json } from '@sveltejs/kit';
import { acceptInvitation } from '#lib/server/access.js';
import { instances, kind, verifiedEmail } from '#lib/server/identity.js';

/** Enrols the signed-in caller under this app's invitation for their verified email (client: member or firm admin; staff: Global Admin or operator). */
export async function POST({ locals }) {
	const { principal } = locals.access;
	const email = await verifiedEmail(instances().own, principal.subject);
	const app = kind();
	const roles = app === 'client' ? ['member', 'firm_admin'] : ['global_admin', 'operator'];
	const r = await acceptInvitation(principal, email, app, roles);
	return json(r.role ? { role: r.role } : { error: 'denied', reason: r.reason }, { status: r.status, headers: r.reason ? { 'x-probe-denial': r.reason } : {} });
}
