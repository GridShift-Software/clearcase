import { expect, it } from 'vitest';
import { mintAppSession, signAppSession, type AppSessionConfig } from '../../../src/lib/auth/app-session.ts';
import { appSessionRefresh, clerkBrowserNeeded } from '../../../src/lib/auth/app-browser.ts';
import { clerkIdentityProviderFromEnv } from '../../../src/lib/auth/clerk/provider.ts';
import { load } from '../../../deploy/client/routes/cases/+page.server.ts';
import { craftedInstance } from '../identity/synthetic.ts';
import { expectWithinBudget, hostedWorld, routeEvent } from './harness.ts';

it('09a: a valid app cookie renders the case list with zero Clerk fetches and one KV read', async () => {
	const client = craftedInstance('budget-client.clerk.test');
	const staff = craftedInstance('budget-staff.clerk.test');
	let kvReads = 0;
	const sessions = {
		get: async (_key: string) => { kvReads++; return null; },
		put: async () => {},
	};
	const config: AppSessionConfig = { key: 'c'.repeat(64), clientId: 'client-a', origin: 'https://client-a.example.invalid', issuer: client.iss, sessions };
	const env = {
		CLEARCASE_SESSION_KEY: config.key, CLEARCASE_CLIENT_ID: config.clientId, CLEARCASE_APP_ORIGIN: config.origin, SESSIONS: sessions,
		CLERK_CLIENT_PUBLISHABLE_KEY: client.publishableKey, CLERK_CLIENT_SECRET_KEY: client.secretKey, CLERK_CLIENT_JWT_KEY: client.jwtKey,
		CLERK_STAFF_PUBLISHABLE_KEY: staff.publishableKey, CLERK_STAFF_SECRET_KEY: staff.secretKey, CLERK_STAFF_JWT_KEY: staff.jwtKey,
	};
	const provider = clerkIdentityProviderFromEnv(env, { authorizeCase: async () => {} });
	if (!provider.ok) throw new Error(provider.reason);
	const session = await mintAppSession(config, { sid: 'sess_budget', subject: 'user_budget', name: 'Synthetic Lawyer' });
	const request = new Request(`${config.origin}/cases`, { headers: { cookie: `__Host-clearcase_session=${await signAppSession(config, session)}` } });
	const w = await hostedWorld();
	// Storage ceilings belong to 06; this test constrains auth over the existing case-list route.
	const result = await expectWithinBudget('09a /cases app session', { clerk: 0, d1: 3, r2: 2 }, w.counters, async () => {
		const identity = await provider.provider.authenticate({ request });
		expect(identity.kind).toBe('verified');
		expect(clerkBrowserNeeded(env, request)).toBe(false);
		await identity.checkRevocation();
		await identity.authorize({ caseId: w.caseId, operation: 'read' });
		await appSessionRefresh(env, request);
		return load(routeEvent({ ...w.locals, identity }));
	});
	expect(result.thrown).toBeUndefined();
	expect(result.value?.cases).toHaveLength(1);
	expect(result.counts.clerk).toBe(0);
	expect(result.counts.otherFetch).toBe(0);
	expect(kvReads).toBe(1);
	console.log('09a /cases counts', JSON.stringify({ ...result.counts, kvReads }));
});
