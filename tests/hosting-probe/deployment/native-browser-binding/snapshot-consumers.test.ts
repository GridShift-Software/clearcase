import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { NATIVE_ADAPTER_HEADERS, checkNativeWrangler, nativeStageRecord, nativeUploadInvocationProblems, parseNativeTarget, type NativeTarget } from '../../../../deploy/native-alpha/pipeline.ts';
import { checkNative, checkNativeStage, checkNativeUploadInvocation, digestDir, loadNativeTargets, readNativeStage, stageNative } from '../../../../deploy/probes/target.ts';
import { checkWorkersDevBootstrapInvocation, prepareWorkersDevBootstrap, type BootstrapSettings } from '../../../../deploy/native-alpha/workers-dev-bootstrap.ts';

// Consumers of caller-owned data after its capture. Each entry point takes ONE snapshot of everything it will use
// (the whole target, its other arguments, every argv element as a primitive string) before it reads any file or
// derives any fact, and never consults the caller's objects again: a descriptor trap that runs while the snapshot is
// taken can only change what the snapshot then validates, never a fact read before or after it. Synthetic data only.
const FIXTURES = path.join(import.meta.dirname, '../native-alpha-pipeline/fixtures');
const CLIENTS = path.join(FIXTURES, 'clients');
const ARTIFACT = path.join(FIXTURES, 'artifact');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'cc-browser-consumers-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const sha256 = (bytes: string | Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const strip = (text: string) => text.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
const counter = () => ({ n: 0 });
const withGetter = <T extends object>(base: T, key: string, getter: () => unknown): T => Object.defineProperty({ ...base }, key, { get: getter, enumerable: true, configurable: true });

