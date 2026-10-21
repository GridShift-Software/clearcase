// The probe's gates on native workerd against crafted issuers (crafted.ts): the hook, claim checks, D1 grants, R2
// assets and audit are the probe's real code; only the token issuer and Clerk's session-status endpoint stand in.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { CLIENT_ORIGIN, craftedWorld, type World } from './crafted.ts';

let w: World;
beforeAll(async () => {
	w = await craftedWorld();
});
afterAll(async () => {
	await w?.stop();
});

describe('wrong case and logged out', () => {
	test("a case-1 viewer reading case 2's metadata gets 404 and none of case 2's bytes", async () => {
		const res = await w.get(CLIENT_ORIGIN, '/cases/case-2', { token: w.token(w.client, 'user_crafted_viewer1'), headers: { accept: 'application/json' } });
		expect(res.status).toBe(404);
		expect(res.denial).toBe('no-case-access');
		expect(res.body).not.toContain('CC108-CASE2');
	});

	test("a logged-out request for case 1's metadata gets 401 and none of case 1's bytes", async () => {
		const res = await w.get(CLIENT_ORIGIN, '/cases/case-1', { headers: { accept: 'application/json' } });
		expect(res.status).toBe(401);
		expect(res.denial).toBe('signed-out');
		expect(res.body).not.toContain('CC108-CASE1');
	});
});
