// Offline planner: the emitted values are fed to the CURRENT configured-client parsers. Source-only settings acceptance is not
// health, login, tenant or runtime proof, and nothing here contacts Clerk, Cloudflare or any provider.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { CLERK_ENV, readClerkIdentityConfig } from '../../../src/lib/auth/clerk/config.ts';
import { clerkIdentityProviderFromEnv } from '../../../src/lib/auth/clerk/provider.ts';
import { auditConfig } from '../../../src/lib/audit/config.ts';
import { storageBudgets } from '../../../src/lib/storage/cloud/budgets.ts';
import { storageQuotas } from '../../../src/lib/storage/cloud/quotas.ts';
import { intakeBudget } from '../../../src/lib/submissions/budget.ts';
import { nativeImportBudget } from '../../../src/lib/results-review/native/budget.ts';
import { userWorkConfig } from '../../../src/lib/user-work/hosted/index.ts';
import { resolveExactDeployment, validateClientManifest } from '../../../src/lib/tenancy/manifest.ts';
import { NATIVE_RUNTIME_CONFIG_MANIFEST, NATIVE_RUNTIME_CONFIG_SCHEMA, NATIVE_RUNTIME_CONFIG_VAR, NATIVE_RUNTIME_SECRET_NAMES, NATIVE_RUNTIME_SETTINGS_SCHEMA, planNativeRuntimeConfig } from '../../../deploy/native-alpha/runtime-config.ts';
import { exampleInput } from './example-input.ts';
import { instances, nativeConfigOf, runtimeEnv } from './harness.ts';

const sha = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const plan = planNativeRuntimeConfig(exampleInput());
const file = (clientId: string) => plan.clients.find((c) => c.clientId === clientId)!;

describe('emitted vars, secret names and manifest', () => {
	it('emits exactly the nonsecret variables the current readers consume, per client', () => {
		expect(Object.keys(file('client-a').vars)).toEqual([
			CLERK_ENV.clientId, CLERK_ENV.appOrigin, CLERK_ENV.client.publishableKey, CLERK_ENV.staff.publishableKey, CLERK_ENV.mfaRequired,
			CLERK_ENV.signInUrl, CLERK_ENV.staffSignInUrl, NATIVE_RUNTIME_CONFIG_VAR,
		]);
		expect(file('client-a').vars).toMatchObject({ CLEARCASE_CLIENT_ID: 'client-a', CLEARCASE_APP_ORIGIN: 'https://client-a.clearcase.test', AUTH_MFA_REQUIRED: 'false',
			CLERK_CLIENT_SIGN_IN_URL: 'https://client-a.clerk.test/sign-in', CLERK_STAFF_SIGN_IN_URL: 'https://staff.clerk.test/sign-in' });
		expect(file('client-a').vars[CLERK_ENV.client.publishableKey]).toBe(instances['client-a'].publishableKey);
		expect(file('client-b').vars[CLERK_ENV.client.publishableKey]).toBe(instances['client-b'].publishableKey);
		expect(file('client-a').vars[CLERK_ENV.staff.publishableKey]).toBe(instances.staff.publishableKey);
	});
	it('returns secret binding NAMES only, plus the D1/R2/ASSETS bindings and BROWSER only for the opted-in client', () => {
		expect(NATIVE_RUNTIME_SECRET_NAMES).toEqual(['CLERK_CLIENT_SECRET_KEY', 'CLERK_CLIENT_JWT_KEY', 'CLERK_STAFF_SECRET_KEY', 'CLERK_STAFF_JWT_KEY']);
		for (const f of plan.clients) {
			expect(f.secrets).toEqual([...NATIVE_RUNTIME_SECRET_NAMES]);
			for (const name of f.secrets) expect(Object.hasOwn(f.vars, name)).toBe(false);
		}
		expect(file('client-a').bindings).toEqual({ d1: 'DB', r2: 'BUCKET', assets: 'ASSETS', browser: 'BROWSER' });
		expect(file('client-b').bindings).toEqual({ d1: 'DB', r2: 'BUCKET', assets: 'ASSETS', browser: null });
	});
	it('hashes every file in a manifest that claims no provider proof, provisioning or deployment', () => {
		const manifest = plan.manifest;
		expect(manifest).toMatchObject({ schema: NATIVE_RUNTIME_CONFIG_SCHEMA, settingsSchema: NATIVE_RUNTIME_SETTINGS_SCHEMA, providerProof: false, provisioned: false, deployed: false, plannedBrowserAllocation: null });
		expect([...plan.files.keys()].sort()).toEqual(['client-a.runtime.json', 'client-b.runtime.json', NATIVE_RUNTIME_CONFIG_MANIFEST]);
		for (const entry of manifest.clients) {
			const text = plan.files.get(entry.file)!;
			expect(entry).toMatchObject({ bytes: Buffer.byteLength(text), sha256: sha(text) });
			expect(entry.nativeConfigBytes).toBeLessThan(5120);
		}
		expect(plan.files.get(NATIVE_RUNTIME_CONFIG_MANIFEST)).toBe(plan.manifestText);
	});
	it('reports staff as unsupported rather than inventing identity-only configuration or borrowing a client database', () => {
		expect(plan.manifest.staff).toMatchObject({ slot: 'staff', runtimeConfig: 'unsupported' });
		expect(plan.clients.map((c) => c.clientId)).toEqual(['client-a', 'client-b']);
		expect(JSON.stringify(plan)).not.toContain('CLEARCASE_INSTANCE_ROLE');
	});
	it('is deterministic, deeply frozen, and snapshots its input once', () => {
		const input = exampleInput();
		const first = planNativeRuntimeConfig(input);
		input.clients[0]!.policy.auditLimits.maxRows = 1; // later caller mutation cannot change or retroactively alter the plan
		expect(first.manifestText).toBe(plan.manifestText);
		expect(planNativeRuntimeConfig(exampleInput()).manifestText).toBe(plan.manifestText);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.manifest.clients[0])).toBe(true);
	});
	it('contains no secret-shaped text, Clerk secret, JWT key or private key anywhere in its output', () => {
		const everything = [...plan.files.values()].join('\n');
		expect(everything).not.toMatch(/sk_(test|live)_|BEGIN [A-Z ]*KEY|eyJ[A-Za-z0-9_-]{6,}\./);
		for (const instance of Object.values(instances)) {
			expect(everything).not.toContain(instance.secretKey);
			expect(everything).not.toContain(instance.jwtKey.slice(30, 120));
		}
	});
});