describe('native/1 direct consumers derive every fact from one validated snapshot of the target', () => {
	const targets = loadNativeTargets(CLIENTS);
	const others = targets.filter((t) => t.client !== 'client-a');
	const targetJson = (): Record<string, any> => JSON.parse(readFileSync(path.join(CLIENTS, 'client-a/target.json'), 'utf8'));
	const configOf = (): Record<string, any> => JSON.parse(strip(readFileSync(path.join(CLIENTS, 'client-a/wrangler.jsonc'), 'utf8')));
	const optedIn = (): NativeTarget => parseNativeTarget({ ...targetJson(), browser: { binding: 'BROWSER' } }, 'target.json');
	const facts = () => ({ files: { 'target.json': 'sha256:a' }, artifact: 'sha256:a', migrations: 'sha256:b', upload: { mode: 'prebundled-no-bundle' } as never });
	/** A browser that passes as data but, while its descriptor is read, edits a fact of the same target. */
	const trapping = (t: NativeTarget, edit: () => void, traps = counter()) => {
		t.browser = new Proxy({ binding: 'BROWSER' as const }, { getOwnPropertyDescriptor(target, key) { traps.n++; edit(); return Reflect.getOwnPropertyDescriptor(target, key); } });
		return traps;
	};

	it('the checker refuses a config that matches an assets binding changed by a browser descriptor trap', () => {
		const t = optedIn();
		const traps = trapping(t, () => { t.runtime.assetsBinding = 'BROWSER'; });
		const config: Record<string, any> = { ...configOf(), browser: { binding: 'BROWSER' } };
		config.assets.binding = 'BROWSER';
		expect(checkNativeWrangler({ client: 'client-a', targets: [t, ...others], text: JSON.stringify(config) }).length).toBeGreaterThan(0);
		expect(traps.n).toBeGreaterThan(0);
	});
	it('the checker refuses a config that matches a hostname changed by a browser descriptor trap', () => {
		const t = optedIn();
		trapping(t, () => { t.customDomain.hostname = 'other.sandbox.gridshift.co.za'; });
		const config: Record<string, any> = { ...configOf(), browser: { binding: 'BROWSER' } };
		config.routes[0].pattern = 'other.sandbox.gridshift.co.za';
		expect(checkNativeWrangler({ client: 'client-a', targets: [t, ...others], text: JSON.stringify(config) }).length).toBeGreaterThan(0);
	});
	it('the record never mixes facts read before a browser descriptor trap with live policy after it', () => {
		const pristine = nativeStageRecord(optedIn(), facts());
		const t = optedIn();
		trapping(t, () => { (t.d1 as { jurisdiction: string }).jurisdiction = 'us'; t.worker = 'cc-other'; });
		let record: ReturnType<typeof nativeStageRecord> | undefined;
		try { record = nativeStageRecord(t, facts()); } catch { record = undefined; }
		if (record) expect(record).toEqual(pristine);
	});
	it.each(['worker', 'accountId', 'runtime', 'd1', 'secrets'])('the checker and the record refuse a %s accessor without running it', (key) => {
		const reads = counter();
		const t = withGetter(optedIn(), key, () => { reads.n++; return (optedIn() as Record<string, unknown>)[key]; });
		const config: Record<string, any> = { ...configOf(), browser: { binding: 'BROWSER' } };
		expect(checkNativeWrangler({ client: 'client-a', targets: [t, ...others], text: JSON.stringify(config) }).length).toBeGreaterThan(0);
		expect(() => nativeStageRecord(t, facts())).toThrow();
		expect(reads.n).toBe(0);
	});
	it('the checker refuses accessor arguments, and an accessor target index, without running them', () => {
		const text = JSON.stringify({ ...configOf(), browser: { binding: 'BROWSER' } });
		const args = { client: 'client-a', targets: [optedIn(), ...others], text };
		expect(checkNativeWrangler(args)).toEqual([]);
		for (const key of ['client', 'targets', 'text'] as const) {
			const reads = counter();
			const value = args[key];
			expect(checkNativeWrangler(withGetter(args, key, () => (reads.n++, value)))).not.toEqual([]);
			expect(reads.n).toBe(0);
		}
		const reads = counter();
		const list = Object.defineProperty([...args.targets], '0', { get: () => (reads.n++, optedIn()), enumerable: true });
		expect(checkNativeWrangler({ ...args, targets: list })).not.toEqual([]);
		expect(reads.n).toBe(0);
	});
	it('the checker refuses a malformed target it was handed directly, whichever client it belongs to', () => {
		const text = JSON.stringify({ ...configOf(), browser: { binding: 'BROWSER' } });
		const other = { ...others[0]!, workersDev: true } as unknown as NativeTarget;
		expect(checkNativeWrangler({ client: 'client-a', targets: [optedIn(), other], text }).length).toBeGreaterThan(0);
	});
	it('the record refuses accessor facts unread and holds copies, never the caller facts', () => {
		const reads = counter();
		const f = facts();
		expect(() => nativeStageRecord(optedIn(), withGetter(f, 'upload', () => (reads.n++, f.upload)))).toThrow();
		expect(reads.n).toBe(0);
		const record = nativeStageRecord(optedIn(), f);
		f.files['target.json'] = 'sha256:changed';
		expect(record.files).toEqual({ 'target.json': 'sha256:a' });
		expect(record.upload).not.toBe(f.upload);
	});
	it('ordinary parsed targets keep their exact record and an empty check', () => {
		const record = nativeStageRecord(optedIn(), facts());
		expect(record.desired).toMatchObject({ worker: targetJson().worker, browserBinding: 'BROWSER' });
		expect(record.policy).toMatchObject({ d1Jurisdiction: 'eu', r2Jurisdiction: 'eu' });
		expect(checkNativeWrangler({ client: 'client-a', targets, text: readFileSync(path.join(CLIENTS, 'client-a/wrangler.jsonc'), 'utf8') })).toEqual([]);
	});
});

