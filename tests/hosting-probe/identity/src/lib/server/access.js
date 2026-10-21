// What a verified principal may do (GRS-108), from this app's own D1 and nothing in Clerk. hooks.server.js calls
// `decide` for every request before the route runs; a route reads the result as event.locals.access and scopes every
// read to the URL's case. Every decision on a protected route, allowed or denied, is an audit row written before the
// route runs; when the audit write fails the request is refused (503).
import { env } from 'cloudflare:workers';
import gates from '#lib/gates.json';
import { authenticate, instances, kind } from './identity.js';

/** Which trusted instance a gate verifies against: the staff one for the gates gates.json lists. */
const STAFF_GATES = new Set(gates.staffGates);

/** The gate of this request's route and method: `public`, a protected gate, or a status (404 not served, 405). */
export function gateOf(routeId, method) {
	if (routeId === null) return { status: 404, reason: 'no-route' };
	const app = kind();
	const route = app ? gates[app][routeId] : undefined;
	if (!route) return { status: 404, reason: 'not-served' };
	const gate = route[method === 'HEAD' ? 'GET' : method];
	return gate ? { gate } : { status: 405, reason: 'method-not-allowed' };
}

const now = () => new Date().toISOString();

/** One audit row as a statement, so a route can batch it with the write it records (one D1 transaction). */
export const auditRow = (principal, event, gate, caseId, outcome) =>
	env.DB.prepare('INSERT INTO audit (at, app, subject, action, gate, case_id, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(now(), principal?.app ?? null, principal?.subject ?? null, `${event.request.method} ${event.route.id}`, gate, caseId ?? null, outcome);

export async function audit(principal, event, gate, caseId, outcome) {
	await auditRow(principal, event, gate, caseId, outcome).run();
}

export const member = (p) => env.DB.prepare('SELECT role FROM members WHERE app = ? AND subject = ? AND active = 1').bind(p.app, p.subject).first();

/**
 * The decision for one protected request: `{ access, setCookies }` to let the route run (with the cookies Clerk set
 * while verifying), or `{ status, reason }` (with `handshake` headers for Clerk's redirect) to refuse it.
 */
export async function decide(event, gate) {
	const inst = STAFF_GATES.has(gate) ? instances().staff : instances().own;
	const a = await authenticate(event, inst);
	if (a.handshake) return { status: 307, reason: 'handshake', handshake: a.handshake };
	const caseId = event.params.case ?? null;
	const refuse = async (status, reason, principal = null, clerkReason = null) => {
		await audit(principal, event, gate, caseId, `denied:${reason}`);
		return { status, reason, clerkReason };
	};
	if (a.denied) return refuse(a.denied.status, a.denied.reason, null, a.denied.clerkReason);
	const p = a.principal;
	const m = await member(p);
	const allow = async (extra = {}) => {
		await audit(p, event, gate, caseId, 'allowed');
		return { access: { principal: p, role: m?.role ?? null, ...extra }, setCookies: a.setCookies };
	};
	switch (gate) {
		case 'session':
		case 'staff-session':
			return allow();
		case 'member':
			return m ? allow() : refuse(403, 'not-a-member', p);
		case 'case-read':
		case 'case-write': {
			if (!m) return refuse(403, 'not-a-member', p);
			const assignment = await env.DB.prepare('SELECT role FROM assignments WHERE app = ? AND subject = ? AND case_id = ?').bind(p.app, p.subject, caseId).first();
			if (!assignment) return refuse(404, 'no-case-access', p);
			if (gate === 'case-write' && assignment.role !== 'editor') return refuse(403, 'editor-required', p);
			return allow({ caseId, caseRole: assignment.role });
		}
		case 'firm-admin':
			if (!m) return refuse(403, 'not-a-member', p);
			return m.role === 'firm_admin' ? allow() : refuse(403, 'firm-admin-required', p);
		case 'instance-admin':
			return m?.role === 'instance_admin' ? allow() : refuse(403, 'instance-admin-required', p);
		case 'global-admin':
			return m?.role === 'global_admin' ? allow() : refuse(403, 'global-admin-required', p);
		case 'operator-grant': {
			const grant = await env.DB.prepare('SELECT id FROM operator_grants WHERE app = ? AND subject = ? AND case_id = ? AND revoked_at IS NULL AND expires_at > ?').bind(p.app, p.subject, caseId, now()).first();
			return grant ? allow({ caseId, grant: grant.id }) : refuse(403, 'no-operator-grant', p);
		}
		default:
			return refuse(500, 'unknown-gate', p);
	}
}

const EMAIL = /^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
export const validEmail = (v) => typeof v === 'string' && EMAIL.test(v.toLowerCase()) && v.length <= 254;

/** Records an app invitation for `email` as `role` in this app's D1 (the Clerk invitation only lets them sign up). */
export async function recordInvitation(event, app, email, role) {
	const expires = new Date(Date.now() + 24 * 3600_000).toISOString();
	await env.DB.prepare('INSERT INTO invitations (app, email, role, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
		.bind(app, email.toLowerCase(), role, expires, event.locals.access.principal.subject, now())
		.run();
}

/**
 * Enrols the caller under the one unused, unexpired invitation for their Clerk-verified email in `app` with one of
 * `roles`: one D1 batch marks the invitation used and inserts the member row, so a second accept or a second user finds
 * nothing to use.
 * @returns {Promise<{ status: number, role?: string, reason?: string }>}
 */
export async function acceptInvitation(principal, email, app, roles) {
	if (!email) return { status: 403, reason: 'email-unverified' };
	const existing = await member(principal);
	if (existing) return { status: 409, reason: 'already-a-member' };
	const at = now();
	const placeholders = roles.map(() => '?').join(', ');
	const [claim] = await env.DB.batch([
		env.DB.prepare(`UPDATE invitations SET used_by = ?, used_at = ? WHERE rowid = (SELECT rowid FROM invitations WHERE app = ? AND email = ? AND role IN (${placeholders}) AND used_by IS NULL AND expires_at > ? ORDER BY rowid LIMIT 1) RETURNING role`).bind(principal.subject, at, app, email, ...roles, at),
		env.DB.prepare('INSERT INTO members (app, subject, role, active, joined_at) SELECT ?, ?, role, 1, ? FROM invitations WHERE app = ? AND used_by = ? AND used_at = ?').bind(principal.app, principal.subject, at, app, principal.subject, at),
	]);
	const role = claim.results[0]?.role;
	return role ? { status: 201, role } : { status: 403, reason: 'no-invitation' };
}
