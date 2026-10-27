// UNIT-ONLY composition. The planner's emitted vars and secret bindings (synthetic values supplied out of band) run through the REAL
// hostedServices and the REAL Clerk provider factory, against in-memory D1/R2/ASSETS/BROWSER doubles. A pass proves that the
// current source accepts the emitted settings. It is not health, login, tenant, Browser or runtime evidence, and Clerk is never contacted.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { hostedServices } from '../../../src/lib/server/runtime/hosted/services.ts';
import type { NativeRequestCompositions } from '../../../src/lib/server/runtime/hosted/compositions.ts';
import type { NativePreviewRenderOptions } from '../../../src/lib/viewer/hosted/native-render-check.ts';
import type { NativePreviewRenderChecker } from '../../../src/lib/viewer/hosted/render-check-contract.ts';
import { prepareHostedStaticInput } from '../../../scripts/hosted-static-input.ts';
import { NATIVE_RUNTIME_CONFIG_VAR, planNativeRuntimeConfig } from '../../../deploy/native-alpha/runtime-config.ts';
import { MemoryR2, SqliteD1 } from '../storage/doubles.ts';
import { exampleInput, exampleWithBrowserAllocation } from './example-input.ts';
import { nativeConfigOf, runtimeEnv } from './harness.ts';

const wiring = vi.hoisted(() => ({
	pins: null as unknown,
	composed: [] as unknown[],
	created: [] as { options: NativePreviewRenderOptions; checker: NativePreviewRenderChecker | null }[],
}));
vi.mock('../../../src/lib/server/runtime/hosted/render-pins.ts', () => ({ compiledPdfAssetPins: () => wiring.pins }));
vi.mock('../../../src/lib/server/runtime/hosted/compositions.ts', async (original) => {
	const actual = await original<typeof import('../../../src/lib/server/runtime/hosted/compositions.ts')>();
	return { ...actual, bindNativeRequestCompositions: (request: Request, ports: NativeRequestCompositions) => { wiring.composed.push(ports); return actual.bindNativeRequestCompositions(request, ports); } };
});
vi.mock('../../../src/lib/viewer/hosted/native-render-check.ts', async (original) => {
	const actual = await original<typeof import('../../../src/lib/viewer/hosted/native-render-check.ts')>();
	return { ...actual, async createNativePreviewRenderChecker(options: NativePreviewRenderOptions) {
		const checker = await actual.createNativePreviewRenderChecker(options);
		wiring.created.push({ options, checker });
		return checker;
	} };
});

const input = prepareHostedStaticInput(process.cwd());
afterAll(() => input.dispose());
afterEach(() => { wiring.composed = []; wiring.created = []; });
const plan = planNativeRuntimeConfig(exampleWithBrowserAllocation());