describe('native/1 invocation guard captures its arguments and argv elements as data before any stage read', () => {
	const clients = path.join(scratch, 'clients');
	cpSync(CLIENTS, clients, { recursive: true });
	const targetFile = path.join(clients, 'client-a/target.json');
	writeFileSync(targetFile, JSON.stringify({ ...JSON.parse(readFileSync(targetFile, 'utf8')), browser: { binding: 'BROWSER' } }, null, 2));
	const configFile = path.join(clients, 'client-a/wrangler.jsonc');
	writeFileSync(configFile, readFileSync(configFile, 'utf8').replace('  "r2_buckets"', '  "browser": { "binding": "BROWSER" },\n  "r2_buckets"'));
	const out = path.join(scratch, 'stage-a');
	const argv = ['wrangler', 'deploy', '--config', 'wrangler.jsonc'];
	const staged = stageNative({ client: 'client-a', artifact: ARTIFACT, digest: digestDir(ARTIFACT), out, clients });
	const args = { client: 'client-a', stage: out, cwd: out, argv };
	/** An element that would pass if stringified, and that rewrites the staged config to BROWSER2 if it is ever run. */
	const callback = (calls = counter()) => ({
		calls,
		element: { toJSON() { calls.n++; writeFileSync(path.join(out, 'wrangler.jsonc'), readFileSync(path.join(out, 'wrangler.jsonc'), 'utf8').replace('"BROWSER"', '"BROWSER2"')); return 'wrangler'; }, toString: () => 'wrangler' },
	});

	it('stages and admits the exact opt-in', () => {
		expect(staged).toEqual([]);
		expect(checkNativeUploadInvocation(args)).toEqual([]);
	});
	it('refuses an argv element with toJSON without running it, so the staged bytes are unchanged', () => {
		const before = readFileSync(path.join(out, 'wrangler.jsonc'), 'utf8');
		const { calls, element } = callback();
		try {
			expect(checkNativeUploadInvocation({ ...args, argv: [element, ...argv.slice(1)] as never }).length).toBeGreaterThan(0);
			expect(nativeUploadInvocationProblems([element, ...argv.slice(1)] as never)).toEqual([expect.stringMatching(/exactly/)]);
			expect({ calls: calls.n, unchanged: readFileSync(path.join(out, 'wrangler.jsonc'), 'utf8') === before }).toEqual({ calls: 0, unchanged: true });
		} finally {
			writeFileSync(path.join(out, 'wrangler.jsonc'), before);
		}
	});
	it.each([
		['a boxed string', () => new String('wrangler')],
		['a proxied boxed string', () => new Proxy(new String('wrangler'), {})],
		['a number', () => 7],
	])('refuses %s as an argv element', (_, make) => {
		expect(nativeUploadInvocationProblems([make(), ...argv.slice(1)] as never)).toEqual([expect.stringMatching(/exactly/)]);
		expect(checkNativeUploadInvocation({ ...args, argv: [make(), ...argv.slice(1)] as never }).length).toBeGreaterThan(0);
	});
	it('never runs a get trap of a proxied argv: the verdict comes from its own data', () => {
		const gets = counter();
		const proxied = new Proxy([...argv], { get(target, key, receiver) { gets.n++; return key === '0' ? 'npx' : Reflect.get(target, key, receiver); } });
		nativeUploadInvocationProblems(proxied);
		checkNativeUploadInvocation({ ...args, argv: proxied });
		expect(gets.n).toBe(0);
	});
	it.each(['client', 'stage', 'cwd', 'argv'] as const)('refuses a %s accessor without running it', (key) => {
		const reads = counter();
		const value = args[key];
		expect(checkNativeUploadInvocation(withGetter(args, key, () => (reads.n++, value))).length).toBeGreaterThan(0);
		expect(reads.n).toBe(0);
	});
});

describe('native/1 check and stage entry points read their arguments once, as data', () => {
	const targets = loadNativeTargets(CLIENTS);
	const text = readFileSync(path.join(CLIENTS, 'client-a/wrangler.jsonc'), 'utf8');
	let n = 0;
	const stageArgs = () => ({ client: 'client-a', artifact: ARTIFACT, digest: digestDir(ARTIFACT), out: path.join(scratch, `entry-${n++}`), clients: CLIENTS });

	it.each(['client', 'targets', 'format', 'text'] as const)('checkNative refuses a %s accessor without running it', (key) => {
		const args = { client: 'client-a', targets, format: 'wrangler' as const, text };
		expect(checkNative(args)).toEqual([]);
		const reads = counter();
		expect(checkNative(withGetter(args, key, () => (reads.n++, args[key])))).not.toEqual([]);
		expect(reads.n).toBe(0);
	});
	it.each(['client', 'artifact', 'digest', 'out', 'clients'] as const)('stageNative refuses a %s accessor without running it, and creates nothing', (key) => {
		const args = stageArgs();
		const reads = counter();
		expect(stageNative(withGetter(args, key, () => (reads.n++, args[key])))).not.toEqual([]);
		expect({ reads: reads.n, created: existsSync(args.out) }).toEqual({ reads: 0, created: false });
	});
	it.each(['client', 'stage', 'clients', 'pins'] as const)('checkNativeStage and readNativeStage refuse a %s accessor without running it', (key) => {
		const args = stageArgs();
		expect(stageNative(args)).toEqual([]);
		const pins = { target: sha256(readFileSync(path.join(CLIENTS, 'client-a/target.json'))), config: sha256(readFileSync(path.join(CLIENTS, 'client-a/wrangler.jsonc'))), artifact: `sha256:${'0'.repeat(64)}`, migrations: `sha256:${'1'.repeat(64)}`, entry: `sha256:${'2'.repeat(64)}`, source: 'a'.repeat(40) };
		const check = { client: 'client-a', stage: args.out, clients: CLIENTS, pins };
		const reads = counter();
		const hostile = withGetter(check, key, () => (reads.n++, check[key]));
		expect(checkNativeStage(hostile)).not.toEqual([]);
		const reading = readNativeStage(hostile);
		expect({ refused: reading.problems.length > 0, record: reading.record, reads: reads.n }).toEqual({ refused: true, record: null, reads: 0 });
	});
});

