import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	checkWorkersDevBootstrapInvocation, planWorkersDevBootstrap, prepareWorkersDevBootstrap, readWorkersDevBootstrap,
	type BootstrapSettings,
} from '../../../../deploy/native-alpha/workers-dev-bootstrap.ts';
import { NATIVE_RUNTIME_CONFIG_VAR, planNativeRuntimeConfig } from '../../../../deploy/native-alpha/runtime-config.ts';
import { digestDir } from '../../../../deploy/probes/target.ts';
import { NATIVE_ADAPTER_HEADERS } from '../../../../deploy/native-alpha/pipeline.ts';
import { exampleInput, exampleWithBrowserAllocation } from '../../../hosted-foundation/native-runtime-config/example-input.ts';

// Everything here is synthetic: invented hostnames, Clerk hosts and bounds. Not provider, runtime, login or deployment evidence.
const SOURCE = 'a'.repeat(40);
const STAMP = { revision: SOURCE, dirty: false, exported: false, builtAt: '2026-10-25T06:40:03.000Z', bun: '1.4.2', buildId: 'synthetic-runtime-config', target: 'cloudflare', profile: 'production' };
const worker = () => `const embedded = ${JSON.stringify(JSON.stringify(STAMP))};
const forward = (name) => import(name);
const kit_manifest = (() => { return { app_dir: "_app", app_path: "_app", assets: new Set(["robots.txt"]), client: { start: "_app/immutable/start.js", app: "_app/immutable/app.js", imports: ["_app/immutable/chunk.js"], stylesheets: ["_app/immutable/site.css"], fonts: [] } }; })();
const server = create_server(kit_manifest);
export default { async fetch() { await server.respond(); await import("node:async_hooks"); await forward("node:crypto"); return new Response(embedded); } };\n`;
const sha = (bytes: string | Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const cfg = (text: string): Record<string, any> => JSON.parse(text);
const roots: string[] = [];
afterEach(() => {
	vi.doUnmock('../../../../deploy/native-alpha/runtime-config.ts');
	vi.resetModules();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The exact bootstrap targets the runtime configuration must name; hostnames are workers.dev shaped under an invented subdomain. */
const TUPLE = {
	'client-a': { worker: 'cc-sbx-a-20261023', d1DatabaseName: 'cc-sbx-a-20261023-db', d1DatabaseId: 'cd257736-7bf3-49f6-8544-ac58c2207802', r2Bucket: 'cc-sbx-a-20261023-files', hostname: 'cc-sbx-a-20261023.synthetic-sub.workers.dev' },
	'client-b': { worker: 'cc-sbx-b-20261023', d1DatabaseName: 'cc-sbx-b-20261025-r1-db', d1DatabaseId: '7c340891-9fcc-4398-8128-68abe726f130', r2Bucket: 'cc-sbx-b-20261023-files', hostname: 'cc-sbx-b-20261023.synthetic-sub.workers.dev' },
} as const;
const SLOTS = ['client-a', 'client-b'] as const;
type Mode = 'a' | 'both' | 'none';
/** A fresh planner input for the bootstrap targets: 'a' renders client A only, 'both' renders both, 'none' renders neither. */
function runtime(mode: Mode = 'a'): any {
	const input: any = mode === 'both' ? exampleWithBrowserAllocation() : exampleInput();
	if (mode === 'none') { input.clients[0].policy.nativeRenderBudget = null; input.browserAllocation = null; }
	SLOTS.forEach((slot, i) => {
		Object.assign(input.clients[i].deployment, { clientId: slot, ...TUPLE[slot] });
		Object.assign(input.manifest.clients[i], { clientId: slot, ...TUPLE[slot] });
		input.clients[i].appOrigin = `https://${TUPLE[slot].hostname}`;
	});
	return input;
}
const BROWSERS: Record<Mode, readonly ('client-a' | 'client-b')[]> = { a: ['client-a'], both: ['client-a', 'client-b'], none: [] };
const plannerVars = (input: unknown) => new Map<string, Readonly<Record<string, string>>>(planNativeRuntimeConfig(input).clients.map((c) => [c.clientId as string, c.vars] as const));

function fixture(mode: Mode = 'a') {
	const root = mkdtempSync(path.join(os.tmpdir(), 'cc-bootstrap-runtime-'));
	roots.push(root);
	const artifact = path.join(root, 'source-artifact'), out = path.join(root, 'stage');
	const put = (rel: string, bytes: string) => {
		mkdirSync(path.dirname(path.join(artifact, rel)), { recursive: true });
		writeFileSync(path.join(artifact, rel), bytes);
	};
	put('cloudflare/_worker.js', worker());
	put('public/_app/version.json', JSON.stringify({ version: SOURCE }));
	put('public/robots.txt', 'User-agent: *\nDisallow:\n');
	put('public/_app/immutable/start.js', 'export function start() {}\n');
	put('public/_app/immutable/app.js', 'import "./chunk.js";\n');
	put('public/_app/immutable/chunk.js', 'export const loaded = true;\n');
	put('public/_app/immutable/site.css', 'body { color: black; }\n');
	put('public/_headers', NATIVE_ADAPTER_HEADERS);
	const pins = { source: SOURCE, artifact: digestDir(artifact), entry: sha(readFileSync(path.join(artifact, 'cloudflare/_worker.js'))) };
	const settings: BootstrapSettings = {
		pins, compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'],
		...(BROWSERS[mode].length ? { browserClients: [...BROWSERS[mode]] } : {}), runtimeConfig: runtime(mode),
	};
	const argv = (slot: string) => ['wrangler', 'deploy', '--config', `${slot}.wrangler.json`];
	const invoke = (slot: 'client-a' | 'client-b' | 'staff', s: unknown = settings) => checkWorkersDevBootstrapInvocation({ stage: out, settings: s, cwd: out, slot, argv: argv(slot) });
	return { root, artifact, out, settings, argv, invoke, prepare: () => prepareWorkersDevBootstrap({ artifact, out, settings }), read: (s: unknown = settings) => readWorkersDevBootstrap({ stage: out, settings: s }) };
}
const shellSettings = (): BootstrapSettings => ({ pins: { source: SOURCE, artifact: `sha256:${'b'.repeat(64)}`, entry: `sha256:${'c'.repeat(64)}` }, compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'] });
const configured = (mode: Mode = 'a', edit?: (input: any) => void): BootstrapSettings => {
	const input = runtime(mode);
	edit?.(input);
	return { ...shellSettings(), ...(BROWSERS[mode].length ? { browserClients: [...BROWSERS[mode]] } : {}), runtimeConfig: input };
};
const refusal = (settings: unknown): string => {
	try { planWorkersDevBootstrap(settings); } catch (error) { return String((error as Error).message); }
	throw new Error('accepted');
};
const REFUSED = /^runtimeConfig: /;

describe('absent runtime configuration preserves the existing shell-only output exactly', () => {
	it('emits exactly the two identity vars and the previous record shape', () => {
		const plan = planWorkersDevBootstrap(shellSettings());
		expect(Object.keys(plan)).toEqual(['schema', 'settings', 'targets']);
		expect(plan.settings).toEqual(shellSettings());
		plan.targets.forEach((t) => expect(Object.keys(t)).not.toContain('runtime'));
		expect(plan.targets.map((t) => cfg(t.configText).vars)).toEqual([
			{ CLEARCASE_INSTANCE_ROLE: 'client', CLEARCASE_CLIENT_ID: 'client-a' },
			{ CLEARCASE_INSTANCE_ROLE: 'client', CLEARCASE_CLIENT_ID: 'client-b' },
			{ CLEARCASE_INSTANCE_ROLE: 'staff', CLEARCASE_CLIENT_ID: '' },
		]);
		expect(plan.targets.map((t) => t.readiness)).toEqual(['services-unconfigured', 'services-unconfigured', 'unconfigured-portal-shell']);
	});
	it('a browser opt-in without runtime configuration is unchanged, and the pinned config bytes do not move', () => {
		const plan = planWorkersDevBootstrap({ ...shellSettings(), browserClients: ['client-a'] });
		expect(plan.targets.map((t) => 'browser' in cfg(t.configText))).toEqual([true, false, false]);
		expect(plan.targets[0]!.configText).toBe(`${JSON.stringify({
			name: 'cc-sbx-a-20261023', account_id: 'fb4c31b91c5d89b7a54afbdc34823170', main: 'artifact/cloudflare/_worker.js', no_bundle: true, find_additional_modules: false, minify: false,
			compatibility_date: '2026-10-23', compatibility_flags: ['nodejs_compat'], send_metrics: false, workers_dev: true, preview_urls: false, routes: [],
			assets: { directory: 'artifact/public', binding: 'ASSETS' }, vars: { CLEARCASE_INSTANCE_ROLE: 'client', CLEARCASE_CLIENT_ID: 'client-a' },
			d1_databases: [{ binding: 'DB', database_name: 'cc-sbx-a-20261023-db', database_id: 'cd257736-7bf3-49f6-8544-ac58c2207802' }],
			r2_buckets: [{ binding: 'BUCKET', bucket_name: 'cc-sbx-a-20261023-files', jurisdiction: 'eu' }], browser: { binding: 'BROWSER' },
		}, null, 2)}\n`);
	});
});

describe('explicit runtime configuration is merged through the planner into every target', () => {
	it('emits the planner vars, role and client locked, into both the target record and its Wrangler config', () => {
		const input = runtime('a'), plan = planWorkersDevBootstrap({ ...shellSettings(), browserClients: ['client-a'], runtimeConfig: input });
		const vars = plannerVars(input);
		expect(Object.keys(plan)).toEqual(['schema', 'settings', 'targets', 'runtimeConfig']);
		expect(plan.settings).toEqual({ ...shellSettings(), browserClients: ['client-a'] });
		for (const [i, slot] of SLOTS.entries()) {
			const t = plan.targets[i]!, config = cfg(t.configText);
			expect(config.vars).toEqual({ CLEARCASE_INSTANCE_ROLE: 'client', ...vars.get(slot) });
			expect(config.vars.CLEARCASE_CLIENT_ID).toBe(slot);
			expect(Object.keys(config.vars).slice(0, 2)).toEqual(['CLEARCASE_INSTANCE_ROLE', 'CLEARCASE_CLIENT_ID']);
			expect(config).not.toHaveProperty('secrets');
			expect(JSON.parse(config.vars[NATIVE_RUNTIME_CONFIG_VAR]).deployment).toMatchObject({ clientId: slot, worker: config.name, hostname: TUPLE[slot].hostname, d1DatabaseId: config.d1_databases[0].database_id, d1DatabaseName: config.d1_databases[0].database_name, r2Bucket: config.r2_buckets[0].bucket_name });
			expect(t).toMatchObject({ readiness: 'services-unconfigured', runtime: { varNames: Object.keys(vars.get(slot)!), requiredSecretNames: ['CLERK_CLIENT_SECRET_KEY', 'CLERK_CLIENT_JWT_KEY', 'CLERK_STAFF_SECRET_KEY', 'CLERK_STAFF_JWT_KEY'] } });
			expect(sha(t.configText)).toBe(t.configSha256);
		}
		expect(plan.runtimeConfig!.manifestSha256).toBe(sha(planNativeRuntimeConfig(input).manifestText));
		expect(plan.runtimeConfig!.manifest).toEqual(planNativeRuntimeConfig(input).manifest);
		expect(JSON.stringify(plan.runtimeConfig)).toMatch(/"providerProof":false.*"provisioned":false.*"deployed":false/);
		expect(Object.isFrozen(plan.runtimeConfig)).toBe(true);
		expect(Object.isFrozen(plan.targets[0]!.runtime)).toBe(true);
	});
	it('binds BROWSER exactly where the plan renders, for every renderer mix', () => {
		for (const mode of ['a', 'both', 'none'] as const) {
			const plan = planWorkersDevBootstrap(configured(mode));
			expect(plan.targets.map((t) => cfg(t.configText).browser)).toEqual([0, 1, 2].map((i) => i < 2 && BROWSERS[mode].includes(SLOTS[i]!) ? { binding: 'BROWSER' } : undefined));
			expect(plan.runtimeConfig!.manifest.clients.map((c) => c.browserBinding)).toEqual(SLOTS.map((s) => BROWSERS[mode].includes(s) ? 'BROWSER' : null));
		}
	});
	it('keeps staff an honest ASSETS-only identity shell whatever the configuration', () => {
		const plan = planWorkersDevBootstrap(configured('both')), staff = plan.targets[2]!, config = cfg(staff.configText);
		expect(config.vars).toEqual({ CLEARCASE_INSTANCE_ROLE: 'staff', CLEARCASE_CLIENT_ID: '' });
		for (const key of ['d1_databases', 'r2_buckets', 'browser', 'secrets', 'services']) expect(config).not.toHaveProperty(key);
		expect(staff).toMatchObject({ clientId: null, stores: null, readiness: 'unconfigured-portal-shell' });
		expect(staff).not.toHaveProperty('runtime');
		expect(plan.runtimeConfig!.manifest.staff).toMatchObject({ slot: 'staff', runtimeConfig: 'unsupported' });
		expect(plan.runtimeConfig!.manifest).toMatchObject({ providerProof: false, provisioned: false, deployed: false });
	});
	it('accepts a single configured client and leaves the other as the unchanged shell', () => {
		const input = runtime('a');
		input.clients = [input.clients[0]];
		const plan = planWorkersDevBootstrap({ ...shellSettings(), browserClients: ['client-a'], runtimeConfig: input });
		expect(cfg(plan.targets[0]!.configText).vars).toHaveProperty(NATIVE_RUNTIME_CONFIG_VAR);
		expect(cfg(plan.targets[1]!.configText).vars).toEqual({ CLEARCASE_INSTANCE_ROLE: 'client', CLEARCASE_CLIENT_ID: 'client-b' });
		expect(plan.targets[1]!).not.toHaveProperty('runtime');
	});
	it('captures the configuration once: later edits to the caller object change nothing, and the record is frozen', () => {
		const settings = configured('a'), plan = planWorkersDevBootstrap(settings);
		const before = JSON.stringify(plan);
		(settings.runtimeConfig as any).clients[0].policy.nativeRenderBudget.maxRunMs = 1;
		(settings.runtimeConfig as any).manifest.staffIssuer = 'https://elsewhere.test';
		(settings as any).browserClients.push('client-b');
		expect(JSON.stringify(plan)).toBe(before);
		expect(Object.isFrozen(plan.targets[0])).toBe(true);
		expect(() => { (plan.targets[0] as any).runtime.varNames.push('X'); }).toThrow();
	});
});

describe('the runtime configuration must match the exact bootstrap targets', () => {
	const both = (edit: (side: any) => void) => (input: any) => { edit(input.manifest.clients[0]); edit(input.clients[0].deployment); };
	it.each([
		['worker', both((s) => { s.worker = 'cc-sbx-a-other'; })],
		['d1 database name', both((s) => { s.d1DatabaseName = 'cc-sbx-b-20261025-r1-db'; })],
		['d1 database id', both((s) => { s.d1DatabaseId = '7c340891-9fcc-4398-8128-68abe726f130'; })],
		['r2 bucket', both((s) => { s.r2Bucket = 'cc-sbx-a-other-files'; })],
		['hostname off workers.dev', (input: any) => { both((s) => { s.hostname = 'cc-sbx-a-20261023.synthetic-sub.example.test'; })(input); input.clients[0].appOrigin = 'https://cc-sbx-a-20261023.synthetic-sub.example.test'; }],
		['hostname naming another worker', (input: any) => { both((s) => { s.hostname = 'cc-sbx-b-20261023.synthetic-sub.workers.dev'; })(input); input.clients[0].appOrigin = 'https://cc-sbx-b-20261023.synthetic-sub.workers.dev'; }],
		['hostname without a subdomain label', (input: any) => { both((s) => { s.hostname = 'cc-sbx-a-20261023.workers.dev'; })(input); input.clients[0].appOrigin = 'https://cc-sbx-a-20261023.workers.dev'; }],
		['hostname with extra labels', (input: any) => { both((s) => { s.hostname = 'cc-sbx-a-20261023.x.synthetic-sub.workers.dev'; })(input); input.clients[0].appOrigin = 'https://cc-sbx-a-20261023.x.synthetic-sub.workers.dev'; }],
		['client a carrying client b\'s whole tuple', (input: any) => { Object.assign(input.manifest.clients[0], TUPLE['client-b']); Object.assign(input.clients[0].deployment, TUPLE['client-b']); input.clients[0].appOrigin = `https://${TUPLE['client-b'].hostname}`; input.manifest.clients[1].clientId = 'client-c'; input.manifest.clients[1].worker = 'syn-other'; input.manifest.clients[1].d1DatabaseName = 'syn-other-db'; input.manifest.clients[1].d1DatabaseId = '33333333-1111-4111-8111-111111111111'; input.manifest.clients[1].r2Bucket = 'syn-other-files'; input.manifest.clients[1].hostname = 'other.clearcase.test'; }],
		['a client id that is not a bootstrap slot', both((s) => { s.clientId = 'client-c'; })],
		['the staff slot as a client', both((s) => { s.clientId = 'staff'; })],
	])('refuses a mismatched %s, before any IO', (_, edit) => {
		const f = fixture(), input = runtime('a');
		edit(input);
		const settings = { ...f.settings, runtimeConfig: input };
		expect(() => planWorkersDevBootstrap(settings)).toThrow(REFUSED);
		expect(() => prepareWorkersDevBootstrap({ artifact: f.artifact, out: f.out, settings })).toThrow(REFUSED);
		expect(existsSync(f.out)).toBe(false);
	});
	it('refuses the same client planned twice and the client in the wrong slot position by id', () => {
		const input = runtime('a');
		input.clients.push(structuredClone(input.clients[0]));
		expect(() => planWorkersDevBootstrap({ ...shellSettings(), browserClients: ['client-a'], runtimeConfig: input })).toThrow(REFUSED);
	});
	it('never echoes a hostname, key or value in a refusal', () => {
		const input = runtime('a');
		input.clients[0].deployment.worker = input.manifest.clients[0].worker = 'sentinel-worker-name';
		const message = refusal({ ...shellSettings(), browserClients: ['client-a'], runtimeConfig: input });
		expect(message).toMatch(REFUSED);
		for (const secret of ['sentinel-worker-name', 'synthetic-sub', 'pk_test', 'clerk.test']) expect(message).not.toContain(secret);
	});
});

describe('the account workers.dev subdomain is pinned by the bootstrap, never trusted from the caller', () => {
	// The observed account subdomain (public provider metadata). Written out here on purpose: the test must not import the pin it checks.
	const PINNED = 'shiny-sunset-211d';
	const hostFor = (slot: 'client-a' | 'client-b', label: string) => `${TUPLE[slot].worker}.${label}.workers.dev`;
	const rehost = (input: any, i: number, hostname: string) => {
		input.manifest.clients[i].hostname = hostname;
		input.clients[i].deployment.hostname = hostname;
		input.clients[i].appOrigin = `https://${hostname}`;
	};
	const labelled = (mode: Mode, labels: readonly [string, string]) => {
		const input = runtime(mode);
		SLOTS.forEach((slot, i) => rehost(input, i, hostFor(slot, labels[i]!)));
		return input;
	};
	const settingsFor = (mode: Mode, input: unknown) => ({ ...shellSettings(), ...(BROWSERS[mode].length ? { browserClients: [...BROWSERS[mode]] } : {}), runtimeConfig: input });
	const PIN_REFUSAL = 'runtimeConfig: a planned hostname is not this Worker on the pinned workers.dev account subdomain';

	it('accepts exactly <worker>.<pinned label>.workers.dev for every configured client, and puts it in the origin and the deployment record', () => {
		const plan = planWorkersDevBootstrap(settingsFor('both', labelled('both', [PINNED, PINNED])));
		for (const [i, slot] of SLOTS.entries()) {
			const vars = cfg(plan.targets[i]!.configText).vars;
			expect(vars.CLEARCASE_APP_ORIGIN).toBe(`https://${hostFor(slot, PINNED)}`);
			expect(JSON.parse(vars[NATIVE_RUNTIME_CONFIG_VAR]).deployment.hostname).toBe(hostFor(slot, PINNED));
		}
	});
	it('refuses the exact attacker-acct origin for the only configured client, before any IO', () => {
		const f = fixture(), input = labelled('a', ['attacker-acct', 'attacker-acct']);
		const settings = { ...f.settings, runtimeConfig: input };
		expect(input.clients[0].appOrigin).toBe('https://cc-sbx-a-20261023.attacker-acct.workers.dev');
		expect(refusal(settings)).toBe(PIN_REFUSAL);
		expect(() => prepareWorkersDevBootstrap({ artifact: f.artifact, out: f.out, settings })).toThrow(PIN_REFUSAL);
		expect(existsSync(f.out)).toBe(false);
	});
	it.each([
		['attacker-acct on both clients', ['attacker-acct', 'attacker-acct']],
		['the pinned label on A and a foreign one on B', [PINNED, 'attacker-acct']],
		['a foreign label on A and the pinned one on B', ['attacker-acct', PINNED]],
		['two different foreign labels', ['attacker-acct', 'other-acct']],
		['an invented but well-formed label on both', ['synthetic-sub', 'synthetic-sub']],
		['the pinned label with a suffix', [`${PINNED}x`, `${PINNED}x`]],
		['the pinned label with a prefix', [`x${PINNED}`, `x${PINNED}`]],
	] as const)('refuses %s, whatever the planner accepts', (_, labels) => {
		expect(refusal(settingsFor('both', labelled('both', labels)))).toBe(PIN_REFUSAL);
	});
	it.each([
		['another worker under the pinned label', hostFor('client-b', PINNED)],
		['no account label', 'cc-sbx-a-20261023.workers.dev'],
		['an extra label before the pinned one', `cc-sbx-a-20261023.x.${PINNED}.workers.dev`],
		['a custom domain carrying the pinned label', `cc-sbx-a-20261023.${PINNED}.example.test`],
	])('keeps refusing %s for client A', (_, hostname) => {
		const input = runtime('a');
		rehost(input, 0, hostname);
		expect(() => planWorkersDevBootstrap(settingsFor('a', input))).toThrow(REFUSED);
	});
	it('never echoes the caller label or the pinned label in the refusal', () => {
		const message = refusal(settingsFor('a', labelled('a', ['attacker-acct', 'attacker-acct'])));
		for (const label of ['attacker-acct', PINNED]) expect(message).not.toContain(label);
	});
	it('does not accept a foreign label through the reread or an invocation either', () => {
		const f = fixture('both');
		f.prepare();
		const foreign = { ...f.settings, runtimeConfig: labelled('both', ['attacker-acct', 'attacker-acct']) };
		expect(() => f.read(foreign)).toThrow(REFUSED);
		expect(() => f.invoke('client-a', foreign)).toThrow(REFUSED);
	});
});

describe('the Browser opt-in agrees with the planned renderers', () => {
	it.each([
		['renderer A without browserClients', { runtimeConfig: runtime('a') }],
		['renderer A but browserClients names B', { runtimeConfig: runtime('a'), browserClients: ['client-b'] }],
		['renderers A and B but only A listed', { runtimeConfig: runtime('both'), browserClients: ['client-a'] }],
		['renderer A only but both listed', { runtimeConfig: runtime('a'), browserClients: ['client-a', 'client-b'] }],
		['no renderer but A listed', { runtimeConfig: runtime('none'), browserClients: ['client-a'] }],
		['no renderer but both listed', { runtimeConfig: runtime('none'), browserClients: ['client-a', 'client-b'] }],
		['renderers on both but browserClients absent', { runtimeConfig: runtime('both') }],
	])('refuses %s', (_, extra) => {
		expect(() => planWorkersDevBootstrap({ ...shellSettings(), ...extra })).toThrow(REFUSED);
	});
	it('refuses a listed client that has no planned entry at all', () => {
		const input = runtime('a');
		input.clients = [input.clients[0]];
		expect(() => planWorkersDevBootstrap({ ...shellSettings(), browserClients: ['client-a', 'client-b'], runtimeConfig: input })).toThrow(REFUSED);
	});
	it.each(['a', 'both', 'none'] as const)('accepts the exact agreement for %s', (mode) => {
		expect(() => planWorkersDevBootstrap(configured(mode))).not.toThrow();
	});
	it('still refuses staff and unknown slots in browserClients', () => {
		for (const bad of [['staff'], ['client-a', 'staff'], ['client-c']]) expect(() => planWorkersDevBootstrap({ ...configured('a'), browserClients: bad })).toThrow(/browserClients/);
	});
});

describe('malformed, secret-shaped and over-ceiling configuration is refused by the planner and never echoed', () => {
	const mal = (name: string, edit: (input: any) => void) => [name, edit] as const;
	it.each([
		mal('a missing storage budget field', (i) => { delete i.clients[0].policy.storageBudgets.maxDocuments; }),
		mal('an unknown storage budget field', (i) => { i.clients[0].policy.storageBudgets.extra = 1; }),
		mal('a zero render run time', (i) => { i.clients[0].policy.nativeRenderBudget.maxRunMs = 0; }),
		mal('a render budget above its ceiling', (i) => { i.clients[0].policy.nativeRenderBudget.maxPages = 1e9; }),
		mal('a fractional render budget', (i) => { i.clients[0].policy.nativeRenderBudget.maxPages = 1.5; }),
		mal('a case budget above the client budget', (i) => { i.clients[0].policy.nativeRenderBudget.maxRunsPerCasePerDay = 5; }),
		mal('a non-finite budget', (i) => { i.clients[0].policy.intakeBudget.maxFileBytes = Number.NaN; }),
		mal('an import budget above the package bound', (i) => { i.clients[0].policy.importBudget.maxFiles = 10_000; }),
		mal('a null allocation although client A renders', (i) => { i.browserAllocation = null; }),
		mal('an allocation that does not fit the planned clients', (i) => { i.browserAllocation.maxReservedBrowserMsPerDay = 1; }),
		mal('an allocation with fewer browsers than renderers', (i) => { i.browserAllocation.maxConcurrentBrowsers = 0; }),
		mal('an allocation with an extra field', (i) => { i.browserAllocation.provisioned = true; }),
		mal('an allocation although no client renders', (i) => { i.clients[0].policy.nativeRenderBudget = null; }),
		mal('a missing allocation key', (i) => { delete i.browserAllocation; }),
		mal('a live publishable key', (i) => { i.clients[0].clerk.clientPublishableKey = ['pk', 'live', Buffer.from('client-a.clerk.test$').toString('base64')].join('_'); }),
		mal('an unknown client field', (i) => { i.clients[0].vars = { CLEARCASE_INSTANCE_ROLE: 'staff' }; }),
		mal('a reserved role name smuggled into the clerk block', (i) => { i.clients[0].clerk.CLEARCASE_INSTANCE_ROLE = 'staff'; }),
		mal('a secret binding name smuggled into the clerk block', (i) => { i.clients[0].clerk.CLERK_CLIENT_SECRET_KEY = 'x'; }),
		mal('a top-level vars map', (i) => { i.vars = { CLEARCASE_INSTANCE_ROLE: 'staff' }; }),
		mal('a top-level secrets list', (i) => { i.secrets = ['CLERK_CLIENT_SECRET_KEY']; }),
	])('refuses %s', (_, edit) => {
		const message = refusal(configured('a', edit));
		expect(message).toMatch(REFUSED);
		for (const leak of ['pk_', 'clerk.test', 'synthetic-sub']) expect(message).not.toContain(leak);
	});
	const SECRETS: readonly (readonly [string, string])[] = [
		['a secret key', ['sk', 'test', 'a'.repeat(24)].join('_')],
		['a bearer token', `Bearer ${'A1b2'.repeat(6)}`],
		['an assignment', ['api', 'key=hunter2hunter2'].join('_')],
		['a JWT', ['eyJhbGciOiJSUzI1NiJ9', 'eyJzdWIiOiJ4In0', 'c2lnbmF0dXJl'].join('.')],
	];
	it.each(SECRETS)('refuses %s in a nonsecret field and never echoes it', (_, value) => {
		for (const field of ['signInUrl', 'staffSignInUrl', 'audience'] as const) {
			const settings = configured('a', (i) => { i.clients[0].clerk[field] = value; });
			const message = refusal(settings);
			expect(message).toMatch(REFUSED);
			expect(message).not.toContain(value);
		}
		const settings = configured('a', (i) => { i.clients[0].deployment.d1DatabaseName = i.manifest.clients[0].d1DatabaseName = value; });
		expect(refusal(settings)).toMatch(REFUSED);
	});
});

describe('the configuration input is captured as strict data before any IO', () => {
	it.each([null, undefined, '{}', 7, [], () => ({})])('refuses a present runtimeConfig that is %s', (value) => {
		expect(() => planWorkersDevBootstrap({ ...shellSettings(), runtimeConfig: value })).toThrow(REFUSED);
	});
	it('treats a present-but-undefined key as an explicit, refused configuration', () => {
		expect(() => planWorkersDevBootstrap({ ...shellSettings(), runtimeConfig: undefined })).toThrow(REFUSED);
	});
	it('never runs a getter, toJSON or Proxy trap anywhere inside the configuration', () => {
		const calls: string[] = [];
		const trap = (name: string): any => () => { calls.push(name); return undefined; };
		const poisoned: [string, (input: any) => unknown][] = [
			['top getter', (i) => Object.defineProperty(i, 'clients', { get: () => (calls.push('top getter'), i.clients), enumerable: true })],
			['nested getter', (i) => { Object.defineProperty(i.clients[0].policy.storageBudgets, 'maxDocuments', { get: () => (calls.push('nested getter'), 5), enumerable: true }); return i; }],
			['toJSON', (i) => { i.clients[0].toJSON = trap('toJSON'); return i; }],
			['proxy', (i) => new Proxy(i, { get: trap('get'), ownKeys: trap('ownKeys'), getOwnPropertyDescriptor: trap('gopd'), getPrototypeOf: trap('getPrototypeOf') })],
			['proxied client', (i) => { i.clients[0] = new Proxy(i.clients[0], { get: trap('get'), ownKeys: trap('ownKeys'), getOwnPropertyDescriptor: trap('gopd') }); return i; }],
			['proxied array', (i) => { i.clients = new Proxy(i.clients, { get: trap('get'), ownKeys: trap('ownKeys'), getOwnPropertyDescriptor: trap('gopd') }); return i; }],
			['inherited field', (i) => { i.clients[0] = Object.create(i.clients[0]); return i; }],
			['symbol key', (i) => { i.clients[0][Symbol('x')] = 1; return i; }],
			['non-plain prototype', (i) => { i.clients[0].policy = Object.assign(Object.create({ inherited: 1 }), i.clients[0].policy); return i; }],
			['sparse clients', (i) => { delete i.clients[1]; return i; }],
			['array subclass', (i) => { class Sub extends Array {} i.clients = Sub.from(i.clients); return i; }],
		];
		for (const [name, make] of poisoned) {
			const input = runtime('a');
			const result = make(input) ?? input;
			const f = fixture();
			const settings = { ...f.settings, runtimeConfig: result };
			expect(() => prepareWorkersDevBootstrap({ artifact: f.artifact, out: f.out, settings }), name).toThrow();
			expect(existsSync(f.out), `${name}: no stage after refusal`).toBe(false);
			expect(calls, name).toEqual([]);
		}
	});
	it('refuses a configuration whose own property is hidden, accessor or non-enumerable', () => {
		const hidden = runtime('a');
		Object.defineProperty(hidden.clients[0], 'appOrigin', { value: hidden.clients[0].appOrigin, enumerable: false });
		expect(() => planWorkersDevBootstrap({ ...shellSettings(), browserClients: ['client-a'], runtimeConfig: hidden })).toThrow(REFUSED);
	});
	it('a getter or Proxy as the settings runtimeConfig field itself is refused before the planner runs', () => {
		let reads = 0;
		const settings = { ...shellSettings(), browserClients: ['client-a'] as const };
		Object.defineProperty(settings, 'runtimeConfig', { get: () => { reads++; return runtime('a'); }, enumerable: true });
		expect(() => planWorkersDevBootstrap(settings)).toThrow(/exactly/);
		expect(reads).toBe(0);
	});
	it('cannot be changed between prepare and read: a different configuration is a different exact profile', () => {
		const f = fixture(); f.prepare();
		const mutated = structuredClone(f.settings) as any;
		mutated.runtimeConfig.clients[0].policy.nativeRenderBudget.maxRunMs = 9_000;
		mutated.runtimeConfig.browserAllocation.maxReservedBrowserMsPerDay = 2_000_000;
		expect(() => f.read(mutated)).toThrow(/differ from the exact bootstrap profile/);
		expect(() => f.invoke('client-a', mutated)).toThrow(/differ from the exact bootstrap profile/);
		expect(() => f.read()).not.toThrow();
	});
	it('mutating the caller object after a plan or prepare cannot change the stage or its recheck', () => {
		const f = fixture(), pristine = structuredClone(f.settings), prepared = f.prepare();
		const before = JSON.stringify(prepared.manifest);
		(f.settings.runtimeConfig as any).clients[0].policy.nativeRenderBudget.maxRunMs = 1;
		(f.settings as any).browserClients.length = 0;
		expect(JSON.stringify(prepared.manifest)).toBe(before);
		expect(readFileSync(path.join(f.out, 'client-a.wrangler.json'), 'utf8')).toBe(prepared.manifest.targets[0]!.configText);
		expect(f.read(pristine).stage).toBe(prepared.stage);
		expect(() => f.read()).toThrow();
	});
});

describe('a genuine configured stage: one value set seen by every record, checker, reread and invocation', () => {
	it('prepares, rereads and authorizes every slot with identical config bytes', () => {
		const f = fixture(), checked = f.prepare();
		expect(readdirSync(f.out).sort()).toEqual(['artifact', 'bootstrap.json', 'client-a.wrangler.json', 'client-b.wrangler.json', 'staff.wrangler.json']);
		const vars = plannerVars(f.settings.runtimeConfig);
		const manifestOnDisk = JSON.parse(readFileSync(path.join(f.out, 'bootstrap.json'), 'utf8'));
		for (const [i, slot] of (['client-a', 'client-b', 'staff'] as const).entries()) {
			const record = checked.manifest.targets[i]!, onDisk = cfg(readFileSync(path.join(f.out, `${slot}.wrangler.json`), 'utf8'));
			expect(readFileSync(path.join(f.out, `${slot}.wrangler.json`), 'utf8')).toBe(record.configText);
			expect(manifestOnDisk.targets[i].configText).toBe(record.configText);
			expect(onDisk.vars).toEqual(cfg(record.configText).vars);
			if (slot !== 'staff') expect(onDisk.vars).toEqual({ CLEARCASE_INSTANCE_ROLE: 'client', ...vars.get(slot) });
			expect(f.invoke(slot)).toEqual(checked);
		}
		expect(f.read()).toEqual(checked);
		expect(manifestOnDisk).toMatchObject({ deployed: false, providerProof: false });
		expect(manifestOnDisk.runtimeConfig.manifestSha256).toBe(checked.manifest.runtimeConfig!.manifestSha256);
		expect(onlyPublic(JSON.stringify(manifestOnDisk))).toBe(true);
		expect(checked.manifest.targets.map((t) => 'browser' in cfg(t.configText))).toEqual([true, false, false]);
	});
	it('the shell stage and the configured stage are not interchangeable', () => {
		const shell = fixture();
		const { runtimeConfig: _runtime, ...plain } = shell.settings;
		prepareWorkersDevBootstrap({ artifact: shell.artifact, out: shell.out, settings: plain });
		expect(() => shell.read(shell.settings)).toThrow(/differ from the exact bootstrap profile/);
		expect(() => shell.read({ ...plain, runtimeConfig: runtime('a') })).toThrow(/differ from the exact bootstrap profile/);
		const configuredStage = fixture(); configuredStage.prepare();
		const { runtimeConfig: _r, ...without } = configuredStage.settings;
		expect(() => configuredStage.read(without)).toThrow(/differ from the exact bootstrap profile/);
	});
	it('a two-renderer plan prepares a stage with two BROWSER bindings and refuses the single-renderer settings', () => {
		const f = fixture('both'), checked = f.prepare();
		expect(checked.manifest.targets.map((t) => cfg(t.configText).browser)).toEqual([{ binding: 'BROWSER' }, { binding: 'BROWSER' }, undefined]);
		expect(() => f.read({ ...f.settings, browserClients: ['client-a'] })).toThrow(/browserClients|exactly|runtimeConfig/);
	});
	it('a no-renderer configuration prepares a stage with no BROWSER binding at all', () => {
		const f = fixture('none'), checked = f.prepare();
		for (const t of checked.manifest.targets) expect(cfg(t.configText)).not.toHaveProperty('browser');
	});
});
const onlyPublic = (text: string) => !/sk_(?:test|live)_|-----BEGIN|eyJ[A-Za-z0-9_-]{6,}\./.test(text);

describe('a tampered stage is refused, even with a rewritten manifest', () => {
	const tamper = (slot: 'client-a' | 'client-b' | 'staff', edit: (config: Record<string, any>) => void) => {
		const f = fixture(), checked = f.prepare();
		const target = checked.manifest.targets.find((t) => t.slot === slot)!, config = cfg(target.configText);
		edit(config);
		const text = `${JSON.stringify(config, null, 2)}\n`;
		writeFileSync(path.join(f.out, target.configFile), text);
		const manifest = JSON.parse(checked.manifestText);
		const changed = manifest.targets.find((t: { slot: string }) => t.slot === slot);
		changed.configText = text; changed.configSha256 = sha(text);
		writeFileSync(path.join(f.out, 'bootstrap.json'), `${JSON.stringify(manifest, null, 2)}\n`);
		return f;
	};
	it.each([
		['client-a', 'a changed nativeConfig', (c: any) => { c.vars.CLEARCASE_NATIVE_CONFIG = c.vars.CLEARCASE_NATIVE_CONFIG.replace('"maxDocuments":1000', '"maxDocuments":2000'); }],
		['client-a', 'a changed app origin', (c: any) => { c.vars.CLEARCASE_APP_ORIGIN = 'https://elsewhere.example.test'; }],
		['client-b', 'a changed publishable key', (c: any) => { c.vars.CLERK_CLIENT_PUBLISHABLE_KEY = c.vars.CLERK_STAFF_PUBLISHABLE_KEY; }],
		['client-a', 'a removed var', (c: any) => { delete c.vars.AUTH_MFA_REQUIRED; }],
		['client-a', 'the client id of the other client', (c: any) => { c.vars.CLEARCASE_CLIENT_ID = 'client-b'; }],
		['client-b', 'the role flipped to staff', (c: any) => { c.vars.CLEARCASE_INSTANCE_ROLE = 'staff'; }],
		['client-a', 'an injected secret binding name as a var', (c: any) => { c.vars.CLERK_CLIENT_SECRET_KEY = 'synthetic'; }],
		['client-a', 'an injected unknown var', (c: any) => { c.vars.EXTRA = 'x'; }],
		['client-a', 'a re-ordered var set', (c: any) => { c.vars = Object.fromEntries(Object.entries(c.vars).reverse()); }],
		['client-a', 'a dropped BROWSER binding', (c: any) => { delete c.browser; }],
		['client-b', 'an injected BROWSER binding', (c: any) => { c.browser = { binding: 'BROWSER' }; }],
		['client-a', 'an added secrets block', (c: any) => { c.secrets = { required: ['CLERK_CLIENT_SECRET_KEY'] }; }],
		['staff', 'client vars on the staff shell', (c: any) => { c.vars = { CLEARCASE_INSTANCE_ROLE: 'client', CLEARCASE_CLIENT_ID: 'client-a' }; }],
		['staff', 'planner vars copied to staff', (c: any) => { Object.assign(c.vars, { CLEARCASE_APP_ORIGIN: 'https://x.example.test' }); }],
		['staff', 'a client database on staff', (c: any) => { c.d1_databases = [{ binding: 'DB', database_name: 'cc-sbx-a-20261023-db', database_id: 'cd257736-7bf3-49f6-8544-ac58c2207802' }]; }],
	] as const)('refuses %s on %s', (slot, _, edit) => {
		const f = tamper(slot, edit);
		expect(() => f.read()).toThrow(/exact bootstrap profile/);
		expect(() => f.invoke(slot)).toThrow(/exact bootstrap profile/);
	});
	it('refuses a stage whose manifest drops or rewrites the runtime record', () => {
		const f = fixture(), checked = f.prepare();
		const manifest = JSON.parse(checked.manifestText);
		manifest.runtimeConfig.manifestSha256 = sha('other');
		writeFileSync(path.join(f.out, 'bootstrap.json'), `${JSON.stringify(manifest, null, 2)}\n`);
		expect(() => f.read()).toThrow(/bootstrap\.json/);
		delete manifest.runtimeConfig;
		writeFileSync(path.join(f.out, 'bootstrap.json'), `${JSON.stringify(manifest, null, 2)}\n`);
		expect(() => f.read()).toThrow(/bootstrap\.json/);
	});
});

describe('defense in depth: the merge refuses anything a changed planner might emit beyond its public values', () => {
	async function through(edit: (file: any) => any) {
		vi.resetModules();
		vi.doMock('../../../../deploy/native-alpha/runtime-config.ts', async (importOriginal) => {
			const real = await importOriginal<typeof import('../../../../deploy/native-alpha/runtime-config.ts')>();
			return { ...real, planNativeRuntimeConfig: (value: unknown) => { const plan = real.planNativeRuntimeConfig(value); return { ...plan, clients: plan.clients.map((c) => edit(structuredClone(c))) }; } };
		});
		return (await import('../../../../deploy/native-alpha/workers-dev-bootstrap.ts')).planWorkersDevBootstrap(configured('a'));
	}
	it('passes an unedited planner result through (the harness itself is neutral)', async () => {
		expect((await through((c) => c)).targets[0]!.runtime).toBeDefined();
	});
	it.each([
		['the reserved role var', (c: any) => { c.vars.CLEARCASE_INSTANCE_ROLE = 'staff'; return c; }],
		['a secret binding name', (c: any) => { c.vars.CLERK_CLIENT_SECRET_KEY = 'x'; return c; }],
		['a jwt key name', (c: any) => { c.vars.CLERK_STAFF_JWT_KEY = 'x'; return c; }],
		['an unknown var', (c: any) => { c.vars.EXTRA = 'x'; return c; }],
		['a client id that is not the slot', (c: any) => { c.vars.CLEARCASE_CLIENT_ID = 'client-b'; return c; }],
		['a non-string value', (c: any) => { c.vars.AUTH_MFA_REQUIRED = false; return c; }],
		['an oversized value', (c: any) => { c.vars.CLEARCASE_APP_ORIGIN = 'x'.repeat(5001); return c; }],
		['a changed secret name list', (c: any) => { c.secrets = [...c.secrets, 'EXTRA_SECRET']; return c; }],
		['a changed D1 binding', (c: any) => { c.bindings.d1 = 'OTHER'; return c; }],
		['an extra binding', (c: any) => { c.bindings.services = 'SVC'; return c; }],
		['a different browser binding name', (c: any) => { c.bindings.browser = 'RENDER'; return c; }],
		['a changed worker', (c: any) => { c.worker = 'cc-sbx-b-20261023'; return c; }],
		['a nativeConfig deployment for another database', (c: any) => { const n = JSON.parse(c.vars.CLEARCASE_NATIVE_CONFIG); n.deployment.d1DatabaseId = 'x'; c.vars.CLEARCASE_NATIVE_CONFIG = JSON.stringify(n); return c; }],
		['a nativeConfig that is not JSON', (c: any) => { c.vars.CLEARCASE_NATIVE_CONFIG = '{'; return c; }],
	])('refuses %s', async (_, edit) => {
		await expect(through(edit)).rejects.toThrow(REFUSED);
	});
});
