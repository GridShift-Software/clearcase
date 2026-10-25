// Every missing, inconsistent, over-limit or secret-valued input refuses the WHOLE plan, with a fixed message that never echoes input.
import { describe, expect, it } from 'vitest';
import { exampleInput, exampleWithBrowserAllocation, type Example } from './example-input.ts';
import { refusalOf } from './harness.ts';

const CANARY = 'canary-0f9e8d7c6b5a';
type Mutation = [name: string, mutate: (input: any) => void];
const refusals: Mutation[] = [
	['a missing top-level key', (i) => { delete i.browserAllocation; }],
	['an unknown top-level key', (i) => { i.extra = 1; }],
	['no clients', (i) => { i.clients = []; }],
	['more than eight clients', (i) => { i.clients = Array.from({ length: 9 }, () => i.clients[0]); }],
	['a client planned twice', (i) => { i.clients[1] = structuredClone(i.clients[0]); }],
	['a client missing from the manifest', (i) => { i.clients[0].deployment.clientId = 'client-z'; }],
	['a worker that is not the manifest\'s', (i) => { i.clients[0].deployment.worker = 'syn-client-b'; }],
	['a D1 id that is not the manifest\'s', (i) => { i.clients[0].deployment.d1DatabaseId = i.clients[1].deployment.d1DatabaseId; }],
	['a D1 name that is not the manifest\'s', (i) => { i.clients[0].deployment.d1DatabaseName = 'syn-client-b-db'; }],
	['an R2 bucket that is not the manifest\'s', (i) => { i.clients[0].deployment.r2Bucket = 'syn-client-b-files'; }],
	['a hostname that is not the manifest\'s', (i) => { i.clients[0].deployment.hostname = 'client-b.clearcase.test'; }],
	['a tuple missing a field', (i) => { delete i.clients[0].deployment.r2Bucket; }],
	['a tuple with an extra field', (i) => { i.clients[0].deployment.extra = 'x'; }],
	['an empty tuple field', (i) => { i.clients[0].deployment.worker = ''; }],
	['an app origin that is not https plus the manifest host', (i) => { i.clients[0].appOrigin = 'https://client-b.clearcase.test'; }],
	['an http app origin', (i) => { i.clients[0].appOrigin = 'http://client-a.clearcase.test'; }],
	['an app origin with a path', (i) => { i.clients[0].appOrigin = 'https://client-a.clearcase.test/app'; }],
	['an app origin with a port', (i) => { i.clients[0].appOrigin = 'https://client-a.clearcase.test:8443'; }],
	['a client Clerk host that is not the manifest client issuer', (i) => { i.clients[0].clerk.clientPublishableKey = i.clients[1].clerk.clientPublishableKey; }],
	['a staff Clerk host that is not the manifest staff issuer', (i) => { i.clients[0].clerk.staffPublishableKey = i.clients[1].clerk.clientPublishableKey; }],
	['client and staff as one Clerk instance', (i) => { i.clients[0].clerk.staffPublishableKey = i.clients[0].clerk.clientPublishableKey; }],
	['a live-mode publishable key', (i) => { i.clients[0].clerk.clientPublishableKey = i.clients[0].clerk.clientPublishableKey.replace('pk_test_', 'pk_live_'); }],
	['a malformed publishable key', (i) => { i.clients[0].clerk.clientPublishableKey = 'pk_test_!!'; }],
	['an http sign-in URL', (i) => { i.clients[0].clerk.signInUrl = 'http://client-a.clerk.test/sign-in'; }],
	['a sign-in URL with credentials', (i) => { i.clients[0].clerk.signInUrl = 'https://user:pw@client-a.clerk.test/sign-in'; }],
	['a non-origin API URL', (i) => { i.clients[0].clerk.apiUrl = 'https://api.clerk.test/v1'; }],
	['a bad audience', (i) => { i.clients[0].clerk.audience = 'has space'; }],
	['a non-boolean MFA flag', (i) => { i.clients[0].clerk.mfaRequired = 'true'; }],
	['a missing optional Clerk field (no defaulting)', (i) => { delete i.clients[0].clerk.signInUrl; }],
	['an unknown Clerk field', (i) => { i.clients[0].clerk.jwtKey = 'x'; }],
	['a missing policy section', (i) => { delete i.clients[0].policy.storageQuotas; }],
	['an unknown policy section', (i) => { i.clients[0].policy.unlimited = true; }],
	['a null audit section', (i) => { i.clients[0].policy.auditLimits = null; }],
	['an audit limit above its ceiling', (i) => { i.clients[0].policy.auditLimits.maxRows = 50_000_001; }],
	['a zero audit limit', (i) => { i.clients[0].policy.auditLimits.maxPageRows = 0; }],
	['an unknown audit limit', (i) => { i.clients[0].policy.auditLimits.maxEverything = 1; }],
	['a missing audit limit', (i) => { delete i.clients[0].policy.auditLimits.maxReadRows; }],
	['a fractional audit limit', (i) => { i.clients[0].policy.auditLimits.maxRows = 1.5; }],
	['storage budgets as JSON text', (i) => { i.clients[0].policy.storageBudgets = JSON.stringify(i.clients[0].policy.storageBudgets); }],
	['a missing storage budget', (i) => { delete i.clients[0].policy.storageBudgets.maxDocuments; }],
	['an unknown storage budget', (i) => { i.clients[0].policy.storageBudgets.maxMore = 1; }],
	['a zero storage budget', (i) => { i.clients[0].policy.storageBudgets.maxDocuments = 0; }],
	['an unlimited storage budget', (i) => { i.clients[0].policy.storageBudgets.maxDocuments = Infinity; }],
	['a NaN storage budget', (i) => { i.clients[0].policy.storageBudgets.maxDocuments = NaN; }],
	['a numeric-string storage budget', (i) => { i.clients[0].policy.storageBudgets.maxDocuments = '1000'; }],
	['an unsafe-integer storage budget', (i) => { i.clients[0].policy.storageBudgets.maxDocuments = 2 ** 53; }],
	['an original larger than the buffered bound', (i) => { i.clients[0].policy.storageBudgets.maxOriginalBytes = (1 << 20) + 1; }],
	['a missing quota', (i) => { delete i.clients[0].policy.storageQuotas.maxVersionsPerCase; }],
	['a negative quota', (i) => { i.clients[0].policy.storageQuotas.maxUploadsPerCase = -1; }],
	['a user-work limit above its ceiling', (i) => { i.clients[0].policy.userWorkLimits.maxSnapshotBytes = 2_000_001; }],
	['a user-work batch below its floor', (i) => { i.clients[0].policy.userWorkLimits.maxStatementsPerBatch = 7; }],
	['an unknown user-work limit', (i) => { i.clients[0].policy.userWorkLimits.maxMore = 2; }],
	['a missing user-work limit', (i) => { delete i.clients[0].policy.userWorkLimits.maxSnapshotBytes; }],
	['an intake file budget above the original-store bound', (i) => { i.clients[0].policy.intakeBudget.maxFileBytes = (1 << 20) + 1; }],
	['an intake metadata budget above 64 KiB', (i) => { i.clients[0].policy.intakeBudget.maxMetadataBytes = 65_537; }],
	['a missing intake budget field', (i) => { delete i.clients[0].policy.intakeBudget.maxMetadataBytes; }],
	['an import package above the stager bound', (i) => { i.clients[0].policy.importBudget.maxPackageBytes = (4 << 20) + 1; }],
	['an import file above its package', (i) => { i.clients[0].policy.importBudget.maxFileBytes = (4 << 20) + 1; }],
	['an import file count above the storage package files (a silent drop in hostedServices)', (i) => { i.clients[0].policy.storageBudgets.maxPackageFiles = 32; }],
	['an import file above the storage package file bound (a silent drop in hostedServices)', (i) => { i.clients[0].policy.storageBudgets.maxPackageFileBytes = 1 << 19; }],
	['more than 1024 import files', (i) => { i.clients[0].policy.importBudget.maxFiles = 1025; }],
	['a missing import field', (i) => { delete i.clients[0].policy.importBudget.maxRequestBytes; }],
	['a render budget missing a field', (i) => { delete i.clients[0].policy.nativeRenderBudget.maxPages; }],
	['a render budget with an extra field', (i) => { i.clients[0].policy.nativeRenderBudget.keepAliveMs = 1; }],
	['a render run above its ceiling', (i) => { i.clients[0].policy.nativeRenderBudget.maxRunMs = 20_001; }],
	['a render file above its ceiling', (i) => { i.clients[0].policy.nativeRenderBudget.maxFileBytes = 4_000_001; }],
	['a zero render budget', (i) => { i.clients[0].policy.nativeRenderBudget.maxPages = 0; }],
	['a render client run count above its ceiling', (i) => { i.clients[0].policy.nativeRenderBudget.maxRunsPerClientPerDay = 5; }],
	['a render case run count above the client\'s', (i) => { i.clients[0].policy.nativeRenderBudget.maxRunsPerCasePerDay = 2; i.clients[0].policy.nativeRenderBudget.maxRunsPerClientPerDay = 1; }],
	['a render budget that is not an object', (i) => { i.clients[0].policy.nativeRenderBudget = 'on'; }],
	['a missing render decision (no default to a null budget)', (i) => { delete i.clients[1].policy.nativeRenderBudget; }],
	['a manifest with duplicate resources', (i) => { i.manifest.clients[1].r2Bucket = i.manifest.clients[0].r2Bucket; }],
	['a manifest staff issuer with a path', (i) => { i.manifest.staffIssuer = 'https://staff.clerk.test/x'; }],
	['a manifest with an extra field', (i) => { i.manifest.extra = 1; }],
];
const allocations: Mutation[] = [
	['an allocation with no opted-in client', (i) => { for (const c of i.clients) c.policy.nativeRenderBudget = null; }],
	['one browser short of the planned clients', (i) => { i.browserAllocation.maxConcurrentBrowsers = 1; }],
	['one millisecond short of the worst-case day', (i) => { i.browserAllocation.maxReservedBrowserMsPerDay = 210_999; }],
	['a zero concurrency policy', (i) => { i.browserAllocation.maxConcurrentBrowsers = 0; }],
	['an unlimited daily policy', (i) => { i.browserAllocation.maxReservedBrowserMsPerDay = Infinity; }],
	['a fractional daily policy', (i) => { i.browserAllocation.maxReservedBrowserMsPerDay = 211_000.5; }],
	['a missing allocation field', (i) => { delete i.browserAllocation.maxConcurrentBrowsers; }],
	['an unknown allocation field', (i) => { i.browserAllocation.maxAccounts = 1; }],
	['an allocation that is not an object', (i) => { i.browserAllocation = 2; }],
];

