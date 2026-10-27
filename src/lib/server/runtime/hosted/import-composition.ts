import type { AuditSink, Identity, IdentityState, Principal, SessionId } from '../contracts.ts';
import { contractError } from '../errors.ts';
import type { D1 } from './bindings.ts';
import { createCaseAuthorizer, d1GrantRepository, type ClientResourceIdentity } from '../../../tenancy/index.ts';
import { d1CaseDirectory } from '../../../tenancy/case-directory.ts';
import { d1OperateObservation } from '../../../tenancy/operate-observation.ts';
import type { CloudR2 } from '../../../storage/cloud/bindings.ts';
import type { StorageBudgets } from '../../../storage/cloud/budgets.ts';
import type { StorageQuotas } from '../../../storage/cloud/quotas.ts';
import { createHostedCandidateStager } from './candidate-stager.ts';
import { nativeImportBudget, type RequestBudget } from '../../../results-review/native/budget.ts';
import { d1NativeCandidateRepository } from '../../../results-review/native/repository.ts';
import { d1StagingLedger } from '../../../results-review/native/staging/ledger.ts';
import { r2StagingStore } from '../../../results-review/native/staging/store.ts';
import { submissionSnapshotReader } from '../../../results-review/native/submission-reader.ts';
import type { CandidateAuditRecovery, NativeImportPorts } from '../../../results-review/native/ports.ts';
import { canonicalText } from '../../../case-package/canonical.ts';

/** Workers Free: 50 D1 queries and 50 subrequests per invocation, five of each kept as headroom. */
export const WORKERS_FREE_REQUEST: Pick<RequestBudget, 'd1' | 'external'> = Object.freeze({ d1: 45, external: 45 });
/**
 * Workers Paid (ADR-0013), from Cloudflare's documentation read on 27 October 2026. Workers limits
 * (developers.cloudflare.com/workers/platform/limits/): 10,000 subrequests per invocation, and "a subrequest is any request a Worker makes
 * using the Fetch API or to Cloudflare services like R2, KV, or D1", so R2 and D1 binding calls count; a separate "subrequests to
 * internal services" row is the configured limit, 10,000 by default. D1 limits (developers.cloudflare.com/d1/platform/limits/): 1,000
 * queries per invocation on Paid, a batch counting as one. `d1` keeps 10% of those 1,000 as headroom. `external` counts the identity
 * provider's session checks, which are fetches: it is held under half of the 10,000 so the D1 and R2 calls that share the limit have room
 * even if it is one pool. The import and staging routes use this; every other route has its own budget.
 */
export const WORKERS_PAID_REQUEST: Pick<RequestBudget, 'd1' | 'external'> = Object.freeze({ d1: 900, external: 4500 });

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
	// The operate grant as it stands now, unaudited: the request's later boundaries, after authorizeOperate admitted it.
	const operate = d1OperateObservation({ db, deployment, now });
	return { session, cases, grants, authorizer, authorizeOperate, operate };
}

/**
 * The operator results-import ports of one request, or null when the trusted import budget is missing or exceeds the
 * stager's own bounds. `historical` delivers only an exact committed candidate envelope whose actor is not this request's.
 */
export function nativeImportPorts(a: {
	clientId: NativeImportPorts['clientId']; identity: Identity; db: D1; bucket: CloudR2; budgets: StorageBudgets; quotas: StorageQuotas;
	importBudget: unknown; authority: ReturnType<typeof caseAuthority>; audit: AuditSink;
	historical: CandidateAuditRecovery; requestActor: IdentityState; now(): Date;
	/** The plan's per-request call limit; null composes no limit (a plan whose limits this import cannot reach). */
	requestBudget: Pick<RequestBudget, 'd1' | 'external'> | null;
	/** Bounds, clock and lease ids of the stepped stager; the defaults are Workers Paid's. */
	steps?: NonNullable<Parameters<typeof createHostedCandidateStager>[0]['steps']>;
}): NativeImportPorts | null {
	const { clientId, identity, budgets, audit, now } = a;
	const importBudget = nativeImportBudget(a.importBudget, { stagerMaxPackageBytes: budgets.maxPackageBytes });
	if (!importBudget || importBudget.maxFiles > budgets.maxPackageFiles || importBudget.maxFileBytes > budgets.maxPackageFileBytes) return null;
	const operate: NonNullable<NativeImportPorts['authorizeOperate']> = (o) => a.authority.authorizeOperate({ ...o, capability: 'operate' });
	const observeOperate: NonNullable<NativeImportPorts['observeOperate']> = (o) => a.authority.operate.observe(o);
	const operateCondition: NonNullable<NativeImportPorts['operateCondition']> = (o) => a.authority.operate.condition(o);
	const staged = createHostedCandidateStager({ bindings: { db: a.db, bucket: a.bucket },
		clientId, budgets, quotas: a.quotas, identity, authorizeOperate: observeOperate, operateCondition, requestBudget: a.requestBudget, audit, now, ...(a.steps ? { steps: a.steps } : {}) });
	const candidates = d1NativeCandidateRepository(a.db);
	// The chunked import: progress in the client's D1 and verified bytes in its private bucket, under the same budget and operator fences.
	const staging = { ledger: d1StagingLedger(a.db, { rowsPerBatch: budgets.maxRowsPerBatch }), store: r2StagingStore(a.bucket, { maxBytes: importBudget.maxFileBytes }), rowsPerBatch: budgets.maxRowsPerBatch };
	return { clientId, budget: importBudget, authorizeOperate: operate, observeOperate, operateCondition, staging, stepped: staged.stepped,
		requestBudget: a.requestBudget && { ...a.requestBudget, rowsPerBatch: budgets.maxRowsPerBatch },
		submissions: submissionSnapshotReader(a.db), stager: staged.stager, packages: staged.packages, repository: candidates, now,
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
