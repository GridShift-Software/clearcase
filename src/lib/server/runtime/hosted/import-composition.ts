import type { AuditSink, Identity, IdentityState, Principal, SessionId } from '../contracts.ts';
import { contractError } from '../errors.ts';
import type { D1 } from './bindings.ts';
import { createCaseAuthorizer, d1GrantRepository, type ClientResourceIdentity } from '../../../tenancy/index.ts';
import { d1CaseDirectory } from '../../../tenancy/case-directory.ts';
import type { CloudR2 } from '../../../storage/cloud/bindings.ts';
import type { StorageBudgets } from '../../../storage/cloud/budgets.ts';
import type { StorageQuotas } from '../../../storage/cloud/quotas.ts';
import type { SubmissionRepository } from '../../../submissions/ports.ts';
import { createHostedCandidateStager } from './candidate-stager.ts';
import { nativeImportBudget } from '../../../results-review/native/budget.ts';
import { d1NativeCandidateRepository } from '../../../results-review/native/repository.ts';
import { submissionSnapshotReader } from '../../../results-review/native/submission-reader.ts';
import type { CandidateAuditRecovery, NativeImportPorts } from '../../../results-review/native/ports.ts';
import { canonicalText } from '../../../case-package/canonical.ts';

/** The request's own case authority: the live identity-provider session, then the explicit grant authorizer. */
export function caseAuthority(a: { identity: Identity; deployment: ClientResourceIdentity; db: D1; audit: AuditSink; now(): Date }) {
	const { identity, deployment, db, audit, now } = a;
	const session = async (s: { principal: Principal; sessionId: SessionId }) => {
		if (identity.kind !== 'verified') throw contractError('unauthenticated');
		if (s.sessionId !== identity.sessionId || s.principal.issuer !== identity.principal.issuer ||
			s.principal.subject !== identity.principal.subject || s.principal.kind !== identity.principal.kind) throw contractError('invalid-session');
		await identity.checkRevocation();
	};
	const cases = d1CaseDirectory({ db, deployment });
	const grants = d1GrantRepository(db);
	const authorizer = () => createCaseAuthorizer({ deployment, grants, cases, audit, now });
	const authorizeOperate: ReturnType<typeof authorizer>['authorizeCapability'] = async (c) => {
		const scoped = { ...c, principal: { ...c.principal } };
		await session(scoped); await authorizer().authorizeCapability(scoped);
	};
	return { session, cases, grants, authorizer, authorizeOperate };
}

/**
 * The operator results-import ports of one request, or null when the trusted import budget is missing or exceeds the
 * stager's own bounds. `historical` delivers only an exact committed candidate envelope whose actor is not this request's.
 */
export function nativeImportPorts(a: {
	clientId: NativeImportPorts['clientId']; identity: Identity; db: D1; bucket: CloudR2; budgets: StorageBudgets; quotas: StorageQuotas;
	importBudget: unknown; authority: ReturnType<typeof caseAuthority>; audit: AuditSink; submissions: Pick<SubmissionRepository, 'list'>;
	historical: CandidateAuditRecovery; requestActor: IdentityState; now(): Date;
}): NativeImportPorts | null {
	const { clientId, identity, budgets, audit, now } = a;
	const importBudget = nativeImportBudget(a.importBudget, { stagerMaxPackageBytes: budgets.maxPackageBytes });
	if (!importBudget || importBudget.maxFiles > budgets.maxPackageFiles || importBudget.maxFileBytes > budgets.maxPackageFileBytes) return null;
	const operate: NonNullable<NativeImportPorts['authorizeOperate']> = (o) => a.authority.authorizeOperate({ ...o, capability: 'operate' });
	const staged = createHostedCandidateStager({ bindings: { db: a.db, bucket: a.bucket },
		clientId, budgets, quotas: a.quotas, identity, authorizeOperate: operate, audit, now });
	const candidates = d1NativeCandidateRepository(a.db);
	return { clientId, budget: importBudget, authorizeOperate: operate,
		submissions: submissionSnapshotReader(a.submissions), stager: staged.stager, packages: staged.packages, repository: candidates, now,
		audit: { append: async (event) => {
			if (canonicalText(event.actor) === canonicalText(a.requestActor)) return audit.append(event);
			// A new session cannot impersonate an old one. Only this exact immutable committed candidate
			// envelope may be delivered historically; ordinary reads/refusals retain the request sink.
			if (event.actor.kind !== 'verified' || event.object.kind !== 'candidate' || !event.object.caseId ||
				!['results.import-candidate', 'results.correct-candidate'].includes(event.action)) throw contractError('invalid-event');
			const intent = await candidates.auditIntent({ clientId, caseId: event.object.caseId, candidateId: event.object.id });
			if (canonicalText(intent.event) !== canonicalText(event)) throw contractError('invalid-event');
			return a.historical.appendCommitted(intent);
		} },
	};
}
