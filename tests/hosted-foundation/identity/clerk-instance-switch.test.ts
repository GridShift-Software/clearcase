// The Clerk instance switch (GRS-267): the runtime refuses a mismatched mix of instance values, and the profile logic of
// deploy/staging/instance.ts (scripts/clerk-instance.sh) refuses placeholders and rewrites wrangler.jsonc to a profile.
// SYNTHETIC hosts and keys throughout; the real profiles are read only for their shape, and no value is printed.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountsPortalHost, CLERK_ENV, frontendApiHost, readClerkIdentityConfig } from '../../../src/lib/auth/clerk/config.ts';
import { activeProfile, loadProfile, plan, problems, rewrite, type Profile } from '../../../deploy/staging/instance.ts';
import { craftedInstance } from './synthetic.ts';

const ORIGIN = 'https://staging.clearcase.test';
const A = craftedInstance('clerk.demo-a.example'), B = craftedInstance('clerk.demo-b.example');
const live = (v: string) => v.replace(/^(pk|sk)_test_/, '$1_live_');
const env = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
	CLEARCASE_CLIENT_ID: 'client-a', CLEARCASE_APP_ORIGIN: ORIGIN,
	CLERK_CLIENT_PUBLISHABLE_KEY: A.publishableKey, CLERK_CLIENT_SECRET_KEY: A.secretKey, CLERK_CLIENT_JWT_KEY: A.jwtKey,
	CLERK_STAFF_PUBLISHABLE_KEY: B.publishableKey, CLERK_STAFF_SECRET_KEY: B.secretKey, CLERK_STAFF_JWT_KEY: B.jwtKey,
	CLERK_CLIENT_SIGN_IN_URL: 'https://accounts.demo-a.example/sign-in', CLERK_STAFF_SIGN_IN_URL: 'https://accounts.demo-b.example/sign-in', ...extra,
});
const liveEnv = (extra: Record<string, unknown> = {}) => env({
	CLERK_CLIENT_PUBLISHABLE_KEY: live(A.publishableKey), CLERK_CLIENT_SECRET_KEY: live(A.secretKey),
	CLERK_STAFF_PUBLISHABLE_KEY: live(B.publishableKey), CLERK_STAFF_SECRET_KEY: live(B.secretKey), ...extra,
});

describe('the runtime refuses a mismatched mix of Clerk instance values', () => {
	it('accepts a consistent development set and a consistent production set', () => {
		expect(readClerkIdentityConfig(env()).ok).toBe(true);
		const r = readClerkIdentityConfig(liveEnv());
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.config.client.issuer).toBe('https://clerk.demo-a.example');
	});
	it.each([
		['a pk_live_ client key with an sk_test_ secret', liveEnv({ CLERK_CLIENT_SECRET_KEY: A.secretKey }), CLERK_ENV.client.secretKey],
		['a pk_live_ staff key with an sk_test_ secret', liveEnv({ CLERK_STAFF_SECRET_KEY: B.secretKey }), CLERK_ENV.staff.secretKey],
		['a pk_test_ client key with an sk_live_ secret', env({ CLERK_CLIENT_SECRET_KEY: live(A.secretKey) }), CLERK_ENV.client.secretKey],
		['a pk_test_ staff key with an sk_live_ secret', env({ CLERK_STAFF_SECRET_KEY: live(B.secretKey) }), CLERK_ENV.staff.secretKey],
		['a client sign-in page of another instance than its key', env({ CLERK_CLIENT_SIGN_IN_URL: 'https://accounts.demo-b.example/sign-in' }), CLERK_ENV.signInUrl],
		['a staff sign-in page of another instance than its key', env({ CLERK_STAFF_SIGN_IN_URL: 'https://accounts.demo-a.example/sign-in' }), CLERK_ENV.staffSignInUrl],
		['the development portal of an old instance with a production key', liveEnv({ CLERK_CLIENT_SIGN_IN_URL: 'https://outgoing-walrus-1020.accounts.dev/sign-in' }), CLERK_ENV.signInUrl],
	])('%s', (_what, e, named) => {
		for (const keys of ['required', 'optional'] as const) {
			const r = readClerkIdentityConfig(e, { keys });
			expect(r.ok).toBe(false);
			if (!r.ok) {
				expect(r.reason).toContain(named);
				for (const secret of [A.secretKey, B.secretKey, live(A.secretKey), live(B.secretKey), A.jwtKey]) expect(r.reason).not.toContain(secret);
			}
		}
	});
	it('knows the accounts portal of both Clerk host shapes and judges no other', () => {
		expect(accountsPortalHost('outgoing-walrus-1020.clerk.accounts.dev')).toBe('outgoing-walrus-1020.accounts.dev');
		expect(accountsPortalHost('clerk.demo-a.example')).toBe('accounts.demo-a.example');
		expect(accountsPortalHost('client-a.clerk.test')).toBeNull();
		expect(frontendApiHost(live(A.publishableKey))).toBe('clerk.demo-a.example');
	});
});