describe('workers.dev bootstrap invocation captures argv as primitive strings before stage verification', () => {
	const SOURCE = 'a'.repeat(40);
	const STAMP = { revision: SOURCE, dirty: false, exported: false, builtAt: '2026-10-25T06:40:03.000Z', bun: '1.4.2', buildId: 'synthetic-browser', target: 'cloudflare', profile: 'production' };
	const worker = `const embedded = ${JSON.stringify(JSON.stringify(STAMP))};
const kit_manifest = (() => { return { app_dir: "_app", app_path: "_app", assets: new Set(["robots.txt"]), client: { start: "_app/immutable/start.js", app: "_app/immutable/app.js", imports: ["_app/immutable/chunk.js"], stylesheets: ["_app/immutable/site.css"], fonts: [] } }; })();
const server = create_server(kit_manifest);
export default { async fetch() { await server.respond(); return new Response(embedded); } };\n`;
	const root = path.join(scratch, 'bootstrap');
	const artifact = path.join(root, 'source-artifact'), out = path.join(root, 'stage');
	const files: Record<string, string> = {
		'cloudflare/_worker.js': worker, 'public/_app/version.json': JSON.stringify({ version: SOURCE }), 'public/robots.txt': 'User-agent: *\nDisallow:\n',
		'public/_app/immutable/start.js': 'export function start() {}\n', 'public/_app/immutable/app.js': 'import "./chunk.js";\n', 'public/_app/immutable/chunk.js': 'export const loaded = true;\n',
		'public/_app/immutable/site.css': 'body { color: black; }\n', 'public/_headers': NATIVE_ADAPTER_HEADERS,
	};
	for (const [rel, bytes] of Object.entries(files)) (mkdirSync(path.dirname(path.join(artifact, rel)), { recursive: true }), writeFileSync(path.join(artifact, rel), bytes));
	const settings: BootstrapSettings = { pins: { source: SOURCE, artifact: digestDir(artifact), entry: sha256(worker) }, compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'], browserClients: ['client-a'] };
	prepareWorkersDevBootstrap({ artifact, out, settings });
	const argv = ['wrangler', 'deploy', '--config', 'client-a.wrangler.json'];
	const args = { stage: out, settings, cwd: out, slot: 'client-a' as const, argv };
	const config = path.join(out, 'client-a.wrangler.json');

	it('admits the exact plain argv', () => expect(() => checkWorkersDevBootstrapInvocation(args)).not.toThrow());
	it('refuses an argv element with toJSON without running it, so the checked config is unchanged', () => {
		const before = readFileSync(config, 'utf8');
		const calls = counter();
		const element = { toJSON() { calls.n++; writeFileSync(config, before.replace('"BROWSER"', '"BROWSER2"')); return 'wrangler'; }, toString: () => 'not-wrangler' };
		try {
			expect(() => checkWorkersDevBootstrapInvocation({ ...args, argv: [element, ...argv.slice(1)] as never })).toThrow(/argv/);
			expect({ calls: calls.n, unchanged: readFileSync(config, 'utf8') === before }).toEqual({ calls: 0, unchanged: true });
		} finally {
			writeFileSync(config, before);
		}
	});
	it.each([
		['an object', () => ({ valueOf: () => 'wrangler' })],
		['a proxied string object', () => new Proxy(new String('wrangler'), {})],
		['a boxed string', () => new String('wrangler')],
		['a number', () => 1],
	])('refuses %s as an argv element', (_, make) => {
		expect(() => checkWorkersDevBootstrapInvocation({ ...args, argv: [make(), ...argv.slice(1)] as never })).toThrow(/argv/);
	});
	it('checks argv, cwd and slot before reading the stage: a bad argv is named even for a missing stage', () => {
		const missing = path.join(root, 'missing');
		expect(existsSync(missing)).toBe(false);
		expect(() => checkWorkersDevBootstrapInvocation({ ...args, stage: missing, argv: [{ toJSON: () => 'wrangler' }, ...argv.slice(1)] as never })).toThrow(/argv/);
		expect(() => checkWorkersDevBootstrapInvocation({ ...args, stage: missing, cwd: 7 as never })).toThrow(/cwd/);
	});
});
