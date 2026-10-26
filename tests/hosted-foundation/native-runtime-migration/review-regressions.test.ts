import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleNativeRuntimeMigration as assemble, NATIVE_RUNTIME_MIGRATION_INPUTS as PINS, prepareNativeRuntimeMigration, readNativeRuntimeMigration, checkNativeRuntimeMigrationInvocation } from '../../../deploy/native-alpha/runtime-migration.ts';
import { prepareNativeSchema, readNativeSchema, checkNativeSchemaInvocation } from '../../../deploy/native-alpha/schema.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const scratch: string[] = [];
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), 'cc-migration-review-')); scratch.push(dir); return dir; };
const sources = (): { path: string; bytes: Uint8Array }[] => PINS.map(pin => ({ path: pin.path, bytes: new Uint8Array(readFileSync(path.join(root, pin.path))) }));
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

for (const api of [
	{ name: 'runtime increment', prepare: prepareNativeRuntimeMigration, read: readNativeRuntimeMigration, check: checkNativeRuntimeMigrationInvocation },
	{ name: 'initial schema', prepare: prepareNativeSchema, read: readNativeSchema, check: checkNativeSchemaInvocation },
]) describe(api.name, () => {
	it('H1: refuses symlink/.. cwd even when lexical normalization equals the verified stage', () => {
		const parent = temp(), stage = path.join(parent, 'stage');
		const checked = api.prepare({ root, out: stage }), target = checked.manifest.targets[0]!;
		const other = path.join(parent, 'other');
		mkdirSync(path.join(other, 'child'), { recursive: true });
		mkdirSync(path.join(other, 'stage'));
		symlinkSync(path.join(other, 'child'), path.join(parent, 'alias'));
		const cwd = `${parent}/alias/../stage`;
		expect(path.resolve(cwd)).toBe(stage);
		// Harmless real child proves the filesystem meaning of the supplied execution cwd.
		const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd, encoding: 'utf8' });
		expect(child.status).toBe(0);
		expect(child.stdout).toBe(realpathSync(path.join(other, 'stage')));
		expect(() => api.check({ root, stage, cwd, slot: target.slot, argv: target.argv })).toThrow();
	});

	it('requires the exact absolute execution cwd, not relative, dot, slash or ancestor aliases', () => {
		const parent = temp(), checked = api.prepare({ root, out: path.join(parent, 'stage') });
		const stage = checked.stage, target = checked.manifest.targets[0]!;
		const invocation = { root, stage, cwd: stage, slot: target.slot, argv: target.argv };
		expect(api.check(invocation).target).toEqual(target);
		const alias = path.join(temp(), 'parent'); symlinkSync(parent, alias);
		for (const cwd of [path.relative(process.cwd(), stage), `${stage}/`, `${stage}/.`, `${parent}//stage`, `${stage}/../stage`, path.join(alias, 'stage')]) {
			expect(() => api.check({ ...invocation, cwd }), cwd).toThrow();
		}
	});

	it('does not erase raw traversal in root, stage or output before validation', () => {
		const parent = temp(), checked = api.prepare({ root, out: path.join(parent, 'stage') });
		const target = checked.manifest.targets[0]!;
		mkdirSync(path.join(parent, 'other', 'child'), { recursive: true });
		symlinkSync(path.join(parent, 'other', 'child'), path.join(parent, 'alias'));
		const badStage = `${parent}/alias/../stage`;
		const badRoot = `${root}../${path.basename(path.resolve(root))}`;
		const badOut = `${parent}/alias/../new`;
		expect(() => api.read({ root, stage: badStage })).toThrow();
		expect(() => api.read({ root: badRoot, stage: checked.stage })).toThrow();
		expect(() => api.check({ root, stage: badStage, cwd: checked.stage, slot: target.slot, argv: target.argv })).toThrow();
		expect(() => api.prepare({ root, out: badOut })).toThrow();
		expect(existsSync(path.join(parent, 'new'))).toBe(false);
		expect(existsSync(path.join(parent, 'other', 'new'))).toBe(false);
		expect(api.read({ root, stage: checked.stage })).toEqual(checked);
	});

	it('refuses ancestor links in root, stage and output while retaining relative CLI preparation', () => {
		const parent = temp(), checked = api.prepare({ root, out: path.join(parent, 'stage') });
		const alias = path.join(temp(), 'parent'); symlinkSync(parent, alias);
		const rootAlias = path.join(temp(), 'root'); symlinkSync(path.resolve(root), rootAlias);
		expect(() => api.read({ root: rootAlias, stage: checked.stage })).toThrow();
		expect(() => api.read({ root, stage: path.join(alias, 'stage') })).toThrow();
		expect(() => api.prepare({ root, out: path.join(alias, 'new') })).toThrow();
		const script = api.name === 'initial schema' ? 'scripts/hosted-native-schema.ts' : 'scripts/hosted-native-runtime-migration.ts';
		const out = path.join(parent, 'cli-stage');
		for (const command of ['prepare', 'verify']) {
			const child = spawnSync(process.execPath, [script, command, path.relative(root, out)], { cwd: root, encoding: 'utf8' });
			expect(child.status, child.stderr).toBe(0);
		}
		expect(api.read({ root, stage: out }).manifest.targets).toEqual(checked.manifest.targets);
	});
});

