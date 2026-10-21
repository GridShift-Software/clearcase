// Who is asking (GRS-108): the trusted Clerk instances this app accepts, and server-side verification of one request's
// session against one of them. Authorization (what that principal may do) is access.js, from D1 only.
//
// Verification, in order; the first failure denies, and nothing is cached across requests:
//   1. at most one credential: an Authorization Bearer token, or the __session cookie, or both only when equal;
//   2. Clerk's backend SDK (@clerk/backend authenticateRequest): signature against that instance's keys, expiry, nbf,
//      iat and the authorized party (azp) against this app's origin; a cookie request for a document whose token has
//      expired gets Clerk's handshake redirect instead (interrupted-session recovery), and the request that ends a
//      handshake gets Clerk's redirect back to the same URL with the fresh cookies;
//   3. the probe's own claim checks: iss is the instance's issuer, sub and sid are non-empty strings, azp is this app's
//      origin, sts (when present) is active, and fva shows a second factor when AUTH_MFA_REQUIRED is "true";
//   4. the session's current status from that instance's Backend API: active and owned by sub, so a revoked or ended
//      session is refused on its next request even while its token is unexpired. A status lookup that fails is 503.
import { createClerkClient } from '@clerk/backend';
import { env } from 'cloudflare:workers';

/** "client" (a client instance) or "staff" (the internal app), from the deployment, never from the request. Read per call: Kit's build analysis imports this module where no Worker env exists. */
export const kind = () => (env.APP_KIND === 'client' || env.APP_KIND === 'staff' ? env.APP_KIND : null);

/** The Frontend API host a publishable key names (pk_test_ or pk_live_, then base64 of "<host>$"), or null. */
export function frontendApiHost(publishableKey) {
	const m = /^pk_(?:test|live)_([A-Za-z0-9+/=]+)$/.exec(publishableKey ?? '');
	if (!m) return null;
	let decoded;
	try {
		decoded = atob(m[1]);
	} catch {
		return null;
	}
	const host = decoded.endsWith('$') ? decoded.slice(0, -1) : '';
	return /^[a-z0-9][a-z0-9.-]{2,253}$/.test(host) ? host : null;
}

/** The MFA flag (ADR 0008): off unless the deployment sets AUTH_MFA_REQUIRED to exactly "true"; no usage threshold. */
export const mfaRequired = () => env.AUTH_MFA_REQUIRED === 'true';

function instance(label, prefix, origin) {
	const publishableKey = env[`${prefix}PUBLISHABLE_KEY`];
	const secretKey = env[`${prefix}SECRET_KEY`];
	const host = frontendApiHost(publishableKey);
	if (!host || typeof secretKey !== 'string' || !secretKey || typeof origin !== 'string' || !origin) return null;
	const jwtKey = env[`${prefix}JWT_KEY`] || undefined;
	const clerk = createClerkClient({ publishableKey, secretKey, jwtKey, apiUrl: env.CLERK_API_URL || undefined });
	return { label, issuer: `https://${host}`, parties: [origin], clerk };
}

let trusted;
/** The instances this deployment trusts: `own` (the app's Clerk instance) and, on a client app, `staff` (operators). */
export function instances() {
	const k = kind();
	trusted ??=
		k === 'client'
			? { own: instance('client', 'CLERK_', env.APP_ORIGIN), staff: instance('staff', 'STAFF_', env.STAFF_ORIGIN) }
			: k === 'staff'
				? { own: instance('staff', 'CLERK_', env.APP_ORIGIN), staff: null }
				: { own: null, staff: null };
	return trusted;
}

const denied = (status, reason, clerkReason = null) => ({ denied: { status, reason, clerkReason: typeof clerkReason === 'string' && /^[a-z0-9-]{1,64}$/.test(clerkReason) ? clerkReason : null } });

/** Clerk's signed-out reason as the probe's denial reason. */
function signedOut(reason) {
	if (!reason || /missing/.test(reason)) return 'signed-out';
	// a Bearer request past exp gives token-expired; a cookie request that Clerk cannot refresh gives session-token-expired-…
	if (reason === 'token-expired' || /^session-token-expired(-|$)/.test(reason)) return 'token-expired';
	if (reason === 'token-invalid-authorized-parties') return 'wrong-party';
	return 'token-invalid';
}

/**
 * Verifies the request's session against `inst`.
 * @returns {Promise<{ principal: { app: string, subject: string, session: string }, setCookies: string[] } | { handshake: Headers } | { denied: { status: number, reason: string, clerkReason: string | null } }>}
 */
export async function authenticate(event, inst) {
	if (!inst) return denied(503, 'identity-not-configured');
	const header = event.request.headers.get('authorization');
	if (header !== null && !/^Bearer [A-Za-z0-9._-]{16,8192}$/.test(header)) return denied(401, 'credential-malformed');
	const cookie = event.cookies.get('__session');
	if (header !== null && cookie !== undefined && header.slice(7) !== cookie) return denied(401, 'credential-ambiguous');
	let state;
	try {
		state = await inst.clerk.authenticateRequest(event.request, { authorizedParties: inst.parties, acceptsToken: 'session_token' });
	} catch {
		return denied(503, 'identity-unavailable');
	}
	// A development instance resolves a handshake as a signed-in (or signed-out) state that carries Clerk's Location back to
	// the same URL without the handshake parameter, plus the new cookies; follow Clerk's Location in any state.
	if (state.status === 'handshake' || state.headers?.get('location')) return { handshake: state.headers };
	if (state.status !== 'signed-in') return denied(401, signedOut(state.reason), state.reason);
	// pending sessions keep their claims here, so the sts check below refuses them by name instead of as an empty claim set
	const claims = state.toAuth({ treatPendingAsSignedOut: false })?.sessionClaims ?? {};
	if (claims.iss !== inst.issuer) return denied(401, 'wrong-issuer');
	if (typeof claims.sub !== 'string' || !claims.sub || typeof claims.sid !== 'string' || !claims.sid) return denied(401, 'claim-missing');
	if (typeof claims.azp !== 'string' || !inst.parties.includes(claims.azp)) return denied(401, 'wrong-party');
	if (claims.sts !== undefined && claims.sts !== 'active') return denied(401, 'session-pending');
	if (mfaRequired() && !(Array.isArray(claims.fva) && Number.isInteger(claims.fva[1]) && claims.fva[1] >= 0)) return denied(401, 'mfa-required');
	let session;
	try {
		session = await inst.clerk.sessions.getSession(claims.sid);
	} catch (e) {
		return e?.status === 404 ? denied(401, 'session-ended') : denied(503, 'session-status-unavailable');
	}
	if (session?.userId !== claims.sub) return denied(401, 'session-mismatch');
	if (session.status !== 'active') return denied(401, session.status === 'revoked' ? 'session-revoked' : 'session-ended');
	return { principal: { app: inst.label, subject: claims.sub, session: claims.sid }, setCookies: state.headers?.getSetCookie() ?? [] };
}

/** The verified primary email of `subject` in `inst`, for enrolment only (never for authorization), or null. */
export async function verifiedEmail(inst, subject) {
	const user = await inst.clerk.users.getUser(subject);
	const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
	return primary?.verification?.status === 'verified' ? primary.emailAddress.toLowerCase() : null;
}
