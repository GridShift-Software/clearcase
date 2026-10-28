// Client requests verify an app session locally and check one KV revocation key.
// Clerk JWTs bootstrap the app session only at /sign-in. Staff retains its Clerk protocol.
// createClerkIdentityProvider without app is the retained SDK adapter seam; the production factory always selects app mode.
import { createClerkClient, verifyToken } from '@clerk/backend';
import type { CaseId, CaseOperation, Identity, IdentityProvider, Principal, SessionId } from '../../server/runtime/contracts.ts';
import { codeOf, contractError } from '../../server/runtime/errors.ts';
import { id } from '../../server/runtime/ids.ts';
import { revokeClerkSession } from './flow.ts';
import { inspectToken, presentedToken } from './session.ts';
import { readClerkIdentityConfig, rsaJwkOf, type ClerkIdentityConfig, type ClerkInstanceConfig } from './config.ts';

import { issuedAfterRevocation, appCookieValue, readAppSession, appSessionConfig, type AppSessionConfig } from '../app-session.ts';
export { inspectToken, presentedToken };

/** The case decision GRS-114 owns. Resolves to allow; throws a contract error (forbidden, ...) to refuse. */
export type CaseAuthorizer = (a: { principal: Principal; sessionId: SessionId; caseId: CaseId; operation: CaseOperation }) => Promise<void>;

// verifyToken reasons that mean the key or configuration is at fault, not the token: a 503. Every other reason is the
// token's own (expired, wrong issuer, bad signature, ...): a 401.
const FAULT_REASONS = new Set(['secret-key-invalid', 'jwk-local-missing', 'jwk-remote-failed-to-load', 'jwk-remote-invalid', 'jwk-failed-to-resolve']);

type Refusal = 'unauthenticated' | 'invalid-session';
type Verified = { instance: ClerkInstanceConfig; subject: string; session: string; expiresAt: number; issuedAt: number; name: string };
const unavailable = () => contractError('identity-unavailable', true);

/** The contract's IdentityProvider plus sign-out: revoking the session at the instance that issued it. */
export interface ClerkIdentityProvider extends IdentityProvider {
	signOut(a: { principal: Principal; sessionId: SessionId }): Promise<void>;
}

const backendsOf = (config: ClerkIdentityConfig) =>
	new Map([config.client, config.staff].map((i) => [i, createClerkClient({ secretKey: i.secretKey, publishableKey: i.publishableKey, apiUrl: config.apiUrl ?? undefined, telemetry: { disabled: true } })]));

