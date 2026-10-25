import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { NATIVE_ADAPTER_HEADERS, NATIVE_BROWSER_BINDING, checkNativeWrangler, nativeStageRecord, parseNativeTarget, type NativeTarget } from '../../../../deploy/native-alpha/pipeline.ts';
import { checkNativeUploadInvocation, digestDir, loadNativeTargets, stageNative } from '../../../../deploy/probes/target.ts';
import {
	checkWorkersDevBootstrapInvocation, planWorkersDevBootstrap, prepareWorkersDevBootstrap, readWorkersDevBootstrap,
	type BootstrapSettings,
} from '../../../../deploy/native-alpha/workers-dev-bootstrap.ts';

// Input-boundary regressions for the explicit Browser Run opt-in. Synthetic data only: no provider, workerd or browser.
// The caller owns every object passed in. Each hostile shape below must be refused WITHOUT running the caller's code,
// and the bytes, config, labels and invocation must come from one captured snapshot, never a second live read.
const FIXTURES = path.join(import.meta.dirname, '../native-alpha-pipeline/fixtures');
const CLIENTS = path.join(FIXTURES, 'clients');
const ARTIFACT = path.join(FIXTURES, 'artifact');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'cc-browser-input-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const sha256 = (bytes: string | Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const strip = (text: string) => text.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');

/** A getter that counts how often it runs and answers from `answers` in turn: any read at all is a failure. */
function trap<T>(...answers: T[]) {
	const state = { reads: 0 };
	return { state, get: () => answers[Math.min(state.reads++, answers.length - 1)]! };
}
const withGetter = <T extends object>(base: T, key: string, getter: () => unknown): T => Object.defineProperty({ ...base }, key, { get: getter, enumerable: true, configurable: true });

