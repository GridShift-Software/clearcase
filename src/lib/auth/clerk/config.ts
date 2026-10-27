// The Clerk configuration of one hosted client deployment (GRS-113, ADR-0007/0008). It names two separate Clerk
// applications: this client's own instance (its firm's users) and the internal staff instance (operators, the Global
// Admin), each with its own keys and issuer. Everything comes from the deployment's env, never from a request.
//
// This module is pure: no Clerk SDK, no network, no secret value in any result or message. A missing or malformed
// value makes the whole configuration unavailable (fail closed); the reason names the variables, never their values.
import type { ClientId } from '../../server/runtime/contracts.ts';
import { id } from '../../server/runtime/ids.ts';

export type InstanceKind = 'client' | 'staff';
export interface ClerkInstanceConfig {
	readonly kind: InstanceKind;
	/** The token issuer this instance signs as: https:// and the Frontend API host its publishable key names. */
	readonly issuer: string;
	readonly publishableKey: string;
	readonly secretKey: string;
	/**
	 * The instance's RSA-2048 public key (single-line PEM) every session token is verified with. Required: there is no
	 * JWKS fallback, so an unauthenticated unknown kid can never make the Worker call Clerk (GRS-113 review M2).
	 */
	readonly jwtKey: string;
}
export interface ClerkIdentityConfig {
	/** The one client this deployment serves (CLEARCASE_CLIENT_ID). */
	readonly clientId: ClientId;
	/** This deployment's origin: the only authorized party (azp) a session token may name. */
	readonly appOrigin: string;
	readonly client: ClerkInstanceConfig;
	readonly staff: ClerkInstanceConfig;
	/** Clerk's Backend API base URL, or null for the SDK's own default. */
	readonly apiUrl: string | null;
	/** ADR-0008: MFA sits behind an initially-off flag; only the exact string "true" turns it on. */
	readonly mfaRequired: boolean;
	/** Where the sign-in page sends a signed-out client user (the client instance's sign-in page), or null. */
	readonly signInUrl: string | null;
	/** The staff instance's sign-in page for the per-client operator route, or null (the operator route stays 503). */
	readonly staffSignInUrl: string | null;
	/** When set, a session token must carry exactly this audience (Clerk session tokens carry none by default), else null. */
	readonly audience: string | null;
}
declare const checkedStaffDevBrowser: unique symbol;
/**
 * A `__clerk_db_jwt` value whose tie verified for one app, client and staff instance (flow.ts tiedDevBrowser, the only
 * place that makes one), the only dev browser the staff portal takes, and only in that scope.
 */
export interface StaffDevBrowser {
	readonly [checkedStaffDevBrowser]: true;
	readonly instance: 'staff';
	readonly value: string;
	readonly appOrigin: string;
	readonly clientId: ClientId;
	readonly issuer: string;
}
export type ConfigResult = { ok: true; config: ClerkIdentityConfig } | { ok: false; reason: string };

/** The variables a deployment sets; secrets are Worker secrets, the rest plain vars. */
export const CLERK_ENV = {
	clientId: 'CLEARCASE_CLIENT_ID',
	appOrigin: 'CLEARCASE_APP_ORIGIN',
	client: { publishableKey: 'CLERK_CLIENT_PUBLISHABLE_KEY', secretKey: 'CLERK_CLIENT_SECRET_KEY', jwtKey: 'CLERK_CLIENT_JWT_KEY' },
	staff: { publishableKey: 'CLERK_STAFF_PUBLISHABLE_KEY', secretKey: 'CLERK_STAFF_SECRET_KEY', jwtKey: 'CLERK_STAFF_JWT_KEY' },
	apiUrl: 'CLERK_API_URL',
	mfaRequired: 'AUTH_MFA_REQUIRED',
	signInUrl: 'CLERK_CLIENT_SIGN_IN_URL',
	staffSignInUrl: 'CLERK_STAFF_SIGN_IN_URL',
	audience: 'CLERK_SESSION_AUDIENCE',
} as const;