class Binding { #brand = 'binding'; calls = 0; fetch(_request: unknown) { if (this.#brand !== 'binding') throw Error('receiver'); this.calls++; return Promise.resolve(new Response('unused')); } }
function bindings(browser: boolean) {
	const db = Object.assign(new SqliteD1(), { withSession: (_constraint: 'first-primary') => db });
	return { DB: db, BUCKET: new MemoryR2(), ASSETS: new Binding(), ...(browser ? { BROWSER: new Binding() } : {}) };
}
async function compose(clientId: 'client-a' | 'client-b', change: (env: Record<string, unknown>) => void = () => {}) {
	wiring.pins = input.inventory; wiring.composed = []; wiring.created = [];
	const file = plan.clients.find((c) => c.clientId === clientId)!;
	const env = runtimeEnv(file, bindings(file.bindings.browser !== null));
	change(env);
	const ready = await hostedServices(new Request(`https://${clientId}.clearcase.test/`), env);
	return { ready, ports: wiring.composed[0] as NativeRequestCompositions | undefined, created: wiring.created[0], env, file };
}

describe('hostedServices accepts the emitted settings', () => {
	for (const clientId of ['client-a', 'client-b'] as const) {
		it(`${clientId}: real Clerk factory, native context and every data composition are built from the emitted values alone`, async () => {
			const { ready, ports, created, file } = await compose(clientId);
			expect(ready.ready).toBe(true);
			expect(ready.services.identity.kind).toBe('anonymous'); // no credential was presented; Clerk was not contacted
			expect(ports).toBeDefined();
			expect(ports).toMatchObject({ intake: { clientId }, downloads: { clientId }, imports: { clientId }, publication: { clientId } });
			expect(ports!.imports).not.toBeNull();   // hostedServices drops this silently when an import bound disagrees with storage
			expect(ports!.publication).not.toBeNull();
			const settings = nativeConfigOf(file) as { importBudget: unknown };
			expect(ports!.imports!.budget).toEqual(settings.importBudget);
			expect(ports!.intake!.budget).toEqual(nativeConfigOf(file).intakeBudget);
			// Both example clients are opted in: the real checker constructor accepts the emitted six fields, origin and pins.
			expect(file.bindings.browser).toBe('BROWSER');
			expect(created.checker).not.toBeNull();
			expect(created.options.budget).toEqual(nativeConfigOf(file).nativeRenderBudget);
			expect(Object.keys(created.options.budget!)).toHaveLength(6);
			expect(created.options.appOrigin).toBe(`https://${clientId}.clearcase.test`);
			expect(created.options.clientId).toBe(clientId);
			expect(created.options.browser).not.toBeNull();
		});
	}
	it('composes the import and staging routes on the Workers Paid request budget, with the stepped stager', async () => {
		const { ports, file } = await compose('client-a');
		const imports = ports!.imports!;
		const storage = nativeConfigOf(file) as { storageBudgets: { maxRowsPerBatch: number } };
		expect(imports.requestBudget).toEqual({ d1: 900, external: 4500, subrequests: 9000, rowsPerBatch: storage.storageBudgets.maxRowsPerBatch });
		expect(imports.staging).not.toBeNull();
		expect(imports.stepped).not.toBeNull();
		expect(imports.stepped!.bounds.stepsPerRequest).toBeGreaterThanOrEqual(1);
	});
	it('a client with no render budget composes publication with no checker (previews stay pending) and no BROWSER binding is planned', async () => {
		const noBrowser = planNativeRuntimeConfig(exampleInput()).clients[1]!;
		expect(noBrowser.bindings.browser).toBeNull();
		wiring.pins = input.inventory; wiring.composed = []; wiring.created = [];
		const ready = await hostedServices(new Request('https://client-b.clearcase.test/'), runtimeEnv(noBrowser, bindings(false)));
		expect(ready.ready).toBe(true);
		expect(wiring.created[0]!.checker).toBeNull();
		expect(wiring.created[0]!.options.budget).toBeNull();
		expect((wiring.composed[0] as NativeRequestCompositions).publication).not.toBeNull();
	});
	it('has teeth: the same composition is absent when the emitted settings are tampered with, so acceptance is not shape-only', async () => {
		const mutate = (change: (settings: Record<string, any>) => void) => (env: Record<string, unknown>) => {
			const settings = JSON.parse(env[NATIVE_RUNTIME_CONFIG_VAR] as string); change(settings); env[NATIVE_RUNTIME_CONFIG_VAR] = JSON.stringify(settings);
		};
		const none = async (change: (env: Record<string, unknown>) => void) => {
			wiring.composed = []; const { ready, ports } = await compose('client-a', change);
			expect(ready.ready).toBe(true); // sign-in stays reachable
			return ports;
		};
		expect(await none(mutate((s) => { s.deployment.worker = 'syn-client-b'; }))).toBeUndefined();               // foreign worker
		expect(await none(mutate((s) => { s.manifest.clients[0].clientIssuer = 'https://client-b.clerk.test'; }))).toBeUndefined(); // issuer disagrees with Clerk
		expect(await none(mutate((s) => { s.storageQuotas.maxUploadsPerCase = 0; }))).toBeUndefined();              // non-finite policy
		expect(await none((env) => { env.CLEARCASE_APP_ORIGIN = 'https://client-b.clearcase.test'; })).toBeUndefined(); // host disagrees with manifest
		expect(await none(mutate((s) => { s.schema = 'clearcase.native-runtime/2'; }))).toBeUndefined();
		const { ports } = await compose('client-a', mutate((s) => { s.importBudget.maxFiles = 65; }));
		expect(ports!.imports).toBeNull();
		const { created } = await compose('client-a', mutate((s) => { s.nativeRenderBudget.maxRunMs = 20_001; }));
		expect(created.checker).toBeNull();
		const { created: absent } = await compose('client-a', mutate((s) => { delete s.nativeRenderBudget; }));
		expect(absent.checker).toBeNull();
	});
	it('a missing secret binding makes the identity provider unavailable, so the plan\'s secret NAMES are load-bearing', async () => {
		for (const name of plan.clients[0]!.secrets) {
			const { ready, ports } = await compose('client-a', (env) => { delete env[name]; });
			expect(ready.ready).toBe(false);
			expect(ports).toBeUndefined();
		}
	});
});
