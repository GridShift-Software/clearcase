import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NATIVE_BROWSER_BINDING, checkNativeWrangler, parseNativeTarget, type NativeTarget } from '../../../../deploy/native-alpha/pipeline.ts';
import { HOSTED_GATE_MARKER, NATIVE_ADAPTER_HEADERS } from '../../../../deploy/native-alpha/pipeline.ts';
import { checkNativeStage, checkNativeUploadInvocation, digestDir, loadNativeTargets, stageNative } from '../../../../deploy/probes/target.ts';
import {
	checkWorkersDevBootstrapInvocation, planWorkersDevBootstrap, prepareWorkersDevBootstrap, readWorkersDevBootstrap,
	type BootstrapSettings,
} from '../../../../deploy/native-alpha/workers-dev-bootstrap.ts';

// Everything here is a synthetic file check. BROWSER is a controlled deployment capability: a PASS is not evidence that
// Browser Run exists, is isolated, bounded, billed or renders anything, and no account, quota or budget is configured.
const FIXTURES = path.join(import.meta.dirname, '../native-alpha-pipeline/fixtures');
const CLIENTS = path.join(FIXTURES, 'clients');
const ARTIFACT = path.join(FIXTURES, 'artifact');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'cc-browser-binding-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const fresh = (name: string) => path.join(scratch, `${name}-${++n}`);
const sha256 = (bytes: string | Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const strip = (text: string) => text.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
const BROWSER = { binding: 'BROWSER' };
const refused = (problems: readonly string[], reason: RegExp | string) =>
	expect(problems.some((p) => (typeof reason === 'string' ? p.includes(reason) : reason.test(p))), problems.join('\n') || '(no problems)').toBe(true);

describe('native/1: explicit client opt-in, checked against the reviewed target', () => {
	const targets = loadNativeTargets(CLIENTS);
	const targetOf = (client: string): Record<string, any> => JSON.parse(readFileSync(path.join(CLIENTS, client, 'target.json'), 'utf8'));
	const configOf = (client: string): Record<string, any> => JSON.parse(strip(readFileSync(path.join(CLIENTS, client, 'wrangler.jsonc'), 'utf8')));
	const withTargets = (client: string, edit: (t: Record<string, any>) => void) => targets.map((t) => (t.client === client ? parseNativeTarget((() => { const v = structuredClone(t) as Record<string, any>; edit(v); return v; })(), 'target.json') : t));
	const optedIn = (client: string) => withTargets(client, (t) => { t.browser = { ...BROWSER }; });
	const check = (client: string, ts: NativeTarget[], edit: (c: Record<string, any>) => void = () => {}) => {
		const c = configOf(client);
		edit(c);
		return checkNativeWrangler({ client, targets: ts, text: JSON.stringify(c, null, 2) });
	};

	it('is off by default: the existing fixtures carry no browser and a config binding one is refused', () => {
		for (const client of ['client-a', 'client-b']) {
			expect(targets.find((t) => t.client === client)).not.toHaveProperty('browser');
			expect(check(client, targets)).toEqual([]);
			refused(check(client, targets, (c) => { c.browser = { ...BROWSER }; }), /does not opt in to the browser binding/);
		}
	});
	it.each(['client-a', 'client-b'])('accepts exactly browser:{binding:BROWSER} for %s once the target opts in, and requires it', (client) => {
		const ts = optedIn(client);
		expect(ts.find((t) => t.client === client)!.browser).toEqual(BROWSER);
		expect(check(client, ts, (c) => { c.browser = { ...BROWSER }; })).toEqual([]);
		refused(check(client, ts), /config\.browser is missing/);
	});
	it.each([
		['wrong name', { binding: 'BROWSER2' }], ['lower case', { binding: 'browser' }], ['empty name', { binding: '' }], ['non-string name', { binding: 7 }],
		['remote flag', { binding: 'BROWSER', remote: true }], ['proxy field', { binding: 'BROWSER', service: 'other-worker' }], ['extra key', { binding: 'BROWSER', limit: 10 }],
		['no binding', {}], ['a string', 'BROWSER'], ['an array', [{ binding: 'BROWSER' }]], ['null', null], ['a boolean', true],
	])('refuses a %s browser binding even when the target opts in', (_, value) => {
		expect(check('client-a', optedIn('client-a'), (c) => { c.browser = value; }).length).toBeGreaterThan(0);
	});
	it.each([
		['services', [{ binding: 'BROWSER', service: 'renderer' }]], ['env', { production: { browser: { binding: 'BROWSER' } } }], ['ai', { binding: 'AI' }],
		['browser_rendering', { binding: 'BROWSER' }], ['durable_objects', { bindings: [{ name: 'BROWSER', class_name: 'B' }] }], ['kv_namespaces', [{ binding: 'BROWSER', id: 'x' }]],
		['dispatch_namespaces', [{ binding: 'BROWSER', namespace: 'x' }]], ['vectorize', [{ binding: 'BROWSER' }]], ['unsafe', { bindings: [{ type: 'browser', name: 'BROWSER' }] }],
	])('refuses an unknown %s binding or env override beside an opted-in browser', (key, value) => {
		refused(check('client-a', optedIn('client-a'), (c) => { c.browser = { ...BROWSER }; c[key] = value; }), `config.${key} is not a key the native profile reads`);
	});
	it('refuses BROWSER as another binding kind or as a D1, R2 or assets name', () => {
		const ts = optedIn('client-a');
		const on = (edit: (c: Record<string, any>) => void) => check('client-a', ts, (c) => { c.browser = { ...BROWSER }; edit(c); });
		refused(on((c) => { c.d1_databases[0].binding = 'BROWSER'; }), 'd1 binding');
		refused(on((c) => { c.r2_buckets[0].binding = 'BROWSER'; }), 'r2 binding');
		refused(on((c) => { c.assets.binding = 'BROWSER'; }), 'the assets binding');
		refused(on((c) => { c.vars.BROWSER = 'x'; }), /vars are/);
		refused(on((c) => { c.secrets.required = ['CLERK_SECRET_KEY', 'BROWSER']; }), /secret names are/);
	});
	it('leaves the other client untouched: one client opting in grants nothing to the other', () => {
		const ts = optedIn('client-a');
		refused(check('client-b', ts, (c) => { c.browser = { ...BROWSER }; }), /does not opt in to the browser binding/);
		expect(check('client-b', ts)).toEqual([]);
	});
	it('rejects an unreviewed target shape: wrong name, flag, extra key, a staff client and binding collisions', () => {
		const parse = (edit: (t: Record<string, any>) => void) => () => { const t = targetOf('client-a'); edit(t); parseNativeTarget(t, 'target.json'); };
		for (const bad of [{ binding: 'BROWSER2' }, { binding: 'BROWSER', remote: true }, {}, 'BROWSER', null, [BROWSER]]) expect(parse((t) => { t.browser = bad; })).toThrow(/browser/);
		expect(parse((t) => { t.browser = { ...BROWSER }; })).not.toThrow();
		expect(parse((t) => { t.browser = { ...BROWSER }; t.client = 'staff'; t.worker = 'cc-sbx-staff-20261023'; })).toThrow(/not an approved native client/);
		expect(parse((t) => { t.browser = { ...BROWSER }; t.runtime.assetsBinding = 'BROWSER'; })).toThrow(/assetsBinding/);
		expect(parse((t) => { t.browser = { ...BROWSER }; t.vars.BROWSER = 'x'; })).toThrow(/collides/);
		expect(parse((t) => { t.browser = { ...BROWSER }; t.secrets = ['BROWSER']; })).toThrow(/collides/);
		expect(parse((t) => { t.browserBinding = 'BROWSER'; })).toThrow(/browserBinding/);
	});

	describe('stage, prebuilt and invocation agree on the opt-in', () => {
		const pinsFor = (clients: string, t: NativeTarget) => ({
			target: sha256(readFileSync(path.join(clients, t.client, 'target.json'))), config: sha256(readFileSync(path.join(clients, t.client, 'wrangler.jsonc'))),
			artifact: digestDir(ARTIFACT), migrations: t.runtime.migrationsSha256, entry: sha256(readFileSync(path.join(ARTIFACT, 'cloudflare/_worker.js'))), source: t.runtime.sourceSha,
		});
		const reviewed = (optIn: boolean, configHasBrowser = optIn) => {
			const clients = fresh('clients');
			cpSync(CLIENTS, clients, { recursive: true });
			const target = path.join(clients, 'client-a/target.json'), config = path.join(clients, 'client-a/wrangler.jsonc');
			if (optIn) writeFileSync(target, JSON.stringify({ ...targetOf('client-a'), browser: { ...BROWSER } }, null, 2));
			if (configHasBrowser) writeFileSync(config, readFileSync(config, 'utf8').replace('  "r2_buckets"', '  "browser": { "binding": "BROWSER" },\n  "r2_buckets"'));
			const t = loadNativeTargets(clients).find((x) => x.client === 'client-a')!;
			return { clients, t, pins: pinsFor(clients, t), out: fresh('stage') };
		};
		const stage = (r: ReturnType<typeof reviewed>) => stageNative({ client: 'client-a', artifact: ARTIFACT, digest: digestDir(ARTIFACT), out: r.out, clients: r.clients });
		const invoke = (r: ReturnType<typeof reviewed>) => checkNativeUploadInvocation({ client: 'client-a', stage: r.out, cwd: r.out, argv: ['wrangler', 'deploy', '--config', 'wrangler.jsonc'] });
		const record = (r: ReturnType<typeof reviewed>) => JSON.parse(readFileSync(path.join(r.out, 'stage.json'), 'utf8'));
		const edit = (file: string, f: (text: string) => string) => writeFileSync(file, f(readFileSync(file, 'utf8')));

		it('stages an opted-in client A, records the exact binding and passes pinned prebuilt and the invocation guard', () => {
			const r = reviewed(true);
			expect(stage(r)).toEqual([]);
			expect(record(r).desired.browserBinding).toBe('BROWSER');
			expect(record(r).providerProof).toBe(false);
			expect(checkNativeStage({ client: 'client-a', stage: r.out, clients: r.clients, pins: r.pins })).toEqual([]);
			expect(invoke(r)).toEqual([]);
		});
		it('keeps a non-opted-in stage byte-for-byte free of browser metadata', () => {
			const r = reviewed(false);
			expect(stage(r)).toEqual([]);
			expect(record(r).desired).not.toHaveProperty('browserBinding');
			expect(invoke(r)).toEqual([]);
		});
		it('refuses to stage an opt-in whose config omits the binding, or a binding without opt-in', () => {
			refused(stage(reviewed(true, false)), /config\.browser is missing/);
			refused(stage(reviewed(false, true)), /does not opt in to the browser binding/);
		});
		it('prebuilt refuses a browser added, removed or renamed in the staged config after staging', () => {
			const r = reviewed(true);
			expect(stage(r)).toEqual([]);
			const config = path.join(r.out, 'wrangler.jsonc');
			const original = readFileSync(config, 'utf8');
			for (const text of [original.replace('"browser": { "binding": "BROWSER" },\n', ''), original.replace('"binding": "BROWSER"', '"binding": "BROWSER2"'), original.replace('"browser": { "binding": "BROWSER" }', '"browser": { "binding": "BROWSER", "remote": true }')]) {
				writeFileSync(config, text);
				expect(checkNativeStage({ client: 'client-a', stage: r.out, clients: r.clients, pins: r.pins }).length).toBeGreaterThan(0);
			}
		});
		it('the invocation guard refuses a stage record, target or config that disagrees about the binding', () => {
			const r = reviewed(true);
			expect(stage(r)).toEqual([]);
			const stageJson = path.join(r.out, 'stage.json'), config = path.join(r.out, 'wrangler.jsonc'), target = path.join(r.out, 'target.json');
			const [js, cfg, tgt] = [stageJson, config, target].map((f) => readFileSync(f, 'utf8'));
			edit(stageJson, (t) => t.replace('"browserBinding": "BROWSER"', '"browserBinding": "BROWSER2"'));
			refused(invoke(r), /desired browser binding/);
			writeFileSync(stageJson, js!);
			edit(config, (t) => t.replace('"browser": { "binding": "BROWSER" },\n', ''));
			refused(invoke(r), /wrangler\.jsonc browser is absent/);
			writeFileSync(config, cfg!);
			edit(target, (t) => t.replace(/,\s*"browser": \{[^}]*\}/, ''));
			refused(invoke(r), /desired browser binding/);
			writeFileSync(target, tgt!);
			expect(invoke(r)).toEqual([]);
			expect(checkNativeUploadInvocation({ client: 'client-a', stage: r.out, cwd: r.out, argv: ['wrangler', 'deploy', '--config', 'wrangler.jsonc', '--var', 'BROWSER:x'] }).length).toBeGreaterThan(0);
		});
	});
});

