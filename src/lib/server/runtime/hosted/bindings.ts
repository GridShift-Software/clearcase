import type { SessionKV } from '../../../auth/app-session.ts';
import type { ClientId } from '../contracts.ts';
import { id } from '../ids.ts';

// The parts of the Workers bindings the hosted entry uses. Each is checked here, so a missing or misnamed binding is a
// typed refusal at the boundary rather than an exception deep in a route.
export interface D1Statement {
	bind(...values: (string | number | null)[]): D1Statement;
	first<T>(): Promise<T | null>;
	all<T>(): Promise<{ results: T[] }>;
	run(): Promise<unknown>;
}
export interface D1 {
	prepare(sql: string): D1Statement;
	batch(statements: D1Statement[]): Promise<unknown[]>;
}
export interface R2 {
	get(key: string): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
}
export interface Bindings {
	SESSIONS: SessionKV | null;
	DB: D1 | null;
	BUCKET: R2 | null;
	ASSETS: boolean;
	/** The one client this deployment serves; it comes from the deployment, never from a request. */
	clientId: ClientId | null;
	gate: { runId: string; fixtureSha256: string } | null;
}

const has = (value: unknown, ...methods: string[]) =>
	typeof value === 'object' && value !== null && methods.every((m) => typeof (value as Record<string, unknown>)[m] === 'function');
const text = (value: unknown, pattern: RegExp) => (typeof value === 'string' && pattern.test(value) ? value : null);

export function bindings(env: Readonly<Record<string, unknown>>): Bindings {
	const client = text(env.CLEARCASE_CLIENT_ID, /^[a-z0-9][a-z0-9-]{0,62}$/);
	const runId = text(env.CLEARCASE_GATE_RUN, /^[A-Za-z0-9._-]{1,64}$/), fixtureSha256 = text(env.CLEARCASE_GATE_FIXTURE, /^[0-9a-f]{64}$/);
	return {
		SESSIONS: has(env.SESSIONS, 'get', 'put') ? (env.SESSIONS as SessionKV) : null,
		DB: has(env.DB, 'prepare', 'batch') ? (env.DB as D1) : null,
		BUCKET: has(env.BUCKET, 'get') ? (env.BUCKET as R2) : null,
		ASSETS: has(env.ASSETS, 'fetch'),
		clientId: client ? id('client', client) : null,
		gate: runId && fixtureSha256 ? { runId, fixtureSha256 } : null,
	};
}
