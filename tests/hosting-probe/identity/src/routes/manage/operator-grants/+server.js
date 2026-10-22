import { error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { audit, auditRow } from '#lib/server/access.js';
import { body, created, ID } from '#lib/server/http.js';
import { instances } from '#lib/server/identity.js';

/** A Clerk user id as the staff instance issues it. */
const SUBJECT = /^user_[A-Za-z0-9_]{1,64}$/;

/**
 * Grants one staff member (an operator, or the Global Admin itself) access to one case's content until it expires:
 * explicit and audited. The grantee must be a live user of the staff Clerk instance, which is invite-only: a subject
 * that instance does not know, or has banned or locked, gets no grant (404, audited). The staff app's own roster is its
 * D1, which this app cannot read, so removal there does not reach this check (identity.md, "Contract items for GRS-113").
 */
export async function POST(event) {
	const { locals, request } = event;
	const b = await body(request);
	const seconds = Number(b.seconds);
	if (typeof b.subject !== 'string' || !SUBJECT.test(b.subject) || !ID.test(String(b.case)) || !Number.isInteger(seconds) || seconds < 1 || seconds > 8 * 3600) error(400, 'subject, case and seconds (1 to 28800) are required');
	if (!(await env.DB.prepare('SELECT 1 FROM cases WHERE id = ?').bind(b.case).first())) error(404, 'no such case');
	let grantee;
	try {
		grantee = await instances().staff.clerk.users.getUser(b.subject);
	} catch (e) {
		if (e?.status !== 404) error(503, 'the staff identity instance is unavailable');
	}
	if (!grantee || grantee.banned || grantee.locked) {
		await audit(locals.access.principal, event, 'instance-admin', b.case, 'denied:unknown-grantee');
		error(404, 'no such staff user');
	}
	const id = crypto.randomUUID();
	const expires = new Date(Date.now() + seconds * 1000).toISOString();
	// the gate's audit row names the route; this one, in the grant's transaction, names the case and the grantee
	await env.DB.batch([
		env.DB.prepare("INSERT INTO operator_grants (id, app, subject, case_id, granted_by, expires_at, created_at) VALUES (?, 'staff', ?, ?, ?, ?, ?)").bind(id, b.subject, b.case, locals.access.principal.subject, expires, new Date().toISOString()),
		auditRow(locals.access.principal, event, 'instance-admin', b.case, `grant:${b.subject}`),
	]);
	return created({ grant: id, case: b.case, expiresAt: expires });
}