describe('native/1 target: browser is captured as strict data at parse time', () => {
	const targets = loadNativeTargets(CLIENTS);
	const targetJson = (client = 'client-a'): Record<string, any> => JSON.parse(readFileSync(path.join(CLIENTS, client, 'target.json'), 'utf8'));
	const configOf = (client = 'client-a'): Record<string, any> => JSON.parse(strip(readFileSync(path.join(CLIENTS, client, 'wrangler.jsonc'), 'utf8')));
	const textOf = (c: Record<string, any>) => JSON.stringify(c, null, 2);

	it.each([
		['an inherited browser', () => Object.assign(Object.create({ browser: { binding: 'BROWSER2', remote: true } }), targetJson())],
		['an inherited BROWSER2 whose config passes the old checker', () => Object.assign(Object.create({ browser: { binding: 'BROWSER2' } }), targetJson())],
		['a browser accessor', () => withGetter(targetJson(), 'browser', () => ({ binding: 'BROWSER' }))],
		['a non-enumerable browser', () => Object.defineProperty(targetJson(), 'browser', { value: { binding: 'BROWSER' }, enumerable: false })],
		['a browser with a hidden non-enumerable key', () => ({ ...targetJson(), browser: Object.defineProperty({ binding: 'BROWSER' }, 'remote', { value: true, enumerable: false }) })],
		['a browser with an accessor binding', () => ({ ...targetJson(), browser: withGetter({}, 'binding', () => 'BROWSER') })],
		['a browser with an inherited binding', () => ({ ...targetJson(), browser: Object.create({ binding: 'BROWSER' }) })],
		['a browser with a symbol key', () => ({ ...targetJson(), browser: { binding: 'BROWSER', [Symbol('x')]: 1 } })],
		['a class-instance browser', () => ({ ...targetJson(), browser: new (class { binding = 'BROWSER'; })() })],
		['an accessor elsewhere in the target', () => withGetter(targetJson(), 'vars', () => ({ CLEARCASE_CLIENT_ID: 'client-a' }))],
		['a hidden extra field elsewhere in the target', () => Object.defineProperty(targetJson(), 'hidden', { value: 1, enumerable: false })],
		['a sparse secrets array', () => ({ ...targetJson(), secrets: Object.assign([], { length: 1 }) })],
	])('refuses %s, even when the target would otherwise opt in', (_, make) => {
		const t = make();
		expect(() => parseNativeTarget(t, 'target.json')).toThrow();
	});
	it('never runs a caller getter: a BROWSER-then-BROWSER2 accessor is refused unread', () => {
		const flip = trap({ binding: 'BROWSER' }, { binding: 'BROWSER2' });
		expect(() => parseNativeTarget(withGetter(targetJson(), 'browser', flip.get), 'target.json')).toThrow();
		expect(flip.state.reads).toBe(0);
		const vars = trap(targetJson().vars);
		expect(() => parseNativeTarget(withGetter(targetJson(), 'vars', vars.get), 'target.json')).toThrow();
		expect(vars.state.reads).toBe(0);
	});
	it('returns captured data: a later change to the caller object, or to the result, cannot change what was validated', () => {
		const input = { ...targetJson(), browser: { binding: 'BROWSER' } };
		const parsed = parseNativeTarget(input, 'target.json');
		expect(parsed).not.toBe(input);
		expect(parsed.browser).not.toBe(input.browser);
		input.browser.binding = 'BROWSER2';
		expect(parsed.browser).toEqual({ binding: 'BROWSER' });
		expect(checkNativeWrangler({ client: 'client-a', targets: [parsed, ...targets.filter((t) => t.client !== 'client-a')], text: textOf({ ...configOf(), browser: { binding: 'BROWSER' } }) })).toEqual([]);
	});
	it('reads a proxied browser only through its descriptors: no get trap runs and the result is a plain snapshot', () => {
		const gets = { n: 0 };
		const browser = new Proxy({ binding: 'BROWSER' }, { get: () => { gets.n++; return 'BROWSER2'; } });
		const parsed = parseNativeTarget({ ...targetJson(), browser }, 'target.json');
		expect(gets.n).toBe(0);
		expect(parsed.browser).toEqual({ binding: 'BROWSER' });
		expect(Object.getPrototypeOf(parsed.browser)).toBe(Object.prototype);
	});
	it('keeps accepting ordinary and null-prototype data, with the same fields and key order', () => {
		const plain = targetJson();
		const nullProto = Object.assign(Object.create(null), plain);
		expect(Object.keys(parseNativeTarget(nullProto, 'target.json'))).toEqual(Object.keys(plain));
		expect(parseNativeTarget(plain, 'target.json')).toEqual(plain);
		expect(parseNativeTarget({ ...plain, browser: { binding: 'BROWSER' } }, 'target.json').browser).toEqual({ binding: 'BROWSER' });
	});

	describe('configuration is compared with the fixed BROWSER literal, not a live field', () => {
		const others = targets.filter((t) => t.client !== 'client-a');
		const optedIn = (): NativeTarget => parseNativeTarget({ ...targetJson(), browser: { binding: 'BROWSER' } }, 'target.json');
		const check = (target: unknown, config: Record<string, any>) => checkNativeWrangler({ client: 'client-a', targets: [target as NativeTarget, ...others], text: textOf(config) });

		it('refuses a parsed target whose binding was changed afterwards, whatever the config says', () => {
			const t = optedIn();
			(t.browser as { binding: string }).binding = 'BROWSER2';
			expect(check(t, { ...configOf(), browser: { binding: 'BROWSER2' } }).length).toBeGreaterThan(0);
			expect(check(t, { ...configOf(), browser: { binding: 'BROWSER' } }).length).toBeGreaterThan(0);
		});
		it.each([
			['an inherited BROWSER2 with remote', () => Object.assign(Object.create({ browser: { binding: 'BROWSER2', remote: true } }), targets.find((t) => t.client === 'client-a')), { binding: 'BROWSER2', remote: true }],
			['an inherited BROWSER2', () => Object.assign(Object.create({ browser: { binding: 'BROWSER2' } }), targets.find((t) => t.client === 'client-a')), { binding: 'BROWSER2' }],
			['an inherited BROWSER', () => Object.assign(Object.create({ browser: { binding: 'BROWSER' } }), targets.find((t) => t.client === 'client-a')), { binding: 'BROWSER' }],
			['an own accessor that flips BROWSER to BROWSER2', () => withGetter(targets.find((t) => t.client === 'client-a')!, 'browser', trap({ binding: 'BROWSER' }, { binding: 'BROWSER2' }).get), { binding: 'BROWSER2' }],
			['an own accessor that stays BROWSER', () => withGetter(targets.find((t) => t.client === 'client-a')!, 'browser', () => ({ binding: 'BROWSER' })), { binding: 'BROWSER' }],
			['a hidden extra browser field', () => ({ ...targets.find((t) => t.client === 'client-a')!, browser: Object.defineProperty({ binding: 'BROWSER' }, 'remote', { value: true, enumerable: false }) }), { binding: 'BROWSER' }],
		])('refuses an unparsed target with %s instead of passing the config', (_, make, configBrowser) => {
			expect(check(make(), { ...configOf(), browser: configBrowser }).length).toBeGreaterThan(0);
		});
		it('does not run a target accessor while checking', () => {
			const reads = trap({ binding: 'BROWSER' });
			check(withGetter(targets.find((t) => t.client === 'client-a')!, 'browser', reads.get), { ...configOf(), browser: { binding: 'BROWSER' } });
			expect(reads.state.reads).toBe(0);
		});
		it('records the fixed literal only for an exact opt-in and refuses to record anything else', () => {
			const facts = { files: {}, artifact: 'sha256:a', migrations: 'sha256:b', upload: {} as never };
			expect(nativeStageRecord(optedIn(), facts).desired).toMatchObject({ browserBinding: NATIVE_BROWSER_BINDING });
			expect(nativeStageRecord(targets.find((t) => t.client === 'client-a')!, facts).desired).not.toHaveProperty('browserBinding');
			const mutated = optedIn();
			(mutated.browser as { binding: string }).binding = 'BROWSER2';
			expect(() => nativeStageRecord(mutated, facts)).toThrow();
			const reads = trap({ binding: 'BROWSER' });
			expect(() => nativeStageRecord(withGetter(targets.find((t) => t.client === 'client-a')!, 'browser', reads.get), facts)).toThrow();
			expect(reads.state.reads).toBe(0);
			expect(() => nativeStageRecord(Object.assign(Object.create({ browser: { binding: 'BROWSER' } }), targets.find((t) => t.client === 'client-a')), facts)).toThrow();
		});
	});

	describe('the staged invocation guard reads the same snapshot of the target', () => {
		it('still stages and passes an exact opt-in, and refuses a staged target that names another binding', () => {
			const clients = path.join(scratch, 'clients');
			cpSync(CLIENTS, clients, { recursive: true });
			writeFileSync(path.join(clients, 'client-a/target.json'), JSON.stringify({ ...targetJson(), browser: { binding: 'BROWSER' } }, null, 2));
			const config = path.join(clients, 'client-a/wrangler.jsonc');
			writeFileSync(config, readFileSync(config, 'utf8').replace('  "r2_buckets"', '  "browser": { "binding": "BROWSER" },\n  "r2_buckets"'));
			const out = path.join(scratch, 'stage-a');
			expect(stageNative({ client: 'client-a', artifact: ARTIFACT, digest: digestDir(ARTIFACT), out, clients })).toEqual([]);
			const invoke = () => checkNativeUploadInvocation({ client: 'client-a', stage: out, cwd: out, argv: ['wrangler', 'deploy', '--config', 'wrangler.jsonc'] });
			expect(invoke()).toEqual([]);
			writeFileSync(path.join(out, 'target.json'), readFileSync(path.join(out, 'target.json'), 'utf8').replace('"binding": "BROWSER"', '"binding": "BROWSER2"'));
			expect(invoke().length).toBeGreaterThan(0);
		});
	});
});

