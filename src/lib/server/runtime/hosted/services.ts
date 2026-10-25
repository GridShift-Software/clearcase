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

type NativeContext = {
	db: D1;
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
		return { db, deployment, audit, settings: Object.freeze(settings) };
	} catch {
		// Never echo a configuration value, provider credential or parser excerpt.
		return null;
	}
}

/** Fresh identity and audit state for this exact request; only immutable deployment configuration is shared. */
export async function hostedServices(request: Request, env: Readonly<Record<string, unknown>>): Promise<Readiness> {
	const b = bindings(env), now = () => new Date();
	const services: RequestServices = createUnavailableServices({ clientId: b.clientId ?? id('client', 'unconfigured'), now });
	services.runtime = { get build() { return buildStamp('production'); }, gate: null, testIdentity: null, now, probe: () => probe(b) };
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
	if (native) services.audit = requestAuditSink({ db: native.db, config: native.audit, requester: stateOf(services.identity), now });
	// Anonymous is a configured identity state: sign-in must remain reachable. Features not yet composed retain their
	// unavailable contracts rather than pretending a missing data adapter is an empty case or a successful write.
	return { ready: true, services };
}