describe('refusals', () => {
	it.each(refusals)('refuses %s', (_name, mutate) => {
		const input = exampleInput();
		mutate(input);
		expect(refusalOf(input)).toMatch(/\S/);
	});
	it.each(allocations)('refuses %s', (_name, mutate) => {
		const input = exampleWithBrowserAllocation();
		mutate(input);
		expect(refusalOf(input)).toMatch(/\S/);
	});
	it('refuses at the field that is wrong, by position and never by value', () => {
		const at = (mutate: (i: any) => void, area: RegExp) => { const i = exampleInput(); mutate(i); expect(refusalOf(i)).toMatch(area); };
		at((i) => { i.clients[0].deployment.worker = 'syn-client-b'; }, /input\.clients\[0\]\.deployment/);
		at((i) => { i.clients[1].appOrigin = 'http://client-b.clearcase.test'; }, /input\.clients\[1\]\.appOrigin/);
		at((i) => { i.clients[0].clerk.clientPublishableKey = i.clients[1].clerk.clientPublishableKey; }, /input\.clients\[0\]: the Clerk issuers/);
		at((i) => { i.clients[0].policy.auditLimits.maxRows = 0; }, /policy\.auditLimits/);
		at((i) => { delete i.clients[0].policy.storageQuotas.maxVersionsPerCase; }, /policy\.storageQuotas/);
		at((i) => { i.clients[1].policy.importBudget.maxFiles = 65; }, /input\.clients\[1\]\.policy\.importBudget/);
		at((i) => { i.clients[0].policy.nativeRenderBudget.maxRunMs = 20_001; }, /nativeRenderBudget\.maxRunMs/);
		at((i) => { i.manifest.clients[1].r2Bucket = i.manifest.clients[0].r2Bucket; }, /input\.manifest/);
	});
	it('the unmutated controls are accepted, so each refusal above is caused by its own mutation', () => {
		expect(() => refusalOf(exampleInput())).toThrow('input was accepted');
		expect(() => refusalOf(exampleWithBrowserAllocation())).toThrow('input was accepted');
	});
});

