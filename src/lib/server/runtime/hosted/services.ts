import type { Readiness } from './handle.ts';
import type { Identity, IdentityState, RequestServices } from '../contracts.ts';
import { createUnavailableServices } from '../unavailable.ts';
import { contractError } from '../errors.ts';
import { id } from '../ids.ts';
import { bindings, type Bindings, type D1 } from './bindings.ts';
import { buildStamp, probe } from './runtime.ts';
import { clerkIdentityProviderFromEnv } from '../../../auth/clerk/provider.ts';
import type { ClerkIdentityConfig } from '../../../auth/clerk/config.ts';
import { createCaseAuthorizer, d1GrantRepository, resolveExactDeployment, validateClientManifest, type ClientResourceIdentity } from '../../../tenancy/index.ts';
import { d1CaseDirectory } from '../../../tenancy/case-directory.ts';
import { auditConfig, requestAuditSink, type AuditConfig } from '../../../audit/index.ts';
import { cloudBindings } from '../../../storage/cloud/bindings.ts';
import { storageBudgets } from '../../../storage/cloud/budgets.ts';
import { createCloudResults } from '../../../results/hosted/index.ts';
import { createD1UserWork, d1WorkRevision, userWorkConfig } from '../../../user-work/hosted/index.ts';
import { createUploadAuthorizer, d1UploadGrantReader } from '../../../tenancy/upload-capability.ts';
import { createOriginalIntake } from '../../../storage/cloud/intake.ts';
import { storageQuotas } from '../../../storage/cloud/quotas.ts';
import { d1SubmissionRepository } from '../../../submissions/repository.ts';
import { intakeBudget } from '../../../submissions/budget.ts';
import { bindNativeRequestCompositions } from './compositions.ts';
import { caseAuthority, nativeImportPorts, WORKERS_FREE_REQUEST } from './import-composition.ts';
import { canonicalText } from '../../../case-package/canonical.ts';
import { committedAuditRecovery, type RecoveryD1 } from '../../../audit/recovery.ts';
import { createPublicationMaterialReader } from './publication-material.ts';
import { createPrivatePreview } from './private-preview.ts';
import { hostedValidationPolicy } from './validation-policy.ts';
import { createNativePreviewRenderChecker, type NativePreviewRenderOptions } from '../../../viewer/hosted/native-render-check.ts';
import { compiledPdfAssetPins } from './render-pins.ts';
import { d1PublicationPublisher } from '../../../publication/hosted/d1-publisher.ts';
import { d1PublicationLedger } from '../../../publication/hosted/ledger.ts';
import { d1ReadinessFence } from '../../../publication/hosted/readiness-fence.ts';
import type { PublicationReadinessPorts } from '../../../publication/hosted/readiness.ts';

type NativeContext = {
	db: D1;
	rawDb: RecoveryD1;
	deployment: ClientResourceIdentity;
	audit: AuditConfig;
	settings: Readonly<Record<string, unknown>>;
};
const stateOf = (identity: Identity): IdentityState => identity.kind === 'verified'
	? { kind: 'verified', principal: identity.principal, sessionId: identity.sessionId }
	: { kind: 'anonymous', principal: null, sessionId: null };

/** Deployment configuration only. Missing or mismatched resources never supply an authorizer. */
function nativeContext(env: Readonly<Record<string, unknown>>, b: Bindings, clerk: ClerkIdentityConfig): NativeContext | null {
	try {
		if (!b.DB || typeof env.CLEARCASE_NATIVE_CONFIG !== 'string') return null;
		const value: unknown = JSON.parse(env.CLEARCASE_NATIVE_CONFIG);
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
		const settings = value as Record<string, unknown>;
		if (settings.schema !== 'clearcase.native-runtime/1') return null;
		const manifest = validateClientManifest(settings.manifest);
		const tuple = settings.deployment;
		if (typeof tuple !== 'object' || tuple === null || Array.isArray(tuple)) return null;
		// resolveExactDeployment validates every resource field; none is derived from this request.
		const deployment = resolveExactDeployment(manifest, tuple as Parameters<typeof resolveExactDeployment>[1]);
		if (deployment.clientId !== b.clientId || deployment.clientId !== clerk.clientId ||
			deployment.clientIssuer !== clerk.client.issuer || deployment.staffIssuer !== clerk.staff.issuer ||
			deployment.hostname !== new URL(clerk.appOrigin).hostname) return null;
		const raw = b.DB as D1 & { withSession?: (constraint: 'first-primary') => D1 };
		if (typeof raw.withSession !== 'function') return null;
		const db = raw.withSession('first-primary');
		if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') return null;
		const audit = auditConfig({ clientId: deployment.clientId, trustedIssuers: [deployment.clientIssuer, deployment.staffIssuer], limits: settings.auditLimits });
		return { db, rawDb: raw as RecoveryD1, deployment, audit, settings: Object.freeze(settings) };
	} catch {
		// Never echo a configuration value, provider credential or parser excerpt.
		return null;
	}
}

