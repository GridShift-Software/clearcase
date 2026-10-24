// The production first-party Clerk IdentityProvider (GRS-113) for runtime/contracts.ts. It answers who is asking and
// nothing more: Clerk holds identities and sessions only, and every case decision goes to the injected authorizer (the
// case-grant and audit owner, GRS-114), whose data lives outside Clerk. No Clerk metadata, role or claim grants a case;
// a staff or Global Admin principal reaches a case only when that authorizer allows it.
//
// One request, in order; the first failure refuses it and nothing is cached across requests:
//   1. at most one credential: an Authorization Bearer token, or the __session cookie, or both only when equal;
//   2. @clerk/backend verifyToken against this deployment's client instance, else the staff instance: signature with
//      that instance's key, exp, nbf, iat, the instance's exact issuer and this deployment's origin as the only
//      authorized party;
//   3. our own claim checks, so a claim the SDK tolerates missing fails closed: sub and sid present, azp present and
//      equal to the origin, sts (when present) active, and a second factor when the MFA flag is on;
//   4. the session's current status from that instance's Backend API: active and owned by sub. checkRevocation() and
//      every authorize() repeat this lookup, so a revoked session is refused while its token is unexpired.
// A refused credential yields an anonymous identity whose checks throw the refusal (unauthenticated or invalid-session,
// a 401). A Clerk fault (keys, JWKS or status lookup unavailable) throws identity-unavailable, retryable, from
// authenticate itself, so the composer refuses the request as unavailable rather than guessing.
import { createClerkClient, verifyToken } from '@clerk/backend';
import type { CaseId, CaseOperation, Identity, IdentityProvider, Principal, SessionId } from '../../server/runtime/contracts.ts';
import { codeOf, contractError } from '../../server/runtime/errors.ts';
import { id } from '../../server/runtime/ids.ts';
import { SESSION_COOKIE } from './session.ts';
import { readClerkIdentityConfig, type ClerkIdentityConfig, type ClerkInstanceConfig } from './config.ts';

/** The case decision GRS-114 owns. Resolves to allow; throws a contract error (forbidden, ...) to refuse. */
export type CaseAuthorizer = (a: { principal: Principal; sessionId: SessionId; caseId: CaseId; operation: CaseOperation }) => Promise<void>;

const BEARER = /^Bearer ([A-Za-z0-9._-]{16,8192})$/;
const TOKEN = /^[A-Za-z0-9._-]{16,8192}$/;
// verifyToken reasons that mean "this token is not good here" (a 401); any other reason is a Clerk fault (a 503).
const TOKEN_REFUSALS = new Set([
	'token-expired', 'token-invalid', 'token-invalid-algorithm', 'token-invalid-authorized-parties', 'token-invalid-issuer',
	'token-invalid-signature', 'token-not-active-yet', 'token-iat-in-the-future', 'jwk-kid-mismatch', 'jwk-remote-missing',
]);

type Refusal = 'unauthenticated' | 'invalid-session';
type Verified = { instance: ClerkInstanceConfig; subject: string; session: string; expiresAt: number };
const unavailable = () => contractError('identity-unavailable', true);

/** The one presented credential, null when none, or 'malformed' (refused as invalid-session). */
export function presentedToken(request: Request): string | null | 'malformed' {
	const header = request.headers.get('authorization');
	const bearer = header === null ? null : (BEARER.exec(header)?.[1] ?? 'malformed');
	let cookie: string | null = null;
	for (const part of (request.headers.get('cookie') ?? '').split(';')) {
		const [name, ...rest] = part.trim().split('=');
		if (name !== SESSION_COOKIE) continue;
		if (cookie !== null) return 'malformed'; // two __session cookies: ambiguous
		const value = rest.join('=');
		cookie = TOKEN.test(value) ? value : 'malformed';
	}
	if (bearer === 'malformed' || cookie === 'malformed') return 'malformed';
	if (bearer !== null && cookie !== null && bearer !== cookie) return 'malformed';
	return bearer ?? cookie;
}

/** The contract's IdentityProvider plus sign-out: revoking the session at the instance that issued it. */
export interface ClerkIdentityProvider extends IdentityProvider {
	signOut(a: { principal: Principal; sessionId: SessionId }): Promise<void>;
}

