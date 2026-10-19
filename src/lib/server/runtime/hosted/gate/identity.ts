// TEST DOUBLE (hosted-gate profile only): see ./services.ts.
import type { CaseOperation, ClientId, Identity, Principal, TestIdentityDouble } from '../../contracts.ts';
import { contractError } from '../../errors.ts';
import { id } from '../../ids.ts';
import type { D1 } from '../bindings.ts';

type SessionRow = { client_id: string; subject: string; kind: 'client' | 'staff'; expires_at: string; revoked: number; issuer: string };
const SESSION_HOURS = 8;
const unavailable = (e: unknown): never => {
	throw e instanceof Error && 'code' in e ? e : contractError('identity-unavailable', true);
};

/**
 * The test identity: a session row in local D1 says who signed in and carries no authority. Every check reads the
 * session, the client membership and the case grant again, so revoking any of them binds a live session at once.
 */
export async function testIdentity(a: { db: D1; clientId: ClientId; presented: string | null; now: () => Date }) {
	const { db, clientId, presented } = a;
	const session = () =>
		presented === null
			? Promise.resolve(null)
			: db.prepare('SELECT s.client_id, s.subject, s.kind, s.expires_at, s.revoked, c.issuer FROM gate_session s JOIN gate_client c ON c.client_id = s.client_id WHERE s.session_id = ?').bind(presented).first<SessionRow>();
	/** The current session, or the refusal that stands in its place. */
	async function current(): Promise<SessionRow> {
		if (presented === null) throw contractError('unauthenticated');
		const s = await session().catch(unavailable);
		if (!s || s.revoked || Date.parse(s.expires_at) <= a.now().getTime()) throw contractError('invalid-session');
		if (s.client_id !== clientId) throw contractError('wrong-client');
		const member = await db.prepare('SELECT 1 AS ok FROM gate_member WHERE client_id = ? AND subject = ?').bind(clientId, s.subject).first().catch(unavailable);
		if (!member) throw contractError('forbidden');
		return s;
	}
	async function authorize(scope: { caseId: string; operation: CaseOperation }) {
		const s = await current();
		const grant = await db
			.prepare('SELECT g.role FROM gate_grant g JOIN gate_case c ON c.client_id = g.client_id AND c.case_id = g.case_id WHERE g.client_id = ? AND g.subject = ? AND g.case_id = ?')
			.bind(clientId, s.subject, scope.caseId)
			.first<{ role: 'viewer' | 'editor' }>()
			.catch(unavailable);
		if (!grant || (scope.operation === 'write-user-work' && grant.role !== 'editor')) throw contractError('forbidden');
	}
	const found = await session().catch(unavailable);
	const methods = { clientId, checkRevocation: async () => void (await current()), authorize };
	const identity: Identity =
		found && presented !== null
			? { ...methods, kind: 'verified', principal: { issuer: found.issuer, subject: found.subject, kind: found.kind } satisfies Principal, sessionId: id('session', presented) }
			: { ...methods, kind: 'anonymous', principal: null, sessionId: null };
	const double: TestIdentityDouble = {
		provider: 'test-identity-double',
		async options() {
			const { results } = await db.prepare('SELECT client_id, subject, label FROM gate_identity ORDER BY client_id, subject').all<{ client_id: string; subject: string; label: string }>().catch(unavailable);
			return results.map((r) => ({ clientId: id('client', r.client_id), subject: r.subject, label: r.label }));
		},
		async signIn(input) {
			const { clientId: client, subject } = { clientId: input.clientId, subject: input.subject };
			const known = await db.prepare('SELECT kind FROM gate_identity WHERE client_id = ? AND subject = ?').bind(client, subject).first<{ kind: 'client' | 'staff' }>().catch(unavailable);
			if (!known) throw contractError('unauthenticated');
			const sessionId = crypto.randomUUID(), expiresAt = new Date(a.now().getTime() + SESSION_HOURS * 3_600_000).toISOString();
			await db.prepare('INSERT INTO gate_session (session_id, client_id, subject, kind, expires_at, revoked) VALUES (?, ?, ?, ?, ?, 0)').bind(sessionId, client, subject, known.kind, expiresAt).run().catch(unavailable);
			return { sessionId: id('session', sessionId), expiresAt };
		},
		async signOut({ sessionId }) {
			await db.prepare('UPDATE gate_session SET revoked = 1 WHERE session_id = ?').bind(sessionId).run().catch(unavailable);
		},
	};
	return { identity, double, current };
}
