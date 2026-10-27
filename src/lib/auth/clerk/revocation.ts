// Revoke-only evidence for a session whose signed token has EXPIRED or is PENDING (GRS-113 supplemental correction).
// Clerk session tokens live about a minute, while the Clerk session behind one stays live at the Frontend API until it is
// revoked, so a sign-out or a cross-kind identity switch that arrives after expiry must still end that session.
//
// This is NOT authentication. It returns no Identity, no Principal and no capability, so nothing here can reach a case,
// a grant or an audit actor; the provider's `authenticate` is untouched and still refuses every expired token. What it
// does prove, offline and with no clock at all, is that the presented token is a genuine Clerk-signed token of one of the
// two pinned instances, so that its `sid` may be revoked, and only at that instance's own Backend API:
//   - the shape gate of session.ts (RS256 only, no key-selection headers, typed claims);
//   - the signature, verified with WebCrypto against the CONFIGURED public key of the instance whose issuer the payload
//     names (the unverified `iss` only chooses between the two configured keys, as handshakeKind already does; a token
//     that names neither issuer, or that the chosen key did not sign, is refused, so a client-signed token claiming the
//     staff issuer fails against the staff key and vice versa);
//   - the signed claims: the exact issuer, this deployment's origin as `azp`, a configured audience, `sts` active or
//     pending when present, `sub` and a well-formed `sid`. A pending session (Clerk: signed in, session tasks such as
//     setup-mfa not yet done) never authenticates here, but finishing its task makes the SAME session active without a
//     new sign-in, so it is revoked like an active one. Clerk signs no token for any other status.
// Time is read once, and only to refuse: a token whose `exp` lies more than MAX_SESSION_LIFETIME_MS in the past names a
// session Clerk has already ended, so it is no evidence and costs no Backend API call (a token without `exp` is no Clerk
// session token). `nbf` and `iat` are not read; time never makes a token an identity here.
// Session ownership is checked by the caller against the instance's Backend API before any revoke (flow.ts).
import type { SessionId } from '../../server/runtime/contracts.ts';
import { contractError } from '../../server/runtime/errors.ts';
import { id } from '../../server/runtime/ids.ts';
import { rsaJwkOf, type ClerkIdentityConfig, type ClerkInstanceConfig } from './config.ts';
import { inspectToken } from './session.ts';

/** What a genuine expired, live or pending token proves for revocation only: the instance, its subject and its session. */
export interface RevocationEvidence {
	readonly instance: ClerkInstanceConfig;
	readonly subject: string;
	readonly sessionId: SessionId;
}

/**
 * The longest a Clerk session can live: Clerk's default maximum session lifetime, 7 days. A session is created before
 * any token it signs, so one whose token expired longer ago than this has ended at Clerk. Both instances must keep this
 * lifetime or a shorter one (identity.md); a longer one there needs this raised, or sign-out would leave its oldest
 * sessions live.
 */
export const MAX_SESSION_LIFETIME_MS = 7 * 86_400_000;

const bytes = (b64url: string): Uint8Array => {
	const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
	return Uint8Array.from(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
};

/**
 * The revoke-only evidence a presented token gives, or null when it is not a genuine token of a pinned instance
 * (forged, key-confused, wrong issuer, unsigned, malformed) or names a session that has certainly ended. Throws
 * identity-unavailable only when a configured key cannot be imported, which is a deployment fault and no verdict on the
 * token.
 */
export async function revocationEvidenceOf(token: string, config: ClerkIdentityConfig): Promise<RevocationEvidence | null> {
	if (!inspectToken(token)) return null;
	const [head, body, sig] = token.split('.') as [string, string, string];
	let claims: Record<string, unknown>;
	try {
		claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes(body))) as Record<string, unknown>;
	} catch {
		return null;
	}
	const instance = [config.client, config.staff].find((i) => i.issuer === claims.iss);
	if (!instance) return null;
	let key: CryptoKey, signature: Uint8Array;
	try {
		key = await crypto.subtle.importKey('jwk', rsaJwkOf(instance.jwtKey), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
	} catch {
		throw contractError('identity-unavailable', true);
	}
	try {
		signature = bytes(sig);
	} catch {
		return null;
	}
	const signed = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature as BufferSource, new TextEncoder().encode(`${head}.${body}`)).catch(() => false);
	if (!signed) return null;
	const { sub, sid, azp, sts, aud, exp } = claims;
	if (typeof sub !== 'string' || !sub || typeof sid !== 'string' || !sid || azp !== config.appOrigin) return null;
	if (config.audience !== null && !(aud === config.audience || (Array.isArray(aud) && aud.includes(config.audience)))) return null;
	if (sts !== undefined && sts !== 'active' && sts !== 'pending') return null;
	if (typeof exp !== 'number' || exp * 1000 + MAX_SESSION_LIFETIME_MS < Date.now()) return null;
	try {
		return Object.freeze({ instance, subject: sub, sessionId: id('session', sid) });
	} catch {
		return null;
	}
}
