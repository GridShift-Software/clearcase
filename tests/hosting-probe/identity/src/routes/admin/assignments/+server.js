import { error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { auditRow } from '#lib/server/access.js';
import { body, ID, json } from '#lib/server/http.js';

/** Assigns an enrolled member of this client to one case as viewer or editor (a firm admin may assign themselves; that is an explicit, audited grant). */
export async function POST(event) {
	const { locals, request } = event;
	const b = await body(request);
	if (typeof b.subject !== 'string' || !ID.test(String(b.case)) || !['viewer', 'editor'].includes(b.role)) error(400, 'subject, case and role (viewer or editor) are required');
	const known = await env.DB.batch([
		env.DB.prepare("SELECT 1 FROM members WHERE app = 'client' AND subject = ? AND active = 1").bind(b.subject),
		env.DB.prepare('SELECT 1 FROM cases WHERE id = ?').bind(b.case),
	]);
	if (!known[0].results.length || !known[1].results.length) error(404, 'no such member or case');
	await env.DB.batch([
		env.DB.prepare("INSERT INTO assignments (app, subject, case_id, role) VALUES ('client', ?, ?, ?) ON CONFLICT (app, subject, case_id) DO UPDATE SET role = excluded.role").bind(b.subject, b.case, b.role),
		auditRow(locals.access.principal, event, 'firm-admin', b.case, `assign:${b.subject}:${b.role}`),
	]);
	return json({ assigned: { case: b.case, role: b.role } }, { status: 201 });
}

/** Removes an assignment: the member's next request for that case is refused, whatever their session. */
export async function DELETE(event) {
	const { locals, request } = event;
	const b = await body(request);
	if (typeof b.subject !== 'string' || !ID.test(String(b.case))) error(400, 'subject and case are required');
	const [r] = await env.DB.batch([
		env.DB.prepare("DELETE FROM assignments WHERE app = 'client' AND subject = ? AND case_id = ?").bind(b.subject, b.case),
		auditRow(locals.access.principal, event, 'firm-admin', b.case, `unassign:${b.subject}`),
	]);
	return json({ removed: r.meta.changes });
}