describe('the instance profiles (deploy/staging/clerk-instances, scripts/clerk-instance.sh)', () => {
	const wrangler = readFileSync(new URL('../../../deploy/staging/wrangler.jsonc', import.meta.url), 'utf8');
	const parse = (text: string) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) as { vars: Record<string, string>; previews: { vars: Record<string, string> } };
	const synthetic: Profile = {
		mode: 'production', note: 'synthetic', secretsFile: 'synthetic.env',
		client: { publishableKey: live(A.publishableKey), frontendApi: 'clerk.demo-a.example', signInUrl: 'https://accounts.demo-a.example/sign-in' },
		staff: { publishableKey: live(B.publishableKey), frontendApi: 'clerk.demo-b.example', signInUrl: 'https://accounts.demo-b.example/sign-in' },
	};

	it('the development profile is sound and is what wrangler.jsonc carries', () => {
		expect(problems(loadProfile('development'))).toEqual([]);
		expect(activeProfile(wrangler)?.mode).toBe('development');
	});
	it('the production profile still has placeholders, so it is refused and plans no change', () => {
		const p = loadProfile('production');
		expect(problems(p).length).toBeGreaterThan(0);
		expect(problems(p).every((line) => line.endsWith('is still a PLACEHOLDER'))).toBe(true);
		const planned = plan('production', wrangler);
		expect(planned.refused).toBe(true);
		expect(planned.lines.join('\n')).not.toMatch(/pk_|sk_|https?:/);
	});
	it('refuses a sound-looking profile that mixes modes, hosts or instances', () => {
		expect(problems(synthetic)).toEqual([]);
		const bad = (change: (p: Profile) => void) => { const p: Profile = structuredClone(synthetic); change(p); return problems(p); };
		expect(bad((p) => { p.client.publishableKey = A.publishableKey; })).not.toEqual([]);
		expect(bad((p) => { p.staff.frontendApi = 'clerk.demo-a.example'; })).not.toEqual([]);
		expect(bad((p) => { p.client.signInUrl = 'https://accounts.demo-b.example/sign-in'; })).not.toEqual([]);
		expect(bad((p) => { p.staff.signInUrl = 'http://accounts.demo-b.example/sign-in'; })).not.toEqual([]);
		expect(bad((p) => { p.staff = structuredClone(p.client); })).not.toEqual([]);
	});
	it('rewrites every Clerk value of wrangler.jsonc, the issuers included, and switches back byte for byte', () => {
		const switched = rewrite(wrangler, synthetic);
		for (const vars of [parse(switched).vars, parse(switched).previews.vars]) {
			expect(vars).toMatchObject({ CLERK_CLIENT_PUBLISHABLE_KEY: synthetic.client.publishableKey, CLERK_STAFF_PUBLISHABLE_KEY: synthetic.staff.publishableKey, CLERK_CLIENT_SIGN_IN_URL: synthetic.client.signInUrl, CLERK_STAFF_SIGN_IN_URL: synthetic.staff.signInUrl });
		}
		const native = JSON.parse(parse(switched).vars.CLEARCASE_NATIVE_CONFIG) as { manifest: { staffIssuer: string; clients: { clientIssuer: string }[] } };
		expect(native.manifest.staffIssuer).toBe('https://clerk.demo-b.example');
		expect(native.manifest.clients.map((c) => c.clientIssuer)).toEqual(['https://clerk.demo-a.example']);
		expect(switched).not.toBe(wrangler);
		expect(rewrite(switched, loadProfile('development'))).toBe(wrangler);
		// The switched file is consistent for the runtime: its issuers are the ones its publishable keys name.
		expect(frontendApiHost(parse(switched).vars.CLERK_CLIENT_PUBLISHABLE_KEY)).toBe('clerk.demo-a.example');
	});
	afterEach(() => vi.unstubAllEnvs());
	it('names what a switch changes and never a value', () => {
		// Synthetic development secrets, so the plan does not depend on the machine's keys file.
		vi.stubEnv('STAGING_CLERK_SECRET_KEY', ['sk', 'test', 'Ab12Cd34Ef56Gh78Ij90Kl12'].join('_'));
		vi.stubEnv('STAGING_CLERK_STAFF_SECRET_KEY', ['sk', 'test', 'Mn34Op56Qr78St90Uv12Wx34'].join('_'));
		const planned = plan('development', rewrite(wrangler, synthetic));
		expect(planned.refused).toBe(false);
		const text = planned.lines.join('\n');
		for (const name of ['CLERK_CLIENT_PUBLISHABLE_KEY', 'CLERK_STAFF_SIGN_IN_URL', 'CLEARCASE_NATIVE_CONFIG', 'CLERK_CLIENT_SECRET_KEY', 'CLERK_STAFF_JWT_KEY']) expect(text).toContain(name);
		expect(text).toContain('CLERK_CLIENT_PUBLISHABLE_KEY: change');
		expect(text).not.toMatch(/pk_(test|live)_|sk_(test|live)_|https?:/);
	});
});
