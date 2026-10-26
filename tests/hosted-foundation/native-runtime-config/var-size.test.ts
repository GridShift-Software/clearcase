// Every emitted variable is held to the per-variable byte cap, not only CLEARCASE_NATIVE_CONFIG. Cloudflare documents 5 KB per
// variable; the planner caps at 5000 UTF-8 bytes so it stays inside either reading (5000 or 5120). A bound, not a claim about the
// provider's exact refusal point, a variable count, or spend.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { NATIVE_RUNTIME_CONFIG_MAX_BYTES, nativeRuntimeConfigDiagnostic, planNativeRuntimeConfig, prepareNativeRuntimeConfig } from '../../../deploy/native-alpha/runtime-config.ts';
import { exampleInput, exampleWithBrowserAllocation } from './example-input.ts';
import { refusalOf } from './harness.ts';

const CAP = 5000;
const prefix = 'https://client-a.clerk.test/sign-in/';
const urlOfBytes = (bytes: number) => prefix + 'a'.repeat(bytes - prefix.length);
const withSignIn = (bytes: number) => { const i = exampleWithBrowserAllocation(); i.clients[0]!.clerk.signInUrl = urlOfBytes(bytes); return i; };

describe('the per-variable byte cap', () => {
	it('is the conservative 5000 bytes, inside both readings of Cloudflare\'s 5 KB', () => {
		expect(NATIVE_RUNTIME_CONFIG_MAX_BYTES).toBe(CAP);
	});
	it('accepts an optional Clerk URL of exactly the cap and refuses one byte more, naming the variable and never the value', () => {
		const ok = planNativeRuntimeConfig(withSignIn(CAP)).clients[0]!;
		expect(Buffer.byteLength(ok.vars.CLERK_CLIENT_SIGN_IN_URL!)).toBe(CAP);
		const message = refusalOf(withSignIn(CAP + 1));
		expect(message).toMatch(/input\.clients\[0\].*CLERK_CLIENT_SIGN_IN_URL.*5000 bytes/);
		expect(message).not.toContain('aaaaaaaaaa');
	});
	it('refuses the old 5120-byte reading for every optional Clerk URL variable', () => {
		for (const [key, host] of [['signInUrl', 'client-a.clerk.test'], ['staffSignInUrl', 'staff.clerk.test'], ['apiUrl', 'api.clerk.test']] as const) {
			const i = exampleWithBrowserAllocation();
			(i.clients[0]!.clerk as Record<string, unknown>)[key] = `https://${host}/${'a'.repeat(5200)}`;
			try { planNativeRuntimeConfig(i); } catch (error) {
				// Either this module's cap or the Clerk reader's own refusal is fine for apiUrl (an origin only); the module's message is required for the path URLs.
				expect(nativeRuntimeConfigDiagnostic(error)).toBeDefined();
				if (key !== 'apiUrl') expect(nativeRuntimeConfigDiagnostic(error)).toMatch(/bytes/);
				continue;
			}
			throw new Error(`${key} accepted`);
		}
	});
	it('holds every emitted variable of every planned client to the cap', () => {
		for (const input of [exampleInput(), exampleWithBrowserAllocation(), withSignIn(CAP)])
			for (const file of planNativeRuntimeConfig(input).clients)
				for (const [name, value] of Object.entries(file.vars)) expect([name, Buffer.byteLength(value) <= CAP]).toEqual([name, true]);
	});
});

describe('the cap is enforced before any IO', () => {
	let root: string;
	beforeAll(() => { root = realpathSync(mkdtempSync(path.join(tmpdir(), 'native-runtime-config-size-'))); });
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	it('prepare creates nothing for an oversized optional URL', () => {
		const out = path.join(root, 'stage');
		let message: string | undefined;
		try { prepareNativeRuntimeConfig({ input: withSignIn(CAP + 1), out }); } catch (error) { message = nativeRuntimeConfigDiagnostic(error); }
		expect(message).toMatch(/CLERK_CLIENT_SIGN_IN_URL/);
		expect(lstatSync(out, { throwIfNoEntry: false })).toBeUndefined();
	});
	it('the CLI exits 1 with a fixed message and no stage for an oversized optional URL', () => {
		const input = path.join(root, 'input.json'), out = path.join(root, 'cli-stage');
		writeFileSync(input, JSON.stringify(withSignIn(CAP + 1)));
		const cli = path.join(import.meta.dirname, '../../../scripts/hosted-native-runtime-config.ts');
		const run = spawnSync(process.execPath, [cli, 'prepare', input, out], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
		expect(run.status).toBe(1);
		expect(run.stderr).toMatch(/CLERK_CLIENT_SIGN_IN_URL.*5000 bytes/);
		expect(run.stdout + run.stderr).not.toContain('aaaaaaaaaa');
		expect(lstatSync(out, { throwIfNoEntry: false })).toBeUndefined();
	});
});
