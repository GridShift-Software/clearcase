import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkNativeWrangler, nativeDiagnosticText, nativeStageRecord, parseNativeJson, parseNativeTarget, plainData } from '../../../../deploy/native-alpha/pipeline.ts';
import { checkNative, checkNativeStage, checkNativeUploadInvocation, digestDir, loadNativeTargets, readNativeStage, stageNative } from '../../../../deploy/probes/target.ts';
import { checkWorkersDevBootstrapInvocation, planWorkersDevBootstrap, prepareWorkersDevBootstrap, readWorkersDevBootstrap } from '../../../../deploy/native-alpha/workers-dev-bootstrap.ts';

const scratch = mkdtempSync(path.join(os.tmpdir(), 'cc-native-error-diagnostics-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const fixtures = path.join(import.meta.dirname, '../native-alpha-pipeline/fixtures');
const clients = path.join(scratch, 'clients');
cpSync(path.join(fixtures, 'clients'), clients, { recursive: true });
const targetFile = path.join(clients, 'client-a/target.json');
writeFileSync(targetFile, JSON.stringify({ ...JSON.parse(readFileSync(targetFile, 'utf8')), browser: { binding: 'BROWSER' } }));
const sourceConfig = path.join(clients, 'client-a/wrangler.jsonc');
writeFileSync(sourceConfig, readFileSync(sourceConfig, 'utf8').replace('  "r2_buckets"', '  "browser": { "binding": "BROWSER" },\n  "r2_buckets"'));
const artifact = path.join(fixtures, 'artifact'), stage = path.join(scratch, 'stage');
const stageArgs = { client: 'client-a', clients, artifact, digest: digestDir(artifact), out: stage };
const targets = loadNativeTargets(clients), target = targets.find((t) => t.client === 'client-a')!;
const text = readFileSync(sourceConfig, 'utf8');
const config = path.join(stage, 'wrangler.jsonc');
const argv = ['wrangler', 'deploy', '--config', 'wrangler.jsonc'];
const refused = (run: () => unknown): boolean => { try { run(); return false; } catch { return true; } };
const caught = (run: () => unknown): object => { try { run(); } catch (e) { if (e !== null && typeof e === 'object') return e; } throw Error('test requires an issued error'); };
const trap = <T extends object>(value: T, thrown: unknown, kind: string): T => new Proxy(value, {
	...(kind === 'ownKeys' ? { ownKeys() { throw thrown; } } : {}),
	...(kind === 'descriptor' ? { getOwnPropertyDescriptor() { throw thrown; } } : {}),
	...(kind === 'prototype' ? { getPrototypeOf() { throw thrown; } } : {}),
});
const errors: [string, (callback: () => void) => unknown][] = [
	['message getter', (callback) => Object.defineProperty({}, 'message', { get() { callback(); return 'caller error'; } })],
	['Proxy Error (all traps)', (callback) => new Proxy(new Error('caller error'), {
		get() { callback(); return 'caller error'; }, getPrototypeOf() { callback(); return Error.prototype; },
		ownKeys() { callback(); return []; }, getOwnPropertyDescriptor() { callback(); return undefined; },
	})],
	['coercible message', (callback) => ({ message: { [Symbol.toPrimitive]() { callback(); return 'caller error'; } } })],
	['toJSON message', (callback) => ({ message: { toJSON() { callback(); return 'caller error'; } } })],
	['name and stack getters', (callback) => Object.defineProperties({}, {
		name: { get() { callback(); return 'Error'; } }, stack: { get() { callback(); return 'caller stack'; } },
	})],
	['iterator and coercion', (callback) => ({ [Symbol.iterator]() { callback(); return [][Symbol.iterator](); }, toString() { callback(); return 'caller error'; }, valueOf() { callback(); return 1; } })],
	['mutated issued parser Error', (callback) => Object.defineProperties(caught(() => parseNativeJson('{')), {
		stack: { get() { callback(); return 'changed stack'; }, configurable: true },
		name: { get() { callback(); return 'changed name'; }, configurable: true },
		message: { get() { callback(); return 'changed message'; }, configurable: true },
	})],
	['Proxy of issued target Error', (callback) => new Proxy(caught(() => parseNativeTarget({}, 'target')), { get() { callback(); return 'changed'; }, getPrototypeOf() { callback(); return Error.prototype; } })],
	['null', () => null], ['undefined', () => undefined], ['symbol', () => Symbol('caller')],
];

it.each([['Wrangler', checkNativeWrangler], ['native', checkNative]] as const)('%s refuses a descriptor-trap throw without reading its message (review repro)', (_, check) => {
	let callbacks = 0;
	const thrown = Object.defineProperty({}, 'message', { get() { callbacks++; return 'caller error'; } });
	expect(check(trap({ client: 'client-a', targets: [], text: '{}' }, thrown, 'ownKeys')).length).toBeGreaterThan(0);
	expect(callbacks).toBe(0);
});

it('legitimate opt-in stage and invocation still succeed', () => {
	expect(stageNative(stageArgs)).toEqual([]);
	expect(checkNativeWrangler({ client: 'client-a', targets, text })).toEqual([]);
	expect(checkNativeUploadInvocation({ client: 'client-a', stage, cwd: stage, argv })).toEqual([]);
});

const entries: [string, (thrown: unknown, kind: string) => boolean][] = [
	['Wrangler arguments', (e, k) => checkNativeWrangler(trap({ client: 'client-a', targets, text }, e, k)).length > 0],
	['Wrangler nested target', (e, k) => checkNativeWrangler({ client: 'client-a', targets: [trap(target, e, k)], text }).length > 0],
	['native arguments', (e, k) => checkNative(trap({ client: 'client-a', targets, text }, e, k)).length > 0],
	['target parser', (e, k) => refused(() => parseNativeTarget(trap(target, e, k), 'target'))],
	['stage record target', (e, k) => refused(() => nativeStageRecord(trap(target, e, k), {} as never))],
	['stage record facts', (e, k) => refused(() => nativeStageRecord(target, trap({ files: {} }, e, k) as never))],
	['plain data', (e, k) => refused(() => plainData(trap({ field: true }, e, k), 'input'))],
	['stage creation', (e, k) => stageNative(trap({ ...stageArgs, out: path.join(scratch, 'must-not-exist') }, e, k)).length > 0],
	['stage reading', (e, k) => readNativeStage(trap({ client: 'client-a', stage, clients }, e, k)).problems.length > 0],
	['stage wrapper', (e, k) => checkNativeStage(trap({ client: 'client-a', stage, clients }, e, k)).length > 0],
	['upload invocation', (e, k) => checkNativeUploadInvocation(trap({ client: 'client-a', stage, cwd: stage, argv }, e, k)).length > 0],
	['bootstrap plan', (e, k) => refused(() => planWorkersDevBootstrap(trap({}, e, k)))],
	['bootstrap prepare', (e, k) => refused(() => prepareWorkersDevBootstrap(trap({ artifact, out: stage, settings: {} }, e, k)))],
	['bootstrap reading', (e, k) => refused(() => readWorkersDevBootstrap(trap({ stage, settings: {} }, e, k)))],
	['bootstrap invocation', (e, k) => refused(() => checkWorkersDevBootstrapInvocation(trap({ stage, settings: {}, slot: 'client-a', cwd: stage, argv }, e, k) as never))],
];
describe.each(entries)('%s: refusal diagnostics never execute the thrown value or mutate the checked stage', (_, run) => {
	it.each(errors)('%s', (_, make) => {
		const before = readFileSync(config, 'utf8');
		let callbacks = 0;
		const error = make(() => { callbacks++; writeFileSync(config, before.replaceAll('"BROWSER"', '"BROWSER2"')); });
		try {
			for (const kind of ['ownKeys', 'descriptor', 'prototype']) expect(run(error, kind)).toBe(true);
			expect({ callbacks, unchanged: readFileSync(config, 'utf8') === before, created: existsSync(path.join(scratch, 'must-not-exist')) }).toEqual({ callbacks: 0, unchanged: true, created: false });
		} finally { writeFileSync(config, before); }
	});
});

it('private diagnostics keep the original text after an issued Error is mutated, without reading its properties', () => {
	const error = caught(() => parseNativeJson('{'));
	const original = nativeDiagnosticText(error);
	let callbacks = 0;
	Object.defineProperties(error, {
		stack: { get() { callbacks++; return 'changed stack'; }, configurable: true },
		name: { get() { callbacks++; return 'changed name'; }, configurable: true },
		message: { get() { callbacks++; return 'changed message'; }, configurable: true },
	});
	expect(original).toMatch(/expected a string key at offset/);
	expect(nativeDiagnosticText(error)).toBe(original);
	expect(nativeDiagnosticText(new Proxy(error, { get() { callbacks++; return 'changed'; }, getPrototypeOf() { callbacks++; return Error.prototype; } }))).toBeUndefined();
	expect(callbacks).toBe(0);
});

it('private diagnostics do not inspect revoked Proxies, primitives or forged Error properties', () => {
	const { proxy, revoke } = Proxy.revocable(new Error('not issued'), {});
	revoke();
	for (const value of [proxy, null, undefined, Symbol('error'), 'error', 3, { message: 'forged', name: 'Error', stack: 'forged' }]) expect(nativeDiagnosticText(value)).toBeUndefined();
});

it('the authoritative stage still admits the exact invocation after every refusal control', () => {
	expect(checkNativeUploadInvocation({ client: 'client-a', stage, cwd: stage, argv })).toEqual([]);
});

it('genuine malformed JSON and captured data retain specific internal diagnostics', () => {
	expect(checkNativeWrangler({ client: 'client-a', targets, text: '{"name":1,"name":2}' }).join('\n')).toMatch(/duplicate key "name" at offset/);
	expect(checkNativeWrangler({ client: 'client-a', targets, text: '{' }).join('\n')).toMatch(/expected a string key at offset/);
	const accessor = Object.defineProperty({ ...target }, 'browser', { enumerable: true, get() { throw Error('must not read'); } });
	expect(checkNativeWrangler({ client: 'client-a', targets: [accessor], text }).join('\n')).toMatch(/browser.*accessor field/);
	expect(() => parseNativeTarget({ ...target, workersDev: true }, 'reviewed target')).toThrow(/reviewed target: workersDev is true, not false/);
});
