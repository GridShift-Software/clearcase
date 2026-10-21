// The runner's Clerk client (GRS-108): Backend API calls with an instance's secret key, and Frontend API calls made as
// a browser makes them on a development instance, where a dev browser JWT (__clerk_db_jwt) names the Clerk client
// instead of a first-party cookie. An error names the call, the HTTP status and Clerk's error code, never a value: no
// response body, URL, token or key is ever quoted.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const API = 'https://api.clerk.com/v1';
/** The API version the pinned @clerk/backend sends (SUPPORTED_BAPI_VERSION in its build), so the probe speaks the same one. */
function apiVersion(): string {
	const dist = path.join(import.meta.dirname, 'node_modules/@clerk/backend/dist');
	for (const f of readdirSync(dist).filter((n) => n.endsWith('.mjs'))) {
		const m = /SUPPORTED_BAPI_VERSION = "([0-9-]+)"/.exec(readFileSync(path.join(dist, f), 'utf8'));
		if (m) return m[1]!;
	}
	throw new Error('@clerk/backend names no SUPPORTED_BAPI_VERSION');
}
/** What clerk-js sends on every Frontend API call: its version and the API version. */
const FAPI_VERSION = [['_clerk_js_version', '6.40.0'], ['__clerk_api_version', apiVersion()]] as const;
const CODE = /^[a-z0-9_]{1,64}$/;

export class ClerkError extends Error {
	readonly status: number;
	readonly code: string | null;
	constructor(call: string, status: number, code: string | null) {
		super(`${call}: HTTP ${status}${code ? ` (${code})` : ''}`);
		this.status = status;
		this.code = code;
	}
}

/** The Frontend API origin a publishable key names: pk_test_ then base64 of "<host>$". */
export function frontendApi(publishableKey: string): string {
	const m = /^pk_(?:test|live)_([A-Za-z0-9+/=]+)$/.exec(publishableKey);
	const host = m ? Buffer.from(m[1]!, 'base64').toString('utf8') : '';
	if (!/^[a-z0-9][a-z0-9.-]+\$$/.test(host)) throw new Error('the publishable key names no Frontend API host');
	return `https://${host.slice(0, -1)}`;
}

async function parse(call: string, res: Response): Promise<any> {
	const text = await res.text();
	let json: any = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {}
	if (!res.ok) {
		const code = json?.errors?.[0]?.code;
		throw new ClerkError(call, res.status, typeof code === 'string' && CODE.test(code) ? code : null);
	}
	return json;
}

/** Waits until at most `limit` calls fall in any `windowMs`: Clerk's development Backend API allows 100 per 10 s. */
export class Pace {
	private times: number[] = [];
	private limit: number;
	private windowMs: number;
	constructor(limit: number, windowMs: number) {
		this.limit = limit;
		this.windowMs = windowMs;
	}
	async take() {
		for (;;) {
			const now = Date.now();
			this.times = this.times.filter((t) => now - t < this.windowMs);
			if (this.times.length < this.limit) return void this.times.push(now);
			await new Promise((r) => setTimeout(r, this.windowMs - (now - this.times[0]!) + 5));
		}
	}
}

export type User = { id: string; email: string; createdAt: number };

export class Backend {
	calls = 0;
	private secretKey: string;
	private pace: Pace;
	constructor(secretKey: string, pace: Pace) {
		this.secretKey = secretKey;
		this.pace = pace;
	}