const CLIENT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PUBLISHABLE = /^pk_(test|live)_([A-Za-z0-9+/=]{4,512})$/;
const SECRET = /^sk_(test|live)_[A-Za-z0-9]{8,256}$/;
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const PEM = /^-----BEGIN PUBLIC KEY-----[A-Za-z0-9+/=\s]{64,4096}-----END PUBLIC KEY-----$/;
const AUDIENCE = /^[A-Za-z0-9._:/-]{1,200}$/;
const DEV_BROWSER = /^[A-Za-z0-9._-]{16,4096}$/;
// @clerk/backend 3.26.0 loads a PEM key by deleting this exact RSA-2048 SPKI prefix and the exponent suffix (AQAB) and
// taking the rest as the modulus. Any other key (EC, RSA of another size, exponent) would turn every token into an
// SDK failure, so the configuration refuses it up front instead of per request.
const SPKI_PREFIX = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA';
const SPKI_SUFFIX = 'IDAQAB';
const SPKI_LENGTH = 392;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The Frontend API host a publishable key names (pk_test_ or pk_live_, then base64 of "<host>$"), or null. */
export function frontendApiHost(publishableKey: unknown): string | null {
	const m = typeof publishableKey === 'string' ? PUBLISHABLE.exec(publishableKey) : null;
	if (!m) return null;
	let decoded: string;
	try {
		decoded = atob(m[2]!);
	} catch {
		return null;
	}
	const host = decoded.endsWith('$') ? decoded.slice(0, -1) : '';
	return HOST.test(host) && host.length <= 253 ? host : null;
}

/**
 * The single-line PEM of an RSA-2048 (e=65537) public key, or null for anything else. Newlines and spaces inside the
 * body are removed, so the SDK sees one canonical form.
 */