it('M1: refuses disguised resizable backing storage without invoking its resizable getter', () => {
	const inputs = sources(), bytes = inputs[0]!.bytes;
	const buffer = new ArrayBuffer(bytes.byteLength, { maxByteLength: bytes.byteLength * 2 });
	const view = new Uint8Array(buffer); view.set(bytes); inputs[0]!.bytes = view;
	const getter = vi.fn(() => false);
	Object.defineProperty(buffer, 'resizable', { get: getter });
	expect(() => assemble(inputs)).toThrow();
	expect(getter).not.toHaveBeenCalled();
});

it.each(['resizable', 'byteLength', 'maxByteLength', 'constructor'])('ignores caller-owned backing-store %s getters on valid fixed bytes', key => {
	const inputs = sources(), baseline = assemble(inputs), getter = vi.fn(() => { throw new Error('caller backing getter ran'); });
	Object.defineProperty(inputs[0]!.bytes.buffer, key, { get: getter });
	expect(assemble(inputs)).toEqual(baseline);
	expect(getter).not.toHaveBeenCalled();
});

it.each(['buffer', 'byteLength', 'byteOffset', 'length', 'slice', 'subarray', 'set', 'constructor', Symbol.iterator])('refuses overridden view %s without executing it', key => {
	const inputs = sources(), getter = vi.fn(() => { throw new Error('caller view getter ran'); });
	Object.defineProperty(inputs[0]!.bytes, key, { get: getter });
	expect(() => assemble(inputs)).toThrow();
	expect(getter).not.toHaveBeenCalled();
});

it.each(['fixed-shared', 'growing-shared', 'resizable', 'detached'] as const)('refuses actual %s slots despite disguised backing properties', kind => {
	const inputs = sources(), bytes = inputs[0]!.bytes, size = bytes.byteLength;
	const buffer = kind === 'fixed-shared' ? new SharedArrayBuffer(size)
		: kind === 'growing-shared' ? new SharedArrayBuffer(size, { maxByteLength: size * 2 })
		: new ArrayBuffer(size, kind === 'resizable' ? { maxByteLength: size * 2 } : undefined);
	const view = new Uint8Array(buffer); view.set(bytes); inputs[0]!.bytes = view;
	if (kind === 'detached') structuredClone(buffer, { transfer: [buffer] });
	const getter = vi.fn(() => false);
	for (const key of ['resizable', 'growable', 'byteLength', 'maxByteLength']) Object.defineProperty(buffer, key, { get: getter });
	// Even prototype spoofing must not turn shared storage into an ordinary ArrayBuffer.
	if (kind.includes('shared')) Object.setPrototypeOf(buffer, ArrayBuffer.prototype);
	expect(() => assemble(inputs)).toThrow();
	expect(getter).not.toHaveBeenCalled();
});

it('rejects a proxied view without invoking property or prototype traps', () => {
	const inputs = sources(), trap = vi.fn(() => { throw new Error('caller proxy trap ran'); });
	inputs[0]!.bytes = new Proxy(inputs[0]!.bytes, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
	expect(() => assemble(inputs)).toThrow();
	expect(trap).not.toHaveBeenCalled();
});

it('keeps the exact pinned SQL and manifest bytes', () => {
	const plan = assemble(sources());
	expect(plan.manifest.output).toEqual({ path: 'migrations/0002_native_runtime.sql', bytes: 20618, sha256: 'sha256:e854e9d1c6bca7a439dd5903ace1a3e7d01382dae3a7e79e624146f870cda97f' });
	expect(Buffer.byteLength(plan.manifestText)).toBe(2846);
	expect(createHash('sha256').update(plan.manifestText).digest('hex')).toBe('4151a457444576641ad7413b5308d10502f1062c1ba79111844f1caed8557dba');
});

it('accepts exact Buffer and offset Uint8Array views without iterators or species, captures bytes once', () => {
	const inputs = PINS.map(pin => ({ path: pin.path, bytes: readFileSync(path.join(root, pin.path)) }));
	const baseline = assemble(inputs);
	const offsetInputs = inputs.map(input => {
		const backing = new ArrayBuffer(input.bytes.byteLength + 16), view = new Uint8Array(backing, 8, input.bytes.byteLength);
		view.set(input.bytes);
		return { path: input.path, bytes: view };
	});
	const getter = vi.fn(() => { throw new Error('backing constructor/species ran'); });
	for (const input of offsetInputs) Object.defineProperty(input.bytes.buffer, 'constructor', { get: getter });
	const captured = assemble(offsetInputs);
	for (const input of offsetInputs) input.bytes.fill(0);
	expect(captured).toEqual(baseline);
	expect(getter).not.toHaveBeenCalled();
});