	async call(method: string, pathname: string, body?: unknown): Promise<any> {
		await this.pace.take();
		this.calls++;
		const res = await fetch(`${API}${pathname}`, {
			method,
			headers: { authorization: `Bearer ${this.secretKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(30_000),
		});
		return parse(`BAPI ${method} ${pathname.replace(/\/(user|sess|inv|idn|client)_[A-Za-z0-9]+/g, '/$1_…').replace(/\?.*/, '')}`, res);
	}

	usersCount = async (): Promise<number> => (await this.call('GET', '/users/count')).total_count;
	/** Every user whose primary email starts with `prefix` (a run's own synthetic addresses), with the creation time Clerk gives in ms. */
	async users(prefix: string): Promise<User[]> {
		const out: User[] = [];
		for (let offset = 0; ; offset += 100) {
			const page = (await this.call('GET', `/users?limit=100&offset=${offset}&query=${encodeURIComponent(prefix)}`)) as any[];
			for (const u of page) {
				const email = u.email_addresses?.find((e: any) => e.id === u.primary_email_address_id)?.email_address ?? '';
				if (email.startsWith(prefix)) out.push({ id: u.id, email, createdAt: Number(u.created_at) || 0 });
			}
			if (page.length < 100) return out;
		}
	}
	/** Every invitation for an address that starts with `prefix`, with its status. */
	async invitations(prefix: string): Promise<{ id: string; email: string; status: string; createdAt: number }[]> {
		const out: { id: string; email: string; status: string; createdAt: number }[] = [];
		for (let offset = 0; ; offset += 100) {
			const page = await this.call('GET', `/invitations?limit=100&offset=${offset}&query=${encodeURIComponent(prefix)}`);
			const rows = (Array.isArray(page) ? page : page.data) as any[];
			for (const i of rows) if (i.email_address.startsWith(prefix)) out.push({ id: i.id, email: i.email_address, status: i.status, createdAt: Number(i.created_at) || 0 });
			if (rows.length < 100) return out;
		}
	}
	pendingInvitations = async (): Promise<number> => {
		const page = await this.call('GET', '/invitations?limit=1&status=pending');
		return Array.isArray(page) ? page.length : page.total_count;
	};
	createInvitation = (email: string, redirectUrl: string) => this.call('POST', '/invitations', { email_address: email, notify: false, ignore_existing: true, redirect_url: redirectUrl });
	revokeInvitation = (id: string) => this.call('POST', `/invitations/${id}/revoke`);
	createUser = (email: string, password: string) => this.call('POST', '/users', { email_address: [email], password });
	getUser = (id: string) => this.call('GET', `/users/${id}`);
	deleteUser = (id: string) => this.call('DELETE', `/users/${id}`);
	getSession = (id: string) => this.call('GET', `/sessions/${id}`);
	revokeSession = (id: string) => this.call('POST', `/sessions/${id}/revoke`);
	/** A short-lived Testing Token: it lets FAPI calls past Clerk's bot protection (protect_check); it is not a session. */
	testingToken = async (): Promise<string> => (await this.call('POST', '/testing_tokens')).token;
	sessions = async (userId: string): Promise<{ id: string; status: string }[]> => ((await this.call('GET', `/sessions?user_id=${userId}&limit=100`)) as any[]).map((s) => ({ id: s.id, status: s.status }));
}

/** The ticket in a Clerk invitation link (__clerk_ticket or ticket), or null. */
export function ticketOf(url: string): string | null {
	const u = new URL(url);
	return u.searchParams.get('__clerk_ticket') ?? u.searchParams.get('ticket');
}

/**
 * One browser's Clerk client on a development instance: the dev browser JWT stands in for FAPI's cookies, and every
 * call carries the app's Origin, which Clerk writes into each session token as azp.
 */
export class Browser {
	calls = 0;
	readonly fapi: string;
	readonly origin: string;
	readonly devBrowser: string;
	private testingToken: string;
	private constructor(fapi: string, origin: string, devBrowser: string, testingToken: string) {
		this.fapi = fapi;
		this.origin = origin;
		this.devBrowser = devBrowser;
		this.testingToken = testingToken;
	}

	static async open(fapi: string, origin: string, testingToken: string): Promise<Browser> {
		const res = await fetch(`${fapi}/v1/dev_browser`, { method: 'POST', headers: { origin }, signal: AbortSignal.timeout(30_000) });
		const json = await parse('FAPI POST /v1/dev_browser', res);
		const jwt = json?.id ?? json?.token;
		if (typeof jwt !== 'string' || !jwt) throw new Error('FAPI POST /v1/dev_browser: no dev browser JWT in the response');
		return new Browser(fapi, origin, jwt, testingToken);
	}

	async call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', pathname: string, form?: Record<string, string>): Promise<any> {
		this.calls++;
		const url = new URL(`${this.fapi}${pathname}`);
		url.searchParams.set('__clerk_db_jwt', this.devBrowser);
		for (const [k, v] of FAPI_VERSION) url.searchParams.set(k, v);
		url.searchParams.set('__clerk_testing_token', this.testingToken);
		const res = await fetch(url, {
			method,
			headers: { origin: this.origin, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
			body: form ? new URLSearchParams(form).toString() : undefined,
			signal: AbortSignal.timeout(30_000),
		});
		return parse(`FAPI ${method} ${pathname.replace(/\/(sia|sua|sess)_[A-Za-z0-9]+/g, '/$1_…')}`, res);
	}

	/** Public sign-up with no invitation: an invite-only (restricted) instance refuses it. */
	signUpOpen = (email: string, password: string) => this.call('POST', '/v1/client/sign_ups', { email_address: email, password });

	/** Accepts an invitation: sign-up by its ticket, which verifies the address; resolves with the new session's id. */
	async signUpWithTicket(ticket: string, password: string): Promise<string> {
		const r = (await this.call('POST', '/v1/client/sign_ups', { strategy: 'ticket', ticket, password })).response;
		if (r?.status !== 'complete' || !r.created_session_id) throw new Error(`ticket sign-up ended ${JSON.stringify(r?.status)}, missing ${JSON.stringify(r?.missing_fields ?? [])}`);
		return r.created_session_id;
	}

	/** Signs in by email code; a +clerk_test address takes the fixed test code and nothing is sent. */
	async signInWithEmailCode(email: string): Promise<string> {
		const created = (await this.call('POST', '/v1/client/sign_ins', { identifier: email })).response;
		const factor = created?.supported_first_factors?.find((f: any) => f.strategy === 'email_code');
		if (!factor) throw new Error('sign-in offers no email_code first factor');
		await this.call('POST', `/v1/client/sign_ins/${created.id}/prepare_first_factor`, { strategy: 'email_code', email_address_id: factor.email_address_id });
		const done = (await this.call('POST', `/v1/client/sign_ins/${created.id}/attempt_first_factor`, { strategy: 'email_code', code: '424242' })).response;
		if (done?.status !== 'complete' || !done.created_session_id) throw new Error(`sign-in ended ${JSON.stringify(done?.status)}`);
		return done.created_session_id;
	}

	/** A fresh session token for `sessionId`, as clerk-js refreshes it; Clerk refuses it for a revoked or ended session. */
	async token(sessionId: string): Promise<string> {
		const r = await this.call('POST', `/v1/client/sessions/${sessionId}/tokens`);
		if (typeof r?.jwt !== 'string') throw new Error('FAPI token: no jwt in the response');
		return r.jwt;
	}

	/** The browser's Clerk client as FAPI reports it: its sessions' ids and statuses. */
	async client(): Promise<{ sessions: { id: string; status: string }[] }> {
		const r = (await this.call('GET', '/v1/client')).response;
		return { sessions: (r?.sessions ?? []).map((s: any) => ({ id: s.id, status: s.status })) };
	}
}

/** A session token's claims, decoded without verification: the runner reads them as evidence of what Clerk issued, never to authorize. */
export function claimsOf(jwt: string): Record<string, unknown> {
	return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'));
}