describe('the current configured-client parsers accept what was emitted', () => {
	for (const clientId of ['client-a', 'client-b'] as const) {
		it(`${clientId}: readClerkIdentityConfig and clerkIdentityProviderFromEnv accept the vars with out-of-band synthetic secrets`, () => {
			const env = runtimeEnv(file(clientId));
			const read = readClerkIdentityConfig(env);
			expect(read.ok).toBe(true);
			const made = clerkIdentityProviderFromEnv(env, { authorizeCase: async () => {} });
			expect(made.ok).toBe(true);
			if (!made.ok) return;
			expect(made.config).toMatchObject({ clientId, appOrigin: `https://${clientId}.clearcase.test`, mfaRequired: false, apiUrl: null, audience: null,
				signInUrl: `https://${clientId}.clerk.test/sign-in`, staffSignInUrl: 'https://staff.clerk.test/sign-in' });
			expect(made.config.client.issuer).toBe(`https://${clientId}.clerk.test`);
			expect(made.config.staff.issuer).toBe('https://staff.clerk.test');
		});
		it(`${clientId}: CLEARCASE_NATIVE_CONFIG passes every parser nativeContext and hostedServices apply`, () => {
			const settings = nativeConfigOf(file(clientId)) as Record<string, any>;
			expect(settings.schema).toBe('clearcase.native-runtime/1');
			const manifest = validateClientManifest(settings.manifest);
			expect(manifest.clients).toHaveLength(1); // a Worker is never handed another client's resources
			const deployment = resolveExactDeployment(manifest, settings.deployment);
			expect(deployment.clientId).toBe(clientId);
			const audit = auditConfig({ clientId, trustedIssuers: [deployment.clientIssuer, deployment.staffIssuer], limits: settings.auditLimits });
			expect(audit.limits.maxRows).toBe(1000);
			const budgets = storageBudgets(settings.storageBudgets);
			expect(budgets).not.toBeNull();
			expect(storageQuotas(settings.storageQuotas)).not.toBeNull();
			expect(userWorkConfig({ clientId, limits: settings.userWorkLimits }).limits).toEqual(settings.userWorkLimits);
			expect(intakeBudget(settings.intakeBudget, { maxOriginalBytes: budgets!.maxOriginalBytes })).toEqual(settings.intakeBudget);
			expect(nativeImportBudget(settings.importBudget, { stagerMaxPackageBytes: budgets!.maxPackageBytes })).toEqual(settings.importBudget);
			expect(Object.hasOwn(settings, 'nativeRenderBudget')).toBe(clientId === 'client-a');
			expect(Object.keys(settings)).toEqual(['schema', 'deployment', 'manifest', 'auditLimits', 'storageBudgets', 'storageQuotas', 'userWorkLimits', 'intakeBudget', 'importBudget',
				...(clientId === 'client-a' ? ['nativeRenderBudget'] : [])]);
		});
	}
	it('emits optional Clerk values only when given, in the reader\'s normalized form', () => {
		const input = exampleInput();
		Object.assign(input.clients[0]!.clerk, { apiUrl: 'https://api.clerk.test', audience: 'clearcase-client-a', mfaRequired: true });
		const f = planNativeRuntimeConfig(input).clients[0]!;
		expect(f.vars).toMatchObject({ CLERK_API_URL: 'https://api.clerk.test', CLERK_SESSION_AUDIENCE: 'clearcase-client-a', AUTH_MFA_REQUIRED: 'true' });
		const made = clerkIdentityProviderFromEnv(runtimeEnv(f), { authorizeCase: async () => {} });
		expect(made.ok && made.config).toMatchObject({ apiUrl: 'https://api.clerk.test', audience: 'clearcase-client-a', mfaRequired: true });
	});
});
