// TEST DOUBLE (hosted-gate profile only): see ./services.ts.
import type { AuditEvent, AuditSink, CaseOperation, ClientId, Identity, IdentityState, ResultsVersion, Scope } from '../../contracts.ts';
import { contractError, isDenial } from '../../errors.ts';
import type { D1 } from '../bindings.ts';

const ACTION = /^[a-z][a-z0-9.-]{0,63}$/;

/** Audit events appended to local D1, scoped to the deployment's client. A failed append is audit-unavailable. */
export function d1Audit(a: { db: D1; clientId: ClientId; identity: Identity; now: () => Date }) {
	const actor: IdentityState = a.identity.kind === 'verified' ? { kind: 'verified', principal: a.identity.principal, sessionId: a.identity.sessionId } : { kind: 'anonymous', principal: null, sessionId: null };
	async function write(event: AuditEvent) {
		if (!event.eventId || !ACTION.test(event.action) || !event.object.kind || !event.object.id || new Date(event.at).toISOString() !== event.at || JSON.stringify(event.actor) !== JSON.stringify(actor)) throw contractError('invalid-event');
		await a.db
			.prepare('INSERT INTO audit_event (event_id, client_id, actor, action, object_kind, object_id, case_id, version, outcome, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
			.bind(event.eventId, a.clientId, JSON.stringify(event.actor), event.action, event.object.kind, event.object.id, event.object.caseId, event.version, event.outcome, event.at)
			.run()
			.catch(() => {
				throw contractError('audit-unavailable', true);
			});
	}
	/** Appends a server-built event for this request's actor; throws audit-unavailable when it cannot be persisted. */
	const record = (event: Pick<AuditEvent, 'action' | 'object' | 'version' | 'outcome'>) => write({ eventId: crypto.randomUUID(), actor, ...event, at: a.now().toISOString() });
	/** authorize(), appending a scoped denial event when it refuses; the refusal stands whether or not the append works. */
	async function authorized(scope: Scope, operation: CaseOperation, action: string, version: ResultsVersion | null = null) {
		try {
			await a.identity.authorize({ caseId: scope.caseId, operation });
		} catch (e) {
			if (isDenial(e)) await record({ action, object: { kind: 'case', id: scope.caseId, caseId: scope.caseId }, version, outcome: 'denied' }).catch(() => undefined);
			throw e;
		}
	}
	const sink: AuditSink = {
		async append(event) {
			const copy = structuredClone(event);
			await a.identity.checkRevocation();
			await write(copy);
			return { eventId: copy.eventId };
		},
	};
	return { sink, record, authorized };
}