export function createClerkIdentityProvider(a: { config: ClerkIdentityConfig; authorizeCase: CaseAuthorizer; app?: AppSessionConfig | null }): ClerkIdentityProvider {
	const { config, authorizeCase } = a;
	if (typeof authorizeCase !== 'function') throw new TypeError('createClerkIdentityProvider needs the case authorizer');
	const backends = backendsOf(config);

	// The configured keys are RSA-2048 PEMs by construction; this proves the platform can also import them, once. A key
	// that cannot be imported is a configuration fault (every request unavailable), never a verdict on one token.
	let keysUsable: Promise<boolean> | null = null;
	const keysImport = () => (keysUsable ??= Promise.all([config.client, config.staff].map((i) => crypto.subtle.importKey('jwk', rsaJwkOf(i.jwtKey), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']))).then(() => true, () => false));

	/** verifyToken against one instance's key: the payload, 'refused' for a token that is not good here, or a thrown fault. */
	async function verifyWith(token: string, instance: ClerkInstanceConfig): Promise<Record<string, unknown> | 'refused'> {
		try {
			return (await verifyToken(token, {
				jwtKey: instance.jwtKey,
				issuer: instance.issuer,
				authorizedParties: [config.appOrigin],
				...(config.audience !== null ? { audience: config.audience } : {}),
			})) as Record<string, unknown>;
		} catch (e) {
			const reason = typeof e === 'object' && e !== null ? (e as { reason?: unknown }).reason : undefined;
			if (typeof reason === 'string' && !FAULT_REASONS.has(reason)) return 'refused';
			throw unavailable();
		}
	}

	async function verify(token: string): Promise<Verified | Refusal> {
		if (!inspectToken(token)) return 'invalid-session';
		if (!(await keysImport())) throw unavailable();
		for (const instance of [config.client, config.staff]) {
			const claims = await verifyWith(token, instance);
			if (claims === 'refused') continue;
			const { sub, sid, azp, sts, exp, fva, aud } = claims;
			if (typeof sub !== 'string' || !sub || typeof sid !== 'string' || !sid || typeof exp !== 'number') return 'invalid-session';
			if (azp !== config.appOrigin) return 'invalid-session';
			// the SDK lets a missing aud through; a configured audience must be present and match
			if (config.audience !== null && !(aud === config.audience || (Array.isArray(aud) && aud.includes(config.audience)))) return 'invalid-session';
			if (sts !== undefined && sts !== 'active') return 'invalid-session';
			if (config.mfaRequired && !(Array.isArray(fva) && Number.isInteger(fva[1]) && (fva[1] as number) >= 0)) return 'invalid-session';
			return { instance, subject: sub, session: sid, expiresAt: exp * 1000, issuedAt: typeof claims.iat === 'number' ? claims.iat * 1000 : NaN, name: typeof claims.name === 'string' ? claims.name.slice(0, 200) : typeof claims.first_name === 'string' ? claims.first_name.slice(0, 200) : sub };
		}
		return 'invalid-session';
	}

	/** The session as the instance's Backend API reports it now: live, or the refusal; a lookup fault throws. */
	async function sessionStands(v: Verified): Promise<Refusal | null> {
		if (Date.now() >= v.expiresAt) return 'invalid-session';
		let session: { status?: unknown; userId?: unknown };
		try {
			session = await backends.get(v.instance)!.sessions.getSession(v.session);
		} catch (e) {
			if (e instanceof Error && 'status' in e && (e as { status: unknown }).status === 404) return 'invalid-session';
			throw unavailable();
		}
		return session?.userId === v.subject && session.status === 'active' ? null : 'invalid-session';
	}

	function refusedIdentity(code: Refusal): Identity {
		const refuse = async (): Promise<never> => { throw contractError(code); };
		return { kind: 'anonymous', principal: null, sessionId: null, clientId: config.clientId, checkRevocation: refuse, authorize: refuse };
	}

	return {
		signOut: ({ principal, sessionId }) => revokeClerkSession({ config, principal, sessionId }),
		async authenticate({ request }) {
			if (a.app === null && appCookieValue(request) !== null) throw unavailable();
			if (a.app) {
				const value = appCookieValue(request);
				if (value !== null) {
					const session = await readAppSession(a.app, value);
					if (!session) return refusedIdentity('invalid-session');
					try { if (!await issuedAfterRevocation(a.app, session.subject, session.iat * 1000)) return refusedIdentity('invalid-session'); }
					catch { throw unavailable(); }
					let sessionId: SessionId;
					try { sessionId = id('session', session.sid); } catch { return refusedIdentity('invalid-session'); }
					const principal: Principal = { issuer: session.issuer, subject: session.subject, kind: session.principalKind };
					const checkRevocation = async () => { if (Date.now() >= session.exp * 1000) throw contractError('invalid-session'); };
					return { kind: 'verified', name: session.name, principal, sessionId, clientId: config.clientId, checkRevocation,
						async authorize(scope) {
							await checkRevocation();
							try { await authorizeCase({ principal, sessionId, ...scope }); } catch (e) { throw codeOf(e) !== null ? e : unavailable(); }
						} } satisfies Identity & { name: string };
				}
			}
			const token = presentedToken(request);
			if (token === null) return refusedIdentity('unauthenticated');
			if (token === 'malformed') return refusedIdentity('invalid-session');
			const result = await verify(token);
			if (result === 'unauthenticated' || result === 'invalid-session') return refusedIdentity(result);
			const verified: Verified = result;
			if (a.app === null && verified.instance.kind === 'client') return refusedIdentity('unauthenticated');
			const bootstrap = a.app && verified.instance.kind === 'client' && new URL(request.url).pathname === '/sign-in';
			if (a.app && verified.instance.kind === 'client' && !bootstrap) return refusedIdentity('unauthenticated');
			if (bootstrap && (!Number.isFinite(verified.issuedAt) || !await issuedAfterRevocation(a.app!, verified.subject, verified.issuedAt))) return refusedIdentity('invalid-session');
			const refused = bootstrap ? null : await sessionStands(verified);
			if (refused) return refusedIdentity(refused);
			let sessionId: SessionId;
			try {
				sessionId = id('session', verified.session);
			} catch {
				return refusedIdentity('invalid-session');
			}
			const principal: Principal = Object.freeze({ issuer: verified.instance.issuer, subject: verified.subject, kind: verified.instance.kind });
			async function checkRevocation() {
				const r = bootstrap ? null : await sessionStands(verified);
				if (r) throw contractError(r);
			}
			return {
				kind: 'verified', name: verified.name, principal, sessionId, clientId: config.clientId, checkRevocation,
				async authorize(scope) {
					await checkRevocation();
					try {
						await authorizeCase({ principal, sessionId, caseId: scope.caseId, operation: scope.operation });
					} catch (e) {
						// the authorizer's own contract refusal or fault stands; anything else is a fault, never an allow
						throw codeOf(e) !== null ? e : unavailable();
					}
				},
			} satisfies Identity & { name: string };
		},
	};
}

/**
 * The factory the hosted composer calls once per request (or once per isolate) with the Worker env and GRS-114's
 * authorizer. Unconfigured, it is unavailable with a reason naming variables only; it never falls back to a double.
 */
export function clerkIdentityProviderFromEnv(env: Readonly<Record<string, unknown>>, a: { authorizeCase: CaseAuthorizer }): { ok: true; provider: ClerkIdentityProvider; config: ClerkIdentityConfig } | { ok: false; reason: string } {
	const read = readClerkIdentityConfig(env);
	if (!read.ok) return read;
	const app = appSessionConfig(env, read.config.client.issuer);
	if (!app && (env.CLEARCASE_SESSION_KEY !== undefined || env.SESSIONS !== undefined)) return { ok: false, reason: 'CLEARCASE_SESSION_KEY and SESSIONS are required' };
	return { ok: true, provider: createClerkIdentityProvider({ config: read.config, authorizeCase: a.authorizeCase, app }), config: read.config };
}
