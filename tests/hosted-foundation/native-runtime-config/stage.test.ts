// Exclusive staging and re-reading. A stage is private, new, exact and unlinked; nothing already on disk is ever changed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NATIVE_RUNTIME_CONFIG_MANIFEST, nativeRuntimeConfigDiagnostic, planNativeRuntimeConfig, prepareNativeRuntimeConfig, readNativeRuntimeConfig } from '../../../deploy/native-alpha/runtime-config.ts';
import { exampleInput, exampleWithBrowserAllocation } from './example-input.ts';

let root: string;
beforeAll(() => { root = realpathSync(mkdtempSync(path.join(tmpdir(), 'native-runtime-config-'))); });
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => path.join(root, `stage-${++n}`);
const refused = (work: () => unknown) => { try { work(); } catch (error) { const message = nativeRuntimeConfigDiagnostic(error); if (message === undefined) throw new Error('refusal was not issued by the planner'); return message; } throw new Error('accepted'); };
const names = (dir: string) => readdirSync(dir).sort();

describe('prepare and read', () => {
	it('stages exactly the planned files, privately, and re-reads them', () => {
		const out = fresh(), plan = planNativeRuntimeConfig(exampleInput());
		const staged = prepareNativeRuntimeConfig({ input: exampleInput(), out });
		expect(names(out)).toEqual(['client-a.runtime.json', 'client-b.runtime.json', NATIVE_RUNTIME_CONFIG_MANIFEST]);
		for (const [name, bytes] of plan.files) expect(readFileSync(path.join(out, name), 'utf8')).toBe(bytes);
		expect(lstatSync(out).mode & 0o777).toBe(0o700);
		expect(lstatSync(path.join(out, NATIVE_RUNTIME_CONFIG_MANIFEST)).mode & 0o777).toBe(0o600);
		expect(staged.stage).toBe(out);
		expect(staged.manifest).toMatchObject({ providerProof: false, provisioned: false, deployed: false });
		expect(JSON.parse(readFileSync(path.join(out, NATIVE_RUNTIME_CONFIG_MANIFEST), 'utf8'))).toMatchObject({ providerProof: false, provisioned: false, deployed: false });
		expect(readNativeRuntimeConfig({ input: exampleInput(), stage: out }).manifestText).toBe(plan.manifestText);
	});
	it('stages the planned Browser allocation byte for byte', () => {
		const out = fresh();
		const staged = prepareNativeRuntimeConfig({ input: exampleWithBrowserAllocation(), out });
		expect(JSON.parse(readFileSync(path.join(out, NATIVE_RUNTIME_CONFIG_MANIFEST), 'utf8')).plannedBrowserAllocation).toMatchObject({ kind: 'planned-allocation', accountAvailabilityProven: false, spendProven: false });
		expect(staged.manifest.plannedBrowserAllocation?.totals).toEqual({ concurrentBrowsers: 2, reservedMsPerDay: 211_000 });
	});
	it('never creates anything when the input is refused', () => {
		const out = fresh(), input = exampleInput();
		input.clients[0]!.policy.storageBudgets.maxDocuments = 0;
		refused(() => prepareNativeRuntimeConfig({ input, out }));
		expect(lstatSync(out, { throwIfNoEntry: false })).toBeUndefined();
	});
});

describe('unsafe stages', () => {
	it('refuses an existing directory, file and dangling link without touching them', () => {
		const dir = fresh(); mkdirSync(dir); writeFileSync(path.join(dir, 'keep.txt'), 'keep');
		refused(() => prepareNativeRuntimeConfig({ input: exampleInput(), out: dir }));
		expect(names(dir)).toEqual(['keep.txt']);
		const file = fresh(); writeFileSync(file, 'file');
		refused(() => prepareNativeRuntimeConfig({ input: exampleInput(), out: file }));
		expect(readFileSync(file, 'utf8')).toBe('file');
		const dangling = fresh(); symlinkSync(path.join(root, 'nowhere'), dangling);
		refused(() => prepareNativeRuntimeConfig({ input: exampleInput(), out: dangling }));
		expect(lstatSync(path.join(root, 'nowhere'), { throwIfNoEntry: false })).toBeUndefined();
	});
	it('refuses relative, non-canonical, dotted, trailing-slash and non-string locations', () => {
		for (const out of ['relative-stage', './x', `${root}/a/../b`, `${root}//double`, `${root}/stage-slash/`, '', `${root}/nul\0`, 7, null, {}])
			refused(() => prepareNativeRuntimeConfig({ input: exampleInput(), out: out as string }));
	});
	it('refuses a symlinked parent, a missing parent and a link as the parent of a verify target', () => {
		const real = path.join(root, 'real-parent'); mkdirSync(real);
		const link = path.join(root, 'link-parent'); symlinkSync(real, link);
		refused(() => prepareNativeRuntimeConfig({ input: exampleInput(), out: path.join(link, 'stage') }));
		expect(names(real)).toEqual([]);
		refused(() => prepareNativeRuntimeConfig({ input: exampleInput(), out: path.join(root, 'missing-parent', 'stage') }));
		const out = path.join(real, 'stage'); prepareNativeRuntimeConfig({ input: exampleInput(), out });
		refused(() => readNativeRuntimeConfig({ input: exampleInput(), stage: path.join(link, 'stage') }));
	});
	it('refuses a symlinked stage directory', () => {
		const out = fresh(); prepareNativeRuntimeConfig({ input: exampleInput(), out });
		const link = fresh(); symlinkSync(out, link);
		refused(() => readNativeRuntimeConfig({ input: exampleInput(), stage: link }));
	});
});

