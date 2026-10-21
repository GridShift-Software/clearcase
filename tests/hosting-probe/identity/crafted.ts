// Offline fixtures for the identity probe's own tests (GRS-108). Two things stand in for Clerk: an issuer whose RSA key
// is made per run, and a loopback copy of Clerk's session-status endpoint (GET /v1/sessions/:id). Everything else is the
// probe's real code on native workerd: the hook, the claim checks, the D1 grants, the R2 assets and the audit. These
// tests are evidence for that code, never for Clerk; probe.ts runs the Clerk legs against the real development instances.
import { type ChildProcess, spawn } from 'node:child_process';
import { createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { appEnv, build, fetchApp, realNode, run, seed, startServe, stopServe, wranglerArgs, type Reply } from './harness.ts';

const HERE = import.meta.dirname;

export type Claims = Record<string, unknown>;

/** A crafted issuer: its own RSA key, a synthetic publishable key naming its host, and a signer. */
export function craftedIssuer(host: string) {
	const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const kid = `crafted-${randomBytes(6).toString('hex')}`;
	return {
		iss: `https://${host}`,
		publishableKey: ['pk', 'test', Buffer.from(`${host}$`).toString('base64')].join('_'),
		// one line: the fd-3 protocol carries KEY=VALUE lines, and Clerk's PEM loader drops line breaks anyway
		jwtKey: publicKey.export({ type: 'spki', format: 'pem' }).toString().replace(/\n/g, ''),
		kid,
		sign: (claims: Claims, header: Record<string, unknown> = {}, key: KeyObject = privateKey) => sign({ alg: 'RS256', typ: 'JWT', kid, ...header }, claims, key),
	};
}
export type Issuer = ReturnType<typeof craftedIssuer>;

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
function sign(header: Record<string, unknown>, claims: Claims, key: KeyObject): string {
	const body = `${b64(header)}.${b64(claims)}`;
	return `${body}.${createSign('RSA-SHA256').update(body).sign(key).toString('base64url')}`;
}

/** The loopback status endpoint: a session's status is what the test sets; `outage` answers 503 to everything. */
export async function statusDouble() {
	const sessions = new Map<string, { status: string; user_id: string }>();
	const users = new Map<string, string>();
	let outage = false;
	const calls: string[] = [];
	const server: Server = createServer((req, res) => {
		calls.push(`${req.method} ${req.url}`);
		const send = (status: number, body: unknown) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(body)));
		if (outage) return send(503, { errors: [{ code: 'service_unavailable' }] });
		const s = /^\/v1\/sessions\/([^/?]+)$/.exec(req.url ?? '');
		if (req.method === 'GET' && s) {
			const row = sessions.get(s[1]!);
			return row ? send(200, { object: 'session', id: s[1], ...row, client_id: 'client_crafted', last_active_at: 0, expire_at: 0, abandon_at: 0, created_at: 0, updated_at: 0 }) : send(404, { errors: [{ code: 'resource_not_found' }] });
		}
		const u = /^\/v1\/users\/([^/?]+)$/.exec(req.url ?? '');
		if (req.method === 'GET' && u && users.has(u[1]!)) {
			const email = users.get(u[1]!)!;
			return send(200, { object: 'user', id: u[1], primary_email_address_id: 'idn_1', email_addresses: [{ object: 'email_address', id: 'idn_1', email_address: email, verification: { status: 'verified', strategy: 'email_code', attempts: null, expire_at: null }, linked_to: [] }], public_metadata: {}, private_metadata: {}, unsafe_metadata: {} });
		}
		send(404, { errors: [{ code: 'resource_not_found' }] });
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	const { port } = server.address() as { port: number };
	return {
		url: `http://127.0.0.1:${port}`,
		calls,
		set: (sid: string, userId: string, status = 'active') => sessions.set(sid, { status, user_id: userId }),
		user: (userId: string, email: string) => users.set(userId, email),
		outage: (on: boolean) => (outage = on),
		close: () => new Promise<void>((r) => server.close(() => r())),
	};
}

export const CLIENT_PORT = 18831;
export const STAFF_PORT = 18832;
export const CLIENT_ORIGIN = `http://127.0.0.1:${CLIENT_PORT}`;
export const STAFF_ORIGIN = `http://127.0.0.1:${STAFF_PORT}`;

/**
 * The crafted world: one build, seeded client and staff stores, both Workers served by serve.mjs with crafted issuers
 * and the status double, and the fixture identities of gates.sql already enrolled.
 */
export type WorldOptions = { mfaRequired?: boolean; ports?: [number, number] };

export async function craftedWorld(opts: WorldOptions = {}) {
	const node = realNode();
	const parent = path.join(HERE, '../../../.local/hosting-probe/identity');
	mkdirSync(parent, { recursive: true });
	const runDir = mkdtempSync(path.join(parent, 'crafted-'));
	const logs = path.join(runDir, 'logs');
	mkdirSync(logs, { recursive: true });
	try {
		return await world(node, runDir, logs, opts);
	} catch (e) {
		rmSync(runDir, { recursive: true, force: true });
		throw e;
	}
}

async function world(node: { path: string; version: string }, runDir: string, logs: string, opts: WorldOptions) {
	const [clientPort, staffPort] = opts.ports ?? [CLIENT_PORT, STAFF_PORT];
	const origin = { client: `http://127.0.0.1:${clientPort}`, staff: `http://127.0.0.1:${staffPort}` };
	build(node, runDir, 'crafted');
	const env = appEnv(node, runDir);
	const persist = path.join(runDir, 'persist');
	seed(node, env, persist, logs, { client: ['schema/common.sql', 'schema/client.sql', 'schema/fixtures.sql', 'schema/crafted.sql'], staff: ['schema/common.sql', 'schema/crafted-staff.sql'] });
	const client = craftedIssuer('crafted-client.clerk.invalid');
	const staff = craftedIssuer('crafted-staff.clerk.invalid');
	const status = await statusDouble();
	const secrets = new Map([
		['CLIENT_A_PK', client.publishableKey],
		['CLIENT_A_SK', 'sk_test_synthetic-placeholder-not-a-key'],
		['CLIENT_A_JWT_KEY', client.jwtKey],
		['STAFF_PK', staff.publishableKey],
		['STAFF_SK', 'sk_test_synthetic-placeholder-not-a-key'],
		['STAFF_JWT_KEY', staff.jwtKey],
	]);
	const serveConfig = { persist, logs, apiUrl: status.url, mfaRequired: opts.mfaRequired ?? false, jwtKeys: true, client: { port: clientPort, origin: origin.client }, staff: { port: staffPort, origin: origin.staff } };
	let serve: ChildProcess = await startServe(node, env, serveConfig, secrets, logs);
	const now = () => Math.floor(Date.now() / 1000);
	/** A Clerk-shaped v2 session token for `sub`, valid for 60 s, unless `over` changes a claim (undefined deletes it). */
	const token = (who: Issuer, sub: string, over: Claims = {}, azp = who === client ? origin.client : origin.staff) => {
		const sid = `sess_${sub}`;
		status.set(sid, sub);
		const claims: Claims = { azp, exp: now() + 60, fva: [0, -1], iat: now() - 1, iss: who.iss, nbf: now() - 6, sid, sub, v: 2, ...over };
		for (const [k, v] of Object.entries(over)) if (v === undefined) delete claims[k];
		return who.sign(claims);
	};
	return {
		client,
		staff,
		status,
		token,
		origin,
		get: (at: string, pathname: string, init: Parameters<typeof fetchApp>[2] = {}): Promise<Reply> => fetchApp(at, pathname, init),
		/** Runs one SQL statement against an app's local D1 from outside the Worker, as the seed does. */
		execute: (app: 'client' | 'staff', sql: string) => {
			const r = run(node.path, wranglerArgs(['d1', 'execute', 'DB', '--local', '--env', app, '--persist-to', persist, '--command', sql]), { env });
			if (r.code !== 0) throw new Error(`d1 execute on ${app} failed (exit ${r.code}): ${r.out.slice(-400)}`);
		},
		restart: async () => {
			await stopServe(serve);
			serve = await startServe(node, env, serveConfig, secrets, logs);
		},
		stop: async () => {
			await stopServe(serve).catch(() => {});
			await status.close();
			rmSync(runDir, { recursive: true, force: true });
		},
	};
}
export type World = Awaited<ReturnType<typeof craftedWorld>>;