export function normalizeRsaPublicKey(value: unknown): string | null {
	if (typeof value !== 'string' || !PEM.test(value.trim())) return null;
	const body = value.trim().replace(/^-----BEGIN PUBLIC KEY-----/, '').replace(/-----END PUBLIC KEY-----$/, '').replace(/\s/g, '');
	if (body.length !== SPKI_LENGTH || !body.startsWith(SPKI_PREFIX) || !body.endsWith(SPKI_SUFFIX) || !/^[A-Za-z0-9+/]+$/.test(body)) return null;
	return `-----BEGIN PUBLIC KEY-----${body}-----END PUBLIC KEY-----`;
}
/** The RSA public JWK exactly as the SDK derives it from a normalized PEM, for a usability probe. */
export function rsaJwkOf(pem: string): { kty: 'RSA'; alg: 'RS256'; n: string; e: 'AQAB' } {
	const n = pem.replace('-----BEGIN PUBLIC KEY-----', '').replace('-----END PUBLIC KEY-----', '').replace(SPKI_PREFIX, '').replace(SPKI_SUFFIX, '').replace(/\+/g, '-').replace(/\//g, '_');
	return { kty: 'RSA', alg: 'RS256', n, e: 'AQAB' };
}

/** An origin (scheme, host, port; no path) that is https, or http on loopback only (local workerd). */
function origin(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	let u: URL;
	try {
		u = new URL(value);
	} catch {
		return null;
	}
	const secure = u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
	return secure && !u.username && !u.password && u.origin === value.replace(/\/$/, '') ? u.origin : null;
}
/** An absolute https URL (http on loopback only) with no credentials or fragment. */
function url(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	try {
		const u = new URL(value);
		const secure = u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
		return secure && !u.username && !u.password && !u.hash ? u.href : null;
	} catch {
		return null;
	}
}

function instance(env: Readonly<Record<string, unknown>>, kind: InstanceKind, missing: string[], requireKey: boolean): ClerkInstanceConfig | null {
	const names = CLERK_ENV[kind];
	const publishableKey = env[names.publishableKey], secretKey = env[names.secretKey], jwtKey = env[names.jwtKey];
	const host = frontendApiHost(publishableKey);
	const pkMode = typeof publishableKey === 'string' ? PUBLISHABLE.exec(publishableKey)?.[1] : undefined;
	const skMode = typeof secretKey === 'string' ? SECRET.exec(secretKey)?.[1] : undefined;
	if (!host) missing.push(names.publishableKey);
	if (!skMode) missing.push(names.secretKey);
	else if (pkMode && pkMode !== skMode) missing.push(`${names.secretKey} (instance mode differs from ${names.publishableKey})`);
	const absent = jwtKey === undefined || jwtKey === '';
	const pem = absent ? null : normalizeRsaPublicKey(jwtKey);
	if (pem === null && (requireKey || !absent)) missing.push(names.jwtKey);
	if (!host || !skMode || pkMode !== skMode || (pem === null && requireKey) || (pem === null && !absent)) return null;
	return { kind, issuer: `https://${host}`, publishableKey: publishableKey as string, secretKey: secretKey as string, jwtKey: pem ?? '' };
}

/**
 * Reads this deployment's Clerk configuration. Unavailable unless every required value is present and well formed
 * (both instances' RSA-2048 JWT keys included), and the client and staff instances are distinct applications (different
 * issuer, publishable and secret key). `keys: 'optional'` is for the public sign-in page only, which verifies nothing:
 * a JWT key that is present must still be valid, and the provider factory never uses that mode.
 */
export function readClerkIdentityConfig(env: Readonly<Record<string, unknown>>, options: { keys?: 'required' | 'optional' } = {}): ConfigResult {
	const requireKey = options.keys !== 'optional';
	const missing: string[] = [];
	const client = typeof env[CLERK_ENV.clientId] === 'string' && CLIENT_ID.test(env[CLERK_ENV.clientId] as string) ? id('client', env[CLERK_ENV.clientId] as string) : null;
	if (!client) missing.push(CLERK_ENV.clientId);
	const appOrigin = origin(env[CLERK_ENV.appOrigin]);
	if (!appOrigin) missing.push(CLERK_ENV.appOrigin);
	const clientInstance = instance(env, 'client', missing, requireKey), staffInstance = instance(env, 'staff', missing, requireKey);
	const rawApi = env[CLERK_ENV.apiUrl], apiUrl = rawApi === undefined || rawApi === '' ? null : origin(rawApi);
	if (apiUrl === null && rawApi !== undefined && rawApi !== '') missing.push(CLERK_ENV.apiUrl);
	const rawSignIn = env[CLERK_ENV.signInUrl], signInUrl = rawSignIn === undefined || rawSignIn === '' ? null : url(rawSignIn);
	if (signInUrl === null && rawSignIn !== undefined && rawSignIn !== '') missing.push(CLERK_ENV.signInUrl);
	const rawStaffSignIn = env[CLERK_ENV.staffSignInUrl], staffSignInUrl = rawStaffSignIn === undefined || rawStaffSignIn === '' ? null : url(rawStaffSignIn);
	if (staffSignInUrl === null && rawStaffSignIn !== undefined && rawStaffSignIn !== '') missing.push(CLERK_ENV.staffSignInUrl);
	const rawAud = env[CLERK_ENV.audience], audience = rawAud === undefined || rawAud === '' ? null : typeof rawAud === 'string' && AUDIENCE.test(rawAud) ? rawAud : null;
	if (audience === null && rawAud !== undefined && rawAud !== '') missing.push(CLERK_ENV.audience);
	const mfa = env[CLERK_ENV.mfaRequired];
	if (mfa !== undefined && mfa !== 'true' && mfa !== 'false') missing.push(CLERK_ENV.mfaRequired);
	if (clientInstance && staffInstance && (clientInstance.issuer === staffInstance.issuer || clientInstance.publishableKey === staffInstance.publishableKey || clientInstance.secretKey === staffInstance.secretKey))
		missing.push('the client and staff Clerk instances must be separate applications');
	if (missing.length || !client || !appOrigin || !clientInstance || !staffInstance) return { ok: false, reason: `Clerk identity is not configured: ${missing.join(', ')}` };
	return { ok: true, config: { clientId: client, appOrigin, client: clientInstance, staff: staffInstance, apiUrl, mfaRequired: mfa === 'true', signInUrl, staffSignInUrl, audience } };
}

/**
 * What the public sign-in page may show: the sign-in URL of the client instance (default) or of the staff instance for the
 * per-client operator route, never a key. Null when unconfigured.
 *
 * `devBrowser` is the browser's `__clerk_db_jwt` on this origin. A development instance keeps one Clerk client per dev
 * browser, so a portal on another origin signs in this browser's client only when handed it, as @clerk/backend's
 * redirectToSignIn does; without it the portal signs in a client of its own and the handshake here stays signed out. The
 * cookie name is shared by both instances on this origin and the cookie does not show which one minted it, so the staff
 * portal takes only a `StaffDevBrowser` checked for this app, client and staff instance (flow.ts tiedDevBrowser: the dev
 * browser a staff-signed handshake this browser started here set), never a plain string or another app's value. The
 * value is transport only: the session that comes back is verified as any other.
 *
 * Each portal returns to its own sign-in page on this origin, exactly and with no query: an instance that allows only
 * exact redirect URLs then needs one entry per client origin, and the sign-in page takes the handshake and sends the
 * verified session on to the target the sign-in POST kept in its state cookie (flow.ts signInReturnCookie).
 */
export function clerkSignInTarget(env: Readonly<Record<string, unknown>>, kind: InstanceKind = 'client', devBrowser: string | StaffDevBrowser | null = null): { href: string } | null {
	const read = readClerkIdentityConfig(env, { keys: 'optional' });
	const signInUrl = read.ok ? (kind === 'client' ? read.config.signInUrl : read.config.staffSignInUrl) : null;
	if (!read.ok || signInUrl === null) return null;
	const target = new URL(signInUrl);
	target.searchParams.set('redirect_url', new URL(SIGN_IN_PAGE[kind], read.config.appOrigin).href);
	const staffScoped = typeof devBrowser === 'object' && devBrowser?.instance === 'staff' && devBrowser.appOrigin === read.config.appOrigin && devBrowser.clientId === read.config.clientId && devBrowser.issuer === read.config.staff.issuer;
	const value = kind === 'client' ? (typeof devBrowser === 'string' ? devBrowser : null) : staffScoped ? devBrowser.value : null;
	const development = read.config[kind].publishableKey.startsWith('pk_test_');
	if (development && value !== null && DEV_BROWSER.test(value) && target.origin !== read.config.appOrigin) target.searchParams.set('__clerk_db_jwt', value);
	return { href: target.href };
}

// The sign-in page of each instance: its form posts to itself and is redirected (303) to that instance's portal, which
// returns to it.
export const SIGN_IN_PAGE: Readonly<Record<InstanceKind, string>> = { client: '/sign-in', staff: '/sign-in/operator' };
const SIGN_IN_PAGES: Readonly<Record<string, InstanceKind>> = { [SIGN_IN_PAGE.client]: 'client', [SIGN_IN_PAGE.staff]: 'staff' };
const SIGN_IN_FLOW = /^\/sign-(?:in|out)(?:\/|$)/;

/**
 * Whether a same-origin path is a sign-in or sign-out page, which a sign-in never returns to: that would loop or end the
 * new session at once. The path is decoded and normalized until it is stable, so no escape, dot segment or doubled
 * slash hides one; a path that does not decode counts as one.
 */
export function isSignInFlowPage(pathname: string): boolean {
	let path = pathname;
	for (let i = 0; i < 4; i++) {
		let next: string;
		try {
			next = new URL(`https://path.invalid/${decodeURIComponent(path)}`).pathname.replace(/\/{2,}/g, '/');
		} catch {
			return true;
		}
		if (next === path) return SIGN_IN_FLOW.test(path.toLowerCase());
		path = next;
	}
	return true;
}

/**
 * The origins, beside 'self', a sign-in page's form-action must allow: a browser checks every redirect of a form
 * submission against it, so the sign-in POST's 303 to the configured portal needs that portal's exact origin, and the
 * instance's own Frontend API origin for the portal's hand-back. Only for the two sign-in pages, each with its own
 * instance; only https origins whose host is a plain DNS name; nothing from the request. Anything else is [].
 */
export function signInFormActionOrigins(env: Readonly<Record<string, unknown>>, path: string): readonly string[] {
	const kind = Object.hasOwn(SIGN_IN_PAGES, path) ? SIGN_IN_PAGES[path]! : null;
	const read = kind ? readClerkIdentityConfig(env, { keys: 'optional' }) : null;
	if (!kind || !read?.ok) return [];
	const signInUrl = kind === 'client' ? read.config.signInUrl : read.config.staffSignInUrl;
	const portal = signInUrl === null ? null : new URL(signInUrl);
	if (!portal || portal.protocol !== 'https:' || !HOST.test(portal.hostname)) return [];
	return [...new Set([portal.origin, read.config[kind].issuer])];
}
