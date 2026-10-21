import { error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { auditRow } from '#lib/server/access.js';
import { body, created, ID } from '#lib/server/http.js';

/** Grants one staff member (an operator, or the Global Admin itself) access to one case's content until it expires: explicit and audited. */
export async function POST(event) {
	const { locals, request } = event;
	const b = await body(request);
	const seconds = Number(b.seconds);
	if (typeof b.subject !== 'string' || !b.subject || !ID.test(String(b.case)) || !Number.isInteger(seconds) || seconds < 1 || seconds > 8 * 3600) error(400, 'subject, case and seconds (1 to 28800) are required');
	if (!(await env.DB.prepare('SELECT 1 FROM cases WHERE id = ?').bind(b.case).first())) error(404, 'no such case');
	const id = crypto.randomUUID();
	const expires = new Date(Date.now() + seconds * 1000).toISOString();
	// the gate's audit row names the route; this one, in the grant's transaction, names the case and the grantee
	await env.DB.batch([
		env.DB.prepare("INSERT INTO operator_grants (id, app, subject, case_id, granted_by, expires_at, created_at) VALUES (?, 'staff', ?, ?, ?, ?, ?)").bind(id, b.subject, b.case, locals.access.principal.subject, expires, new Date().toISOString()),
		auditRow(locals.access.principal, event, 'instance-admin', b.case, `grant:${b.subject}`),
	]);
	return created({ grant: id, case: b.case, expiresAt: expires });
}