const SOURCE = 'a'.repeat(40);
const STAMP = { revision: SOURCE, dirty: false, exported: false, builtAt: '2026-10-25T06:40:03.000Z', bun: '1.4.2', buildId: 'synthetic-browser', target: 'cloudflare', profile: 'production' };
const worker = `const embedded = ${JSON.stringify(JSON.stringify(STAMP))};
const kit_manifest = (() => { return { app_dir: "_app", app_path: "_app", assets: new Set(["robots.txt"]), client: { start: "_app/immutable/start.js", app: "_app/immutable/app.js", imports: ["_app/immutable/chunk.js"], stylesheets: ["_app/immutable/site.css"], fonts: [] } }; })();
const server = create_server(kit_manifest);
export default { async fetch() { await server.respond(); return new Response(embedded); } };\n`;
const PINS = { source: SOURCE, artifact: `sha256:${'b'.repeat(64)}`, entry: `sha256:${'c'.repeat(64)}` };
const valid = (browserClients?: unknown): BootstrapSettings => ({
	pins: { ...PINS }, compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'],
	...(browserClients === undefined ? {} : { browserClients: browserClients as BootstrapSettings['browserClients'] }),
});

describe('workers.dev bootstrap: caller settings are captured once as strict data', () => {
	const hostile: [string, () => unknown, () => { reads: number } | undefined][] = [];
	const addHostile = (name: string, make: (spy: { reads: number }) => unknown) => {
		const spy = { reads: 0 };
		hostile.push([name, () => make(spy), () => spy]);
	};
	const counting = (spy: { reads: number }, ...answers: unknown[]) => () => answers[Math.min(spy.reads++, answers.length - 1)];
	addHostile('a browserClients getter answering client-a then client-b', (spy) => withGetter(valid(), 'browserClients', counting(spy, ['client-a'], ['client-b'])));
	addHostile('a browserClients getter that stays valid', (spy) => withGetter(valid(), 'browserClients', counting(spy, ['client-a'])));
	addHostile('an inherited browserClients', () => Object.assign(Object.create({ browserClients: ['client-b'] }), valid()));
	addHostile('an inherited optional field beside an own one', () => Object.assign(Object.create({ browserClients: ['client-a'] }), valid(['client-a'])));
	addHostile('a non-enumerable browserClients', () => Object.defineProperty(valid(), 'browserClients', { value: ['client-a'], enumerable: false }));
	addHostile('a hidden extra settings field', () => Object.defineProperty(valid(['client-a']), 'hidden', { value: true, enumerable: false }));
	addHostile('a symbol-keyed settings field', () => ({ ...valid(['client-a']), [Symbol('x')]: 1 }));
	addHostile('a pins accessor', (spy) => withGetter(valid(['client-a']), 'pins', counting(spy, PINS)));
	addHostile('a pins member accessor', (spy) => ({ ...valid(['client-a']), pins: withGetter(PINS, 'source', counting(spy, SOURCE)) }));
	addHostile('a compatibilityFlags accessor', (spy) => withGetter(valid(['client-a']), 'compatibilityFlags', counting(spy, ['nodejs_compat'])));
	addHostile('a compatibilityDate accessor', (spy) => withGetter(valid(['client-a']), 'compatibilityDate', counting(spy, '2026-10-23')));
	addHostile('a proxied settings object', () => new Proxy(valid(['client-a']), {}));
	addHostile('a proxied browserClients array', () => valid(new Proxy(['client-a'], {})));
	addHostile('an array whose index is an accessor', (spy) => valid(Object.defineProperty(['x'], '0', { get: counting(spy, 'client-a'), enumerable: true })));
	addHostile('an array with an inherited index', () => valid(Object.setPrototypeOf(Object.assign([], { length: 1 }), Object.assign(Object.create(Array.prototype), { 0: 'client-a' }))));
	addHostile('a sparse array', () => valid(Object.assign([], { 1: 'client-b', length: 2 })));
	addHostile('an array subclass', () => valid(new (class Clients extends Array<string> {})('client-a')));
	addHostile('an array overriding includes', () => valid(Object.defineProperty(['staff'], 'includes', { value: () => true, enumerable: false })));
	addHostile('an array overriding some', () => valid(Object.defineProperty(['staff'], 'some', { value: () => false, enumerable: false })));
	addHostile('an array overriding toJSON', () => valid(Object.defineProperty(['staff'], 'toJSON', { value: () => ['client-a'], enumerable: false })));
	addHostile('an array with a hidden extra property', () => valid(Object.defineProperty(['client-a'], 'extra', { value: 1, enumerable: false })));
	addHostile('an array with a symbol key', () => valid(Object.assign(['client-a'], { [Symbol('x')]: 1 })));
	addHostile('a flags array with a toJSON override', () => ({ ...valid(['client-a']), compatibilityFlags: Object.defineProperty(['other'], 'toJSON', { value: () => ['nodejs_compat'], enumerable: false }) }));

	it.each(hostile.map(([name, make, spy]) => [name, make, spy] as const))('plan refuses %s without running it', (_, make, spy) => {
		expect(() => planWorkersDevBootstrap(make())).toThrow();
		expect(spy()?.reads ?? 0).toBe(0);
	});
	it('names browserClients when that is the bad field', () => {
		for (const bad of [Object.assign([], { 1: 'client-b', length: 2 }), Object.defineProperty(['staff'], 'includes', { value: () => true, enumerable: false })])
			expect(() => planWorkersDevBootstrap(valid(bad))).toThrow(/browserClients/);
	});
	it('uses one snapshot: the plan holds copies, so later edits to the caller arrays change nothing', () => {
		const s = valid(['client-a']);
		const plan = planWorkersDevBootstrap(s);
		(s.browserClients as string[])[0] = 'client-b';
		s.pins.source = 'f'.repeat(40);
		(s.compatibilityFlags as string[])[0] = 'x';
		expect(plan.settings.browserClients).toEqual(['client-a']);
		expect(plan.settings.pins.source).toBe(SOURCE);
		expect(plan.settings.compatibilityFlags).toEqual(['nodejs_compat']);
		expect(plan.targets.map((t) => 'browser' in JSON.parse(t.configText))).toEqual([true, false, false]);
	});
	it('still accepts frozen and null-prototype ordinary settings with identical output', () => {
		const base = planWorkersDevBootstrap(valid(['client-a', 'client-b']));
		const frozen = Object.freeze({ ...valid(['client-a', 'client-b']), pins: Object.freeze({ ...PINS }), compatibilityFlags: Object.freeze(['nodejs_compat']) as unknown as ['nodejs_compat'], browserClients: Object.freeze(['client-a', 'client-b']) as unknown as BootstrapSettings['browserClients'] });
		expect(planWorkersDevBootstrap(frozen).targets.map((t) => t.configText)).toEqual(base.targets.map((t) => t.configText));
		const nullProto = Object.assign(Object.create(null), valid(['client-b']));
		expect(planWorkersDevBootstrap(nullProto).targets.map((t) => 'browser' in JSON.parse(t.configText))).toEqual([false, true, false]);
	});

	describe('prepare, read and invocation take one snapshot of every argument', () => {
		const roots: string[] = [];
		afterAll(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
		function fixture(browserClients?: unknown) {
			const root = mkdtempSync(path.join(os.tmpdir(), 'cc-browser-input-stage-'));
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
			return { root, artifact, out, settings };
		}

		it('prepare refuses a settings accessor on its argument object without reading it, and creates nothing', () => {
			const f = fixture(['client-a']);
			const reads = trap(f.settings, planWorkersDevBootstrap(valid(['client-b'])).settings);
			expect(() => prepareWorkersDevBootstrap(withGetter({ artifact: f.artifact, out: f.out, settings: null }, 'settings', reads.get) as never)).toThrow();
			expect(reads.state.reads).toBe(0);
			expect(() => readFileSync(f.out)).toThrow();
		});
		it('prepare refuses hostile settings in every shape before writing any file', () => {
			for (const [, make] of hostile) {
				const f = fixture(['client-a']);
				expect(() => prepareWorkersDevBootstrap({ artifact: f.artifact, out: f.out, settings: make() as never })).toThrow();
				expect(() => readFileSync(f.out)).toThrow();
			}
		});
		it('read and invocation refuse hostile settings in every shape', () => {
			const f = fixture(['client-a']);
			prepareWorkersDevBootstrap({ artifact: f.artifact, out: f.out, settings: f.settings });
			for (const [, make] of hostile) {
				expect(() => readWorkersDevBootstrap({ stage: f.out, settings: make() as never })).toThrow();
				expect(() => checkWorkersDevBootstrapInvocation({ stage: f.out, settings: make() as never, cwd: f.out, slot: 'client-a', argv: ['wrangler', 'deploy', '--config', 'client-a.wrangler.json'] })).toThrow();
			}
		});
		it('does not read accessor arguments of read or invocation, and the invocation argv array is captured data', () => {
			const f = fixture(['client-a']);
			prepareWorkersDevBootstrap({ artifact: f.artifact, out: f.out, settings: f.settings });
			const argv = ['wrangler', 'deploy', '--config', 'client-a.wrangler.json'];
			const args = { stage: f.out, settings: f.settings, cwd: f.out, slot: 'client-a' as const, argv };
			expect(() => checkWorkersDevBootstrapInvocation(args)).not.toThrow();
			for (const key of ['stage', 'settings', 'cwd', 'slot', 'argv'] as const) {
				const reads = trap(args[key]);
				expect(() => checkWorkersDevBootstrapInvocation(withGetter(args, key, reads.get))).toThrow();
				expect(reads.state.reads).toBe(0);
			}
			const readReads = trap(f.settings);
			expect(() => readWorkersDevBootstrap(withGetter({ stage: f.out, settings: null }, 'settings', readReads.get) as never)).toThrow();
			expect(readReads.state.reads).toBe(0);
			for (const bad of [Object.defineProperty([...argv], 'toJSON', { value: () => argv, enumerable: false }), new Proxy([...argv], {}), Object.assign([...argv, ], { 4: 'x' })])
				expect(() => checkWorkersDevBootstrapInvocation({ ...args, argv: bad })).toThrow(/argv/);
		});
	});
});
