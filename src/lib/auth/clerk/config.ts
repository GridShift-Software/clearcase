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
	/** The instance's PEM public key for networkless verification; null fetches the JWKS with the secret key. */
	readonly jwtKey: string | null;
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
} as const;

const CLIENT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PUBLISHABLE = /^pk_(test|live)_([A-Za-z0-9+/=]{4,512})$/;
const SECRET = /^sk_(test|live)_[A-Za-z0-9]{8,256}$/;
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const PEM = /^-----BEGIN PUBLIC KEY-----[A-Za-z0-9+/=\s]{64,4096}-----END PUBLIC KEY-----$/;
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

function instance(env: Readonly<Record<string, unknown>>, kind: InstanceKind, missing: string[]): ClerkInstanceConfig | null {
	const names = CLERK_ENV[kind];
	const publishableKey = env[names.publishableKey], secretKey = env[names.secretKey], jwtKey = env[names.jwtKey];
	const host = frontendApiHost(publishableKey);
	const pkMode = typeof publishableKey === 'string' ? PUBLISHABLE.exec(publishableKey)?.[1] : undefined;
	const skMode = typeof secretKey === 'string' ? SECRET.exec(secretKey)?.[1] : undefined;
	if (!host) missing.push(names.publishableKey);
	if (!skMode) missing.push(names.secretKey);
	else if (pkMode && pkMode !== skMode) missing.push(`${names.secretKey} (instance mode differs from ${names.publishableKey})`);
	const pem = jwtKey === undefined || jwtKey === '' ? null : typeof jwtKey === 'string' && PEM.test(jwtKey) ? jwtKey : undefined;
	if (pem === undefined) missing.push(names.jwtKey);
	if (!host || !skMode || pkMode !== skMode || pem === undefined) return null;
	return { kind, issuer: `https://${host}`, publishableKey: publishableKey as string, secretKey: secretKey as string, jwtKey: pem };
}

/**
 * Reads this deployment's Clerk configuration. Unavailable unless every required value is present and well formed, and
 * the client and staff instances are distinct applications (different issuer, publishable and secret key).
 */
export function readClerkIdentityConfig(env: Readonly<Record<string, unknown>>): ConfigResult {
	const missing: string[] = [];
	const client = typeof env[CLERK_ENV.clientId] === 'string' && CLIENT_ID.test(env[CLERK_ENV.clientId] as string) ? id('client', env[CLERK_ENV.clientId] as string) : null;
	if (!client) missing.push(CLERK_ENV.clientId);
	const appOrigin = origin(env[CLERK_ENV.appOrigin]);
	if (!appOrigin) missing.push(CLERK_ENV.appOrigin);
	const clientInstance = instance(env, 'client', missing), staffInstance = instance(env, 'staff', missing);
	const rawApi = env[CLERK_ENV.apiUrl], apiUrl = rawApi === undefined || rawApi === '' ? null : origin(rawApi);
	if (apiUrl === null && rawApi !== undefined && rawApi !== '') missing.push(CLERK_ENV.apiUrl);
	const rawSignIn = env[CLERK_ENV.signInUrl], signInUrl = rawSignIn === undefined || rawSignIn === '' ? null : url(rawSignIn);
	if (signInUrl === null && rawSignIn !== undefined && rawSignIn !== '') missing.push(CLERK_ENV.signInUrl);
	const mfa = env[CLERK_ENV.mfaRequired];
	if (mfa !== undefined && mfa !== 'true' && mfa !== 'false') missing.push(CLERK_ENV.mfaRequired);
	if (clientInstance && staffInstance && (clientInstance.issuer === staffInstance.issuer || clientInstance.publishableKey === staffInstance.publishableKey || clientInstance.secretKey === staffInstance.secretKey))
		missing.push('the client and staff Clerk instances must be separate applications');
	if (missing.length || !client || !appOrigin || !clientInstance || !staffInstance) return { ok: false, reason: `Clerk identity is not configured: ${missing.join(', ')}` };
	return { ok: true, config: { clientId: client, appOrigin, client: clientInstance, staff: staffInstance, apiUrl, mfaRequired: mfa === 'true', signInUrl } };
}

/** What the public sign-in page may show: the client instance's sign-in URL, never a key. Null when unconfigured. */
export function clerkSignInTarget(env: Readonly<Record<string, unknown>>, returnTo: string): { href: string } | null {
	const read = readClerkIdentityConfig(env);
	if (!read.ok || read.config.signInUrl === null) return null;
	const target = new URL(read.config.signInUrl), back = new URL(returnTo, read.config.appOrigin);
	if (back.origin !== read.config.appOrigin) return null;
	target.searchParams.set('redirect_url', back.href);
	return { href: target.href };
}
