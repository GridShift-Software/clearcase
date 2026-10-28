// The production entry's identity, as a signed-in user meets it (GRS-113). With a complete Clerk configuration for this
// deployment, a request's session token decides who is asking: an expired token, a token naming another issuer, a token
// from another client's instance or a revoked session is "sign in again" (401), never "unavailable" (503) and never
// verified. SYNTHETIC keys and a loopback session lookup stand in for Clerk: unit evidence only, never Clerk proof.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostedServices } from '../../../src/lib/server/runtime/hosted/services.ts';
import { refuse } from '../../../src/lib/server/runtime/hosted/http.ts';
import { craftedInstance, statusDouble } from './synthetic.ts';

const ORIGIN = 'https://client-a.clearcase.test';
const clientA = craftedInstance('client-a.clerk.test'), clientC = craftedInstance('client-c.clerk.test'), staffB = craftedInstance('staff-b.clerk.test');
let status: Awaited<ReturnType<typeof statusDouble>>;
beforeAll(async () => {
	status = await statusDouble();
	status.set('sess_a1', 'user_a1');
	status.set('sess_revoked', 'user_a1', 'revoked');
	status.set('sess_c1', 'user_c1');
});
afterAll(() => status.close());

const env = () => ({
	CLEARCASE_CLIENT_ID: 'client-a',
	CLEARCASE_APP_ORIGIN: ORIGIN,
	CLERK_CLIENT_PUBLISHABLE_KEY: clientA.publishableKey,
	CLERK_CLIENT_SECRET_KEY: clientA.secretKey,
	CLERK_CLIENT_JWT_KEY: clientA.jwtKey,
	CLERK_STAFF_PUBLISHABLE_KEY: staffB.publishableKey,
	CLERK_STAFF_SECRET_KEY: staffB.secretKey,
	CLERK_STAFF_JWT_KEY: staffB.jwtKey,
	CLERK_API_URL: status.url,
});
const request = (token: string) => new Request(`${ORIGIN}/cases`, { headers: { authorization: `Bearer ${token}` } });
async function statusOf(token: string): Promise<{ kind: string; status: number | null }> {
	const { services } = await hostedServices(request(token), env());
	try {
		await services.identity.checkRevocation();
		return { kind: services.identity.kind, status: null };
	} catch (e) {
		try {
			refuse(e);
		} catch (http) {
			return { kind: services.identity.kind, status: (http as { status?: number }).status ?? -1 };
		}
		return { kind: services.identity.kind, status: -1 };
	}
}

describe('production entry: adverse Clerk sessions are "sign in again", not unavailable', () => {
	it('verifies a live client session of this deployment', async () => {
		expect(await statusOf(clientA.token({ sub: 'user_a1', sid: 'sess_a1', azp: ORIGIN }))).toEqual({ kind: 'verified', status: null });
	});
	it.each([
		['an expired token', () => clientA.token({ sub: 'user_a1', sid: 'sess_a1', azp: ORIGIN, now: Date.now() - 3_600_000 })],
		['a token naming another issuer', () => clientA.token({ sub: 'user_a1', sid: 'sess_a1', azp: ORIGIN, claims: { iss: 'https://elsewhere.clerk.test' } })],
		["another client's instance", () => clientC.token({ sub: 'user_c1', sid: 'sess_c1', azp: ORIGIN })],
		['a revoked session', () => clientA.token({ sub: 'user_a1', sid: 'sess_revoked', azp: ORIGIN })],
	])('refuses %s with 401 and stays anonymous', async (_name, token) => {
		expect(await statusOf(token())).toEqual({ kind: 'anonymous', status: 401 });
	});
});