export function createClerkIdentityProvider(a: { config: ClerkIdentityConfig; authorizeCase: CaseAuthorizer }): ClerkIdentityProvider {
	const { config, authorizeCase } = a;
	if (typeof authorizeCase !== 'function') throw new TypeError('createClerkIdentityProvider needs the case authorizer');
	const backends = new Map(
		[config.client, config.staff].map((i) => [i, createClerkClient({ secretKey: i.secretKey, publishableKey: i.publishableKey, apiUrl: config.apiUrl ?? undefined, telemetry: { disabled: true } })]),
	);

	/** verifyToken against one instance: the payload, 'refused' for a token that is not good here, or a thrown fault. */
	async function verifyWith(token: string, instance: ClerkInstanceConfig): Promise<Record<string, unknown> | 'refused'> {
		try {
			return (await verifyToken(token, {
				...(instance.jwtKey !== null ? { jwtKey: instance.jwtKey } : { secretKey: instance.secretKey, apiUrl: config.apiUrl ?? undefined }),
				issuer: instance.issuer,
				authorizedParties: [config.appOrigin],
			})) as Record<string, unknown>;
		} catch (e) {
			const reason = e instanceof Error && 'reason' in e ? (e as { reason: unknown }).reason : null;
			if (typeof reason === 'string' && TOKEN_REFUSALS.has(reason)) return 'refused';
			throw unavailable();
		}
	}

	async function verify(token: string): Promise<Verified | Refusal> {
		for (const instance of [config.client, config.staff]) {
			const claims = await verifyWith(token, instance);
			if (claims === 'refused') continue;
			const { sub, sid, azp, sts, exp, fva } = claims;
			if (typeof sub !== 'string' || !sub || typeof sid !== 'string' || !sid || typeof exp !== 'number') return 'invalid-session';
			if (azp !== config.appOrigin) return 'invalid-session';
			if (sts !== undefined && sts !== 'active') return 'invalid-session';
			if (config.mfaRequired && !(Array.isArray(fva) && Number.isInteger(fva[1]) && (fva[1] as number) >= 0)) return 'invalid-session';
			return { instance, subject: sub, session: sid, expiresAt: exp * 1000 };
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
		async signOut({ principal, sessionId }) {
			const instance = [config.client, config.staff].find((i) => i.issuer === principal.issuer && i.kind === principal.kind);
			if (!instance) throw contractError('invalid-session');
			try {
				await backends.get(instance)!.sessions.revokeSession(sessionId);
			} catch (e) {
				if (e instanceof Error && 'status' in e && (e as { status: unknown }).status === 404) return; // already gone
				throw unavailable();
			}
		},
		async authenticate({ request }) {
			const token = presentedToken(request);
			if (token === null) return refusedIdentity('unauthenticated');
			if (token === 'malformed') return refusedIdentity('invalid-session');
			const result = await verify(token);
			if (result === 'unauthenticated' || result === 'invalid-session') return refusedIdentity(result);
			const verified: Verified = result;
			const refused = await sessionStands(verified);
			if (refused) return refusedIdentity(refused);
			let sessionId: SessionId;
			try {
				sessionId = id('session', verified.session);
			} catch {
				return refusedIdentity('invalid-session');
			}
			const principal: Principal = Object.freeze({ issuer: verified.instance.issuer, subject: verified.subject, kind: verified.instance.kind });
			async function checkRevocation() {
				const r = await sessionStands(verified);
				if (r) throw contractError(r);
			}
			return {
				kind: 'verified', principal, sessionId, clientId: config.clientId, checkRevocation,
				async authorize(scope) {
					await checkRevocation();
					try {
						await authorizeCase({ principal, sessionId, caseId: scope.caseId, operation: scope.operation });
					} catch (e) {
						// the authorizer's own contract refusal or fault stands; anything else is a fault, never an allow
						throw codeOf(e) !== null ? e : unavailable();
					}
				},
			};
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
	return { ok: true, provider: createClerkIdentityProvider({ config: read.config, authorizeCase: a.authorizeCase }), config: read.config };
}