describe('secret-valued input', () => {
	const secrets: [string, string][] = [
		['a Clerk secret key', ['sk', 'test', 'a'.repeat(30)].join('_')],
		['a private key block', `-----BEGIN ${'RSA PRIVATE'} KEY-----`],
		['a signed token', ['eyJhbGciOiJSUzI1NiJ9', 'eyJzdWIiOiJ1In0', 'c2ln'].join('.')],
		['a token assignment', 'API_TOKEN=abcdefghijklmnop'],
		['a bearer credential', 'Authorization: Bearer abcdefghijklmnopqrstuvwx'],
		['an account-owned token', ['cfat', 'abcdefghijklmnopqrstu'].join('_')],
	];
	for (const [name, value] of secrets) {
		it(`refuses ${name} as an unknown field, a known string field, an array element or a key, and never echoes it`, () => {
			const places: ((input: any) => void)[] = [
				(i) => { i.clients[0].clerk.secretKey = value; },          // unknown field
				(i) => { i.clients[0].clerk.audience = value; },           // known string field
				(i) => { i.clients[0].clerk.signInUrl = `https://client-a.clerk.test/s?x=${value}`; },
				(i) => { i.extra = [value]; },                              // array element
				(i) => { i.clients[0][value] = 1; },                        // key
			];
			for (const place of places) {
				const input = exampleInput();
				place(input);
				const message = refusalOf(input);
				expect(message).not.toContain(value);
				expect(message).not.toContain(CANARY);
			}
		});
	}
	it('an unknown field carrying a canary is refused without echoing the canary or its key', () => {
		const input: Example & Record<string, unknown> = exampleInput();
		input[CANARY] = CANARY;
		expect(refusalOf(input)).not.toContain(CANARY);
	});
	it('never accepts the worker-secret VALUES in the nonsecret input even when well formed', () => {
		const input = exampleInput();
		Object.assign(input.clients[0]!.clerk, { jwtKey: '-----BEGIN PUBLIC KEY-----' + 'A'.repeat(392) + '-----END PUBLIC KEY-----' });
		expect(refusalOf(input)).toMatch(/exactly/);
	});
});