const SOURCE = 'a'.repeat(40);
const STAMP = { revision: SOURCE, dirty: false, exported: false, builtAt: '2026-10-25T06:40:03.000Z', bun: '1.4.2', buildId: 'synthetic-browser', target: 'cloudflare', profile: 'production' };
const worker = `const embedded = ${JSON.stringify(JSON.stringify(STAMP))};
const kit_manifest = (() => { return { app_dir: "_app", app_path: "_app", assets: new Set(["robots.txt"]), client: { start: "_app/immutable/start.js", app: "_app/immutable/app.js", imports: ["_app/immutable/chunk.js"], stylesheets: ["_app/immutable/site.css"], fonts: [] } }; })();
const server = create_server(kit_manifest);
export default { async fetch() { await server.respond(); return new Response(embedded); } };\n`;
const valid = (browserClients?: unknown): BootstrapSettings => ({
	pins: { source: SOURCE, artifact: `sha256:${'b'.repeat(64)}`, entry: `sha256:${'c'.repeat(64)}` }, compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'],
	...(browserClients === undefined ? {} : { browserClients: browserClients as BootstrapSettings['browserClients'] }),
});
const cfgOf = (text: string): Record<string, any> => JSON.parse(text);

describe('workers.dev bootstrap: explicit client-only opt-in', () => {
	it('is off by default: no browser in any config or target, and the plan is unchanged', () => {
		const plan = planWorkersDevBootstrap(valid());
		for (const t of plan.targets) {
			expect(cfgOf(t.configText)).not.toHaveProperty('browser');
			expect(t).not.toHaveProperty('browser');
		}
		expect(plan.settings).not.toHaveProperty('browserClients');
	});
	it('binds exactly BROWSER on the opted-in clients only; staff stays ASSETS-only; the exact tuple and Free-compatible settings survive', () => {
		const base = planWorkersDevBootstrap(valid()), plan = planWorkersDevBootstrap(valid(['client-a', 'client-b']));
		for (const [i, t] of plan.targets.entries()) {
			const config = cfgOf(t.configText), { browser, ...rest } = config;
			if (t.slot === 'staff') {
				expect(config).not.toHaveProperty('browser');
				expect(t).not.toHaveProperty('browser');
				expect(config).not.toHaveProperty('d1_databases');
				expect(config).not.toHaveProperty('r2_buckets');
				expect(config.assets).toEqual({ directory: 'artifact/public', binding: 'ASSETS' });
				expect(t.configText).toBe(base.targets[i]!.configText);
				continue;
			}
			expect(browser).toEqual(BROWSER);
			expect(t.browser).toEqual(BROWSER);
			expect(rest).toEqual(cfgOf(base.targets[i]!.configText));
			expect(Object.keys(config)).toEqual([...Object.keys(rest), 'browser']);
			expect(config.compatibility_flags).toEqual(['nodejs_compat']);
			expect(config).not.toHaveProperty('limits');
			expect(config.assets.binding).toBe('ASSETS');
			expect(config).not.toHaveProperty('secrets');
			expect(config).not.toHaveProperty('services');
			expect(config).not.toHaveProperty('env');
			expect(t.argv).toEqual(['wrangler', 'deploy', '--config', t.configFile]);
			expect(t.stores).toEqual(base.targets[i]!.stores);
		}
		expect(planWorkersDevBootstrap(valid(['client-b'])).targets.map((t) => 'browser' in cfgOf(t.configText))).toEqual([false, true, false]);
		expect(planWorkersDevBootstrap(valid(['client-a'])).targets.map((t) => 'browser' in cfgOf(t.configText))).toEqual([true, false, false]);
		expect(plan.settings.browserClients).toEqual(['client-a', 'client-b']);
	});
	it.each([
		['staff', ['staff']], ['client plus staff', ['client-a', 'staff']], ['an unknown slot', ['client-c']], ['a lower-case-twisted name', ['Client-A']], ['empty', []],
		['duplicates', ['client-a', 'client-a']], ['out of order', ['client-b', 'client-a']], ['a string', 'client-a'], ['null', null], ['an object', { 'client-a': true }],
		['a binding name', [{ binding: 'BROWSER' }]], ['a non-string', [1]],
	])('refuses browserClients as %s', (_, value) => {
		expect(() => planWorkersDevBootstrap(valid(value))).toThrow(/browserClients/);
	});
	it.each([
		['browser', { binding: 'BROWSER' }], ['browserBinding', 'BROWSER'], ['browserName', 'BROWSER2'], ['bindings', { BROWSER: true }], ['env', { production: {} }], ['services', []],
		['remote', true], ['budget', { maxSessions: 1 }], ['quota', 5], ['limits', { cpu_ms: 50 }],
	])('refuses caller-supplied %s outside the single browserClients opt-in', (key, value) => {
		expect(() => planWorkersDevBootstrap({ ...valid(['client-a']), [key]: value })).toThrow(/exactly/);
		expect(() => planWorkersDevBootstrap({ ...valid(), [key]: value })).toThrow(/exactly/);
	});

	describe('prepared stage', () => {
		const roots: string[] = [];
		afterAll(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
		function fixture(browserClients?: unknown) {
			const root = mkdtempSync(path.join(os.tmpdir(), 'cc-browser-bootstrap-'));
			roots.push(root);
			const artifact = path.join(root, 'source-artifact'), out = path.join(root, 'stage');
			const put = (rel: string, bytes: string) => { mkdirSync(path.dirname(path.join(artifact, rel)), { recursive: true }); writeFileSync(path.join(artifact, rel), bytes); };
			put('cloudflare/_worker.js', worker);
			put('public/_app/version.json', JSON.stringify({ version: SOURCE }));
			put('public/robots.txt', 'User-agent: *\nDisallow:\n');
			put('public/_app/immutable/start.js', 'export function start() {}\n');
			put('public/_app/immutable/app.js', 'import "./chunk.js";\n');
			put('public/_app/immutable/chunk.js', 'export const loaded = true;\n');
			put('public/_app/immutable/site.css', 'body { color: black; }\n');
			put('public/_headers', NATIVE_ADAPTER_HEADERS);
			const settings: BootstrapSettings = { ...valid(browserClients), pins: { source: SOURCE, artifact: digestDir(artifact), entry: sha256(readFileSync(path.join(artifact, 'cloudflare/_worker.js'))) } };
			return { root, artifact, out, settings, prepare: () => prepareWorkersDevBootstrap({ artifact, out, settings }) };
		}
		const invoke = (f: ReturnType<typeof fixture>, slot: 'client-a' | 'client-b' | 'staff', settings = f.settings) =>
			checkWorkersDevBootstrapInvocation({ stage: f.out, settings, cwd: f.out, slot, argv: ['wrangler', 'deploy', '--config', `${slot}.wrangler.json`] });

		it('prepares, re-reads and gates every invocation for a client-A-only opt-in; the marker names no gate double', () => {
			const f = fixture(['client-a']), checked = f.prepare();
			expect(readFileSync(path.join(f.out, 'artifact/cloudflare/_worker.js'), 'utf8')).not.toContain(HOSTED_GATE_MARKER);
			expect(cfgOf(readFileSync(path.join(f.out, 'client-a.wrangler.json'), 'utf8')).browser).toEqual(BROWSER);
			for (const slot of ['client-b', 'staff']) expect(cfgOf(readFileSync(path.join(f.out, `${slot}.wrangler.json`), 'utf8'))).not.toHaveProperty('browser');
			expect(checked.manifest.settings.browserClients).toEqual(['client-a']);
			expect(checked.manifest.targets.find((t) => t.slot === 'client-a')).toMatchObject({ browser: BROWSER });
			for (const slot of ['client-a', 'client-b', 'staff'] as const) expect(invoke(f, slot)).toEqual(checked);
			expect(checked.manifest).toMatchObject({ deployed: false, providerProof: false });
		});
		it('the parent opt-in is part of the externally supplied settings: an omitted, widened or changed opt-in is refused on read and invocation', () => {
			const f = fixture(['client-a']);
			f.prepare();
			for (const settings of [valid(), valid(['client-a', 'client-b']), valid(['client-b'])]) {
				const s = { ...settings, pins: f.settings.pins };
				expect(() => readWorkersDevBootstrap({ stage: f.out, settings: s })).toThrow(/differ from the exact bootstrap profile/);
				expect(() => invoke(f, 'client-a', s)).toThrow(/differ from the exact bootstrap profile/);
			}
			const noOptIn = fixture(), staged = noOptIn.prepare();
			expect(staged.manifest.targets.every((t) => !('browser' in t))).toBe(true);
			expect(() => readWorkersDevBootstrap({ stage: noOptIn.out, settings: { ...noOptIn.settings, browserClients: ['client-a'] } })).toThrow(/differ from the exact bootstrap profile/);
		});
		it.each([
			['staff gains BROWSER', 'staff', (c: Record<string, any>) => { c.browser = { binding: 'BROWSER' }; }],
			['staff gains D1', 'staff', (c: Record<string, any>) => { c.d1_databases = [{ binding: 'DB', database_name: 'cc-sbx-a-20261023-db', database_id: 'cd257736-7bf3-49f6-8544-ac58c2207802' }]; }],
			['the opted-in client renames the binding', 'client-a', (c: Record<string, any>) => { c.browser = { binding: 'BROWSER2' }; }],
			['the opted-in client adds a remote flag', 'client-a', (c: Record<string, any>) => { c.browser = { binding: 'BROWSER', remote: true }; }],
			['the opted-in client drops the binding', 'client-a', (c: Record<string, any>) => { delete c.browser; }],
			['the opted-in client moves it under env', 'client-a', (c: Record<string, any>) => { c.env = { production: { browser: c.browser } }; delete c.browser; }],
			['the opted-in client adds a service binding', 'client-a', (c: Record<string, any>) => { c.services = [{ binding: 'BROWSER', service: 'renderer' }]; }],
			['the opted-in client adds a proxy binding', 'client-a', (c: Record<string, any>) => { c.unsafe = { bindings: [{ type: 'browser', name: 'BROWSER' }] }; }],
			['the opted-in client adds a custom CPU limit', 'client-a', (c: Record<string, any>) => { c.limits = { cpu_ms: 50 }; }],
			['a non-opted client gains BROWSER', 'client-b', (c: Record<string, any>) => { c.browser = { binding: 'BROWSER' }; }],
			['a non-opted client gains a second browser', 'client-b', (c: Record<string, any>) => { c.browser = [{ binding: 'BROWSER' }]; }],
		])('refuses when %s in the staged bytes, even with a rewritten manifest', (_, slot, mutate) => {
			const f = fixture(['client-a']), checked = f.prepare();
			const target = checked.manifest.targets.find((t) => t.slot === slot)!;
			const config = cfgOf(target.configText);
			mutate(config);
			const text = `${JSON.stringify(config, null, 2)}\n`;
			writeFileSync(path.join(f.out, target.configFile), text);
			const manifest = JSON.parse(checked.manifestText);
			const changed = manifest.targets.find((t: { slot: string }) => t.slot === slot);
			changed.configText = text; changed.configSha256 = sha256(text);
			writeFileSync(path.join(f.out, 'bootstrap.json'), `${JSON.stringify(manifest, null, 2)}\n`);
			expect(() => readWorkersDevBootstrap({ stage: f.out, settings: f.settings })).toThrow(/differ from the exact bootstrap profile/);
			expect(() => invoke(f, slot as 'client-a')).toThrow(/differ from the exact bootstrap profile/);
		});
		it('refuses an invocation that tries to add or rename the binding through CLI flags', () => {
			const f = fixture(['client-a']);
			f.prepare();
			for (const extra of [['--var', 'BROWSER:x'], ['--env', 'production'], ['--name', 'cc-sbx-staff-20261023'], ['--browser', 'BROWSER']])
				expect(() => checkWorkersDevBootstrapInvocation({ stage: f.out, settings: f.settings, cwd: f.out, slot: 'client-a', argv: ['wrangler', 'deploy', '--config', 'client-a.wrangler.json', ...extra] })).toThrow(/argv/);
			expect(() => invoke(f, 'client-a', f.settings)).not.toThrow();
			expect(NATIVE_BROWSER_BINDING).toBe('BROWSER');
		});
	});
});