/** Keeps work running after the response for the invocation that calls it. */
export interface RequestScheduler { waitUntil(work: Promise<void>): void }

/** Fresh identity and audit state for this exact request; only immutable deployment configuration is shared. */
export async function hostedServices(request: Request, env: Readonly<Record<string, unknown>>, scheduler: RequestScheduler | null = null): Promise<Readiness> {
	const b = bindings(env), now = () => new Date();
	const services: RequestServices = createUnavailableServices({ clientId: b.clientId ?? id('client', 'unconfigured'), now });
	let dataReady = false;
	services.runtime = { get build() { return buildStamp('production'); }, gate: null, testIdentity: null, now,
		probe: async () => { const result = await probe(b); return { ...result, ok: result.ok && dataReady }; } };
	let native: NativeContext | null = null;
	const clerk = clerkIdentityProviderFromEnv(env, {
		authorizeCase: async (a) => {
			if (!native) throw contractError('identity-unavailable', true);
			const requester: IdentityState = { kind: 'verified', principal: a.principal, sessionId: a.sessionId };
			const authorizer = createCaseAuthorizer({
				deployment: native.deployment, grants: d1GrantRepository(native.db),
				cases: d1CaseDirectory({ db: native.db, deployment: native.deployment }),
				audit: requestAuditSink({ db: native.db, config: native.audit, requester, now }), now,
			});
			await authorizer.authorizeCase(a);
		},
	});
	if (!clerk.ok) return { ready: false, reason: clerk.reason, services };
	native = nativeContext(env, b, clerk.config);
	try {
		services.identity = await clerk.provider.authenticate({ request });
	} catch {
		return { ready: false, reason: 'the identity provider is unavailable', services };
	}
	if (native) {
		const context = native;
		services.audit = requestAuditSink({ db: native.db, config: native.audit, requester: stateOf(services.identity), now });
		const cloud = cloudBindings(env), budgets = storageBudgets(native.settings.storageBudgets);
		if (cloud && budgets) {
			try {
				const config = userWorkConfig({ clientId: clerk.config.clientId, limits: native.settings.userWorkLimits });
				const results = createCloudResults({
					bindings: { db: native.db, bucket: cloud.bucket }, clientId: clerk.config.clientId, budgets,
					identity: services.identity, stateRevision: d1WorkRevision({ db: native.db, config }), now,
					record: async (event) => {
						await services.audit.append({ ...event, eventId: crypto.randomUUID(), actor: stateOf(services.identity), at: now().toISOString() });
					},
					viewerRoute: (asset) => asset.kind === 'original'
						? `/cases/${encodeURIComponent(asset.caseId)}/originals/${encodeURIComponent(asset.assetId)}/view` : null,
				});
				const work = createD1UserWork({ db: native.db, config, identity: services.identity, audit: services.audit, store: results.store, now, tableDefinitions: null });
				services.store = results.store; services.assets = results.assets; services.userWork = work;
				const identity = services.identity;
				const authority = caseAuthority({ identity, deployment: context.deployment, db: context.db, audit: services.audit, now });
				const { session, cases, grants, authorizer, authorizeOperate } = authority;
				const upload = createUploadAuthorizer({ deployment: context.deployment, grants,
					uploads: d1UploadGrantReader(context.db, context.deployment), cases, session, audit: services.audit, now });
				const authorizeUpload: NonNullable<typeof upload> = async (a) => {
					const scoped = { ...a, principal: { ...a.principal } };
					await session(scoped); await upload!(scoped);
				};
				const quotas = storageQuotas(context.settings.storageQuotas);
				const budget = intakeBudget(context.settings.intakeBudget, { maxOriginalBytes: budgets.maxOriginalBytes });
				if (quotas && budget && upload) {
					const originals = createOriginalIntake({ bindings: { db: context.db, bucket: cloud.bucket },
						clientId: clerk.config.clientId, budgets, quotas, now, authorize: async (mutation) => {
							if (identity.kind !== 'verified') throw contractError('unauthenticated');
							if (mutation.capability !== 'original.upload' || mutation.clientId !== clerk.config.clientId) throw contractError('forbidden');
							await authorizeUpload({ principal: identity.principal, sessionId: identity.sessionId, clientId: mutation.clientId, caseId: mutation.caseId });
						} });
					const repository = d1SubmissionRepository(context.db);
					const historical = committedAuditRecovery({ db: context.rawDb, config: context.audit, now });
					const requestActor = structuredClone(stateOf(identity));
					if (requestActor.kind === 'verified') Object.freeze(requestActor.principal);
					Object.freeze(requestActor);
					const imports = nativeImportPorts({ clientId: clerk.config.clientId, identity, db: context.db, bucket: cloud.bucket, budgets, quotas,
						importBudget: context.settings.importBudget, authority, audit: services.audit,
						historical: historical.candidate, requestActor, requestBudget: WORKERS_FREE_REQUEST, now });
					const validationLimits = hostedValidationPolicy(budgets);
					const browserBinding = env.BROWSER;
					const assetsBinding = env.ASSETS as { fetch?: (request: Request) => Promise<Response> } | undefined;
					const renderBudget = context.settings.nativeRenderBudget;
					const renderChecker = await createNativePreviewRenderChecker({
						db: context.rawDb, clientId: clerk.config.clientId,
						browser: browserBinding && typeof (browserBinding as { fetch?: unknown }).fetch === 'function'
							? browserBinding as NativePreviewRenderOptions['browser'] : null,
						assets: assetsBinding && typeof assetsBinding.fetch === 'function'
							? { fetch: (assetRequest) => assetsBinding.fetch!(assetRequest) } : null,
						appOrigin: clerk.config.appOrigin, pins: compiledPdfAssetPins(),
						// The factory validates all six finite bounds, ceilings and their relation. No budget defaults.
						budget: renderBudget && typeof renderBudget === 'object' && !Array.isArray(renderBudget)
							? renderBudget as NativePreviewRenderOptions['budget'] : null,
						now,
					});
					const material = validationLimits && createPublicationMaterialReader({ db: context.rawDb, bucket: cloud.bucket,
						clientId: clerk.config.clientId, identity, audit: services.audit, storageBudgets: budgets,
						// Revalidate with the importer's complete effective parser + explicit resource policy.
						validationLimits,
						// Missing binding, compiled pins or finite policy leaves genuine required previews pending.
						renderChecker, now });
					const publication: PublicationReadinessPorts | null = material ? {
						clientId: clerk.config.clientId, candidates: material, now,
						authorize: async (a) => {
							if (a.principal.kind !== 'staff' || a.capability !== 'publish') throw contractError('forbidden');
							await session(a);
							await authorizer().authorizeCapability(a);
						},
						publisher: d1PublicationPublisher({ db: context.rawDb, clientId: clerk.config.clientId, checkSession: async (a) => {
							if (a.clientId !== clerk.config.clientId || a.capability !== 'publish' || a.principal.kind !== 'staff') throw contractError('forbidden');
							await session(a);
						} }),
						ledger: d1PublicationLedger(context.db),
						readinessFence: d1ReadinessFence({ db: context.rawDb, clientId: clerk.config.clientId }),
						audit: { append: (event) => canonicalText(event.actor) === canonicalText(requestActor)
							? services.audit.append(event)
							: historical.publication.append(event) },
					} : null;
					// The operator's private candidate preview: audited operate and read-preview admission, the operate grant as
					// SQL in its final fence, over the same primary session. It shares no permit with the import or readiness.
					const preview = createPrivatePreview({ clientId: clerk.config.clientId, identity, db: context.db, audit: services.audit, now,
						authorizeOperate: (o) => authorizeOperate({ ...o, capability: 'operate' }), operateCondition: (o) => authority.operate.condition(o) });
					bindNativeRequestCompositions(request, {
						intake: { clientId: clerk.config.clientId, budget, authorizeUpload, originals, repository, now },
						downloads: { clientId: clerk.config.clientId, authorizeOperate, repository, assets: results.assets, audit: services.audit, now,
							...(scheduler ? { waitUntil: (work: Promise<void>) => scheduler.waitUntil(work) } : {}) },
						imports, publication, preview,
					});
					dataReady = true;
				}
			} catch {
				// A malformed trusted budget/configuration never supplies partial or unbounded data adapters.
			}
		}
	}
	// Anonymous is a configured identity state: sign-in must remain reachable. Features not yet composed retain their
	// unavailable contracts rather than pretending a missing data adapter is an empty case or a successful write.
	return { ready: true, services };
}
