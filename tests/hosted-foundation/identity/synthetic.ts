// SYNTHETIC Clerk stand-ins for the identity unit tests (GRS-113). Every key is made per run and every host is a .test
// name; nothing here is a real Clerk instance, key or session, and nothing here is evidence for Clerk itself.
// - craftedInstance: an RSA key pair, a publishable key naming a synthetic Frontend API host, and a token signer.
// - statusDouble: a loopback copy of Clerk's Backend API session lookup (GET /v1/sessions/:id).
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

export type Claims = Record<string, unknown>;
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

export function craftedInstance(host: string) {
	const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const kid = `ins_synthetic_${randomBytes(6).toString('hex')}`;
	const iss = `https://${host}`;
	return {
		iss,
		publishableKey: ['pk', 'test', Buffer.from(`${host}$`).toString('base64')].join('_'),
		secretKey: ['sk', 'test', `synthetic${randomBytes(12).toString('hex')}`].join('_'),
		kid,
		jwtKey: publicKey.export({ type: 'spki', format: 'pem' }).toString().replace(/\n/g, ''),
		/** Any JSON payload signed with this instance's key, e.g. a Clerk handshake token carrying cookie directives. */
		sign(payload: unknown, header: Claims = {}) {
			const body = `${b64({ alg: 'RS256', typ: 'JWT', kid, ...header })}.${b64(payload)}`;
			return `${body}.${createSign('RSA-SHA256').update(body).sign(privateKey).toString('base64url')}`;
		},
		/** A Clerk v2-shaped session token signed with this instance's key; `claims` override the defaults. */
		token(a: { sub: string; sid: string; azp: string; now?: number; claims?: Claims; header?: Claims }) {
			const now = Math.floor((a.now ?? Date.now()) / 1000);
			const claims = { azp: a.azp, exp: now + 60, fva: [0, -1], iat: now - 5, iss, nbf: now - 5, sid: a.sid, sts: 'active', sub: a.sub, v: 2, ...a.claims };
			const body = `${b64({ alg: 'RS256', typ: 'JWT', kid, ...a.header })}.${b64(claims)}`;
			return `${body}.${createSign('RSA-SHA256').update(body).sign(privateKey).toString('base64url')}`;
		},
	};
}
/** A token from raw JSON parts, for shapes a signer would never produce (null header, array payload, ...). */
export const forgedToken = (header: unknown, payload: unknown, signature = 'c2lnbmF0dXJl') => `${b64(header)}.${b64(payload)}.${signature}`;
export type CraftedInstance = ReturnType<typeof craftedInstance>;

/** Clerk's session lookup on loopback: a session's status is what the test sets; `outage` answers 503. */
export async function statusDouble() {
	const sessions = new Map<string, { status: string; user_id: string }>();
	const calls: string[] = [];
	const bearers: { call: string; key: string }[] = [];
	let outage = false, failRevoke = false;
	const server: Server = createServer((req, res) => {
		calls.push(`${req.method} ${req.url} ${req.headers.authorization ? 'auth' : 'no-auth'}`);
		bearers.push({ call: `${req.method} ${req.url}`, key: String(req.headers.authorization ?? '').replace(/^Bearer /, '') });
		const send = (status: number, body: unknown) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(body)));
		if (outage) return send(503, { errors: [{ code: 'service_unavailable', message: 'synthetic outage' }] });
		const revoke = /^\/v1\/sessions\/([^/?]+)\/revoke$/.exec(req.url ?? '');
		if (revoke && req.method === 'POST') {
			if (failRevoke) return send(500, { errors: [{ code: 'internal_error', message: 'synthetic revoke failure' }] });
			const row = sessions.get(revoke[1]!);
			if (!row) return send(404, { errors: [{ code: 'resource_not_found', message: 'not found' }] });
			row.status = 'revoked';
			return send(200, { object: 'session', id: revoke[1], ...row, client_id: 'client_synthetic', last_active_at: 0, expire_at: 0, abandon_at: 0, created_at: 0, updated_at: 0 });
		}
		const m = /^\/v1\/sessions\/([^/?]+)$/.exec(req.url ?? '');
		const row = m && req.method === 'GET' ? sessions.get(m[1]!) : undefined;
		if (!row) return send(404, { errors: [{ code: 'resource_not_found', message: 'not found' }] });
		send(200, { object: 'session', id: m![1], ...row, client_id: 'client_synthetic', last_active_at: 0, expire_at: 0, abandon_at: 0, created_at: 0, updated_at: 0 });
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	const { port } = server.address() as { port: number };
	return {
		url: `http://127.0.0.1:${port}`,
		calls,
		/** The bearer key each request carried (revocation-evidence tests), additive to `calls`. */
		bearers,
		/** The status the double holds for a session, or undefined when it has none. */
		statusOf: (sid: string) => sessions.get(sid)?.status,
		/** Only the revoke POST answers 500; the session lookup still works. */
		failRevoke: (on: boolean) => void (failRevoke = on),
		set: (sid: string, userId: string, status = 'active') => void sessions.set(sid, { status, user_id: userId }),
		outage: (on: boolean) => void (outage = on),
		close: () => new Promise<void>((r) => server.close(() => r())),
	};
}