describe('changed stage bytes', () => {
	const stage = () => { const out = fresh(); prepareNativeRuntimeConfig({ input: exampleInput(), out }); return out; };
	const read = (out: string, input: unknown = exampleInput()) => readNativeRuntimeConfig({ input, stage: out });
	it('refuses a changed byte of the same size, a truncation and an appended byte in any file', () => {
		for (const name of ['client-a.runtime.json', 'client-b.runtime.json', NATIVE_RUNTIME_CONFIG_MANIFEST]) {
			const same = stage(), file = path.join(same, name), bytes = readFileSync(file);
			bytes[bytes.length - 3] = bytes[bytes.length - 3] === 0x61 ? 0x62 : 0x61;
			writeFileSync(file, bytes); expect(refused(() => read(same))).toMatch(/exactly the planned/);
			const shorter = stage(); truncateSync(path.join(shorter, name), 10); refused(() => read(shorter));
			const longer = stage(); writeFileSync(path.join(longer, name), `${readFileSync(path.join(longer, name), 'utf8')} `); refused(() => read(longer));
		}
	});
	it('refuses a changed manifest hash even when the client file it names is untouched', () => {
		const out = stage(), file = path.join(out, NATIVE_RUNTIME_CONFIG_MANIFEST);
		writeFileSync(file, readFileSync(file, 'utf8').replace('"deployed": false', '"deployed": true'));
		refused(() => read(out));
	});
	it('refuses missing, extra, directory, symlink and hard-linked entries', () => {
		const missing = stage(); rmSync(path.join(missing, 'client-b.runtime.json')); refused(() => read(missing));
		const extra = stage(); writeFileSync(path.join(extra, 'extra.txt'), 'x'); refused(() => read(extra));
		const dir = stage(); rmSync(path.join(dir, 'client-b.runtime.json')); mkdirSync(path.join(dir, 'client-b.runtime.json')); refused(() => read(dir));
		const linked = stage(), target = path.join(linked, 'client-b.runtime.json'), copy = readFileSync(target);
		rmSync(target); writeFileSync(path.join(root, `outside-${n}`), copy); symlinkSync(path.join(root, `outside-${n}`), target); refused(() => read(linked));
		const hard = stage(); linkSync(path.join(hard, 'client-a.runtime.json'), path.join(root, `hard-${n}`)); refused(() => read(hard));
	});
	it('refuses a stage prepared from other input', () => {
		const out = stage(), other = exampleInput();
		other.clients[0]!.policy.nativeRenderBudget!.maxPages = 5;
		refused(() => read(out, other));
		const noClerkChange = exampleInput(); noClerkChange.clients[1]!.clerk.mfaRequired = true;
		refused(() => read(out, noClerkChange));
	});
	it('refuses a stage whose directory or files are not private (0700 directory, 0600 files)', () => {
		const loose = stage(); chmodSync(loose, 0o755); expect(refused(() => read(loose))).toMatch(/exactly the planned/); chmodSync(loose, 0o700);
		const group = stage(); chmodSync(group, 0o770); refused(() => read(group)); chmodSync(group, 0o700);
		for (const name of ['client-a.runtime.json', 'client-b.runtime.json', NATIVE_RUNTIME_CONFIG_MANIFEST]) {
			for (const mode of [0o644, 0o640, 0o666, 0o400, 0o700]) {
				const out = stage(); chmodSync(path.join(out, name), mode);
				expect(refused(() => read(out))).toMatch(/exactly the planned/);
			}
		}
	});
	it.each([0o1000, 0o2000, 0o4000])('refuses special mode bit %o on the stage directory', (bit) => {
		const out = stage(); chmodSync(out, 0o700 | bit);
		expect(lstatSync(out).mode & 0o7777).toBe(0o700 | bit);
		expect(refused(() => read(out))).toMatch(/exactly the planned/);
	});
	it.each([0o1000, 0o2000, 0o4000])('refuses special mode bit %o on every stage file', (bit) => {
		for (const name of ['client-a.runtime.json', 'client-b.runtime.json', NATIVE_RUNTIME_CONFIG_MANIFEST]) {
			const out = stage(), file = path.join(out, name); chmodSync(file, 0o600 | bit);
			expect(lstatSync(file).mode & 0o7777).toBe(0o600 | bit);
			expect(refused(() => read(out))).toMatch(/exactly the planned/);
		}
	});
	it('does not change a stage it refuses', () => {
		const out = stage(); writeFileSync(path.join(out, 'extra.txt'), 'x');
		const before = names(out); refused(() => read(out)); expect(names(out)).toEqual(before);
		chmodSync(out, 0o700);
	});
});
