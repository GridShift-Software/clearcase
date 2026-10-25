// The CLI prepares and verifies only. It reads one explicit strict-JSON input file, never the environment, and prints a fixed message.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exampleInput } from './example-input.ts';

const cli = path.join(import.meta.dirname, '../../../scripts/hosted-native-runtime-config.ts');
const CANARY = 'canary-4d3c2b1a09';
let root: string, input: string, n = 0;
beforeAll(() => { root = realpathSync(mkdtempSync(path.join(tmpdir(), 'native-runtime-config-cli-'))); input = path.join(root, 'input.json'); writeFileSync(input, JSON.stringify(exampleInput())); });
afterAll(() => rmSync(root, { recursive: true, force: true }));
// A minimal environment: the CLI must not need, read or print any variable. The canary proves it is not echoed.
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', CLERK_CLIENT_SECRET_KEY: CANARY, CLOUDFLARE_API_TOKEN: CANARY } });
const stage = () => path.join(root, `stage-${++n}`);

describe('CLI', () => {
	it('prepares, then verifies, printing the manifest', () => {
		const out = stage();
		const prepared = run('prepare', input, out);
		expect(prepared.status).toBe(0);
		expect(JSON.parse(prepared.stdout)).toMatchObject({ schema: 'clearcase.native-runtime-config/1', providerProof: false, provisioned: false, deployed: false });
		const verified = run('verify', input, out);
		expect(verified.status).toBe(0);
		expect(verified.stdout).toBe(prepared.stdout);
		expect(prepared.stdout + prepared.stderr).not.toContain(CANARY);
	});
	it('refuses a changed stage, an existing stage and a changed input, exiting 1 with a fixed message', () => {
		const out = stage();
		run('prepare', input, out);
		writeFileSync(path.join(out, 'client-a.runtime.json'), 'tampered');
		expect(run('verify', input, out)).toMatchObject({ status: 1, stderr: expect.stringContaining('exactly the planned') });
		expect(run('prepare', input, out).status).toBe(1);
		const changed = path.join(root, 'changed.json'), data = exampleInput(); data.clients[0]!.policy.storageQuotas.maxUploadsPerCase = 51;
		writeFileSync(changed, JSON.stringify(data));
		const fresh = stage(); run('prepare', input, fresh);
		expect(run('verify', changed, fresh).status).toBe(1);
	});
	it('exits 2 for any usage other than prepare|verify <input> <stage>', () => {
		for (const args of [[], ['prepare'], ['prepare', input], ['prepare', input, stage(), 'extra'], ['apply', input, stage()], ['prepare', '--help', stage()], ['verify', input, '-x']])
			expect(run(...args).status).toBe(2);
	});
	it('refuses a relative stage or input, a symlinked input, duplicate JSON keys, non-JSON and secret-shaped input without echoing it', () => {
		expect(run('prepare', input, 'relative-stage').status).toBe(1);
		expect(run('prepare', 'input.json', stage()).status).toBe(1);
		const link = path.join(root, 'link.json'); symlinkSync(input, link);
		expect(run('prepare', link, stage()).status).toBe(1);
		const duplicate = path.join(root, 'duplicate.json');
		writeFileSync(duplicate, readFileSync(input, 'utf8').replace('{"manifest"', '{"browserAllocation":null,"manifest"'));
		expect(run('prepare', duplicate, stage())).toMatchObject({ status: 1, stderr: expect.stringContaining('not strict JSON') });
		const broken = path.join(root, 'broken.json'); writeFileSync(broken, '{');
		expect(run('prepare', broken, stage()).status).toBe(1);
		const secret = path.join(root, 'secret.json'), data: any = exampleInput();
		data.clients[0].clerk.secretKey = ['sk', 'test', CANARY.replaceAll('-', '')].join('_');
		writeFileSync(secret, JSON.stringify(data));
		const refused = run('prepare', secret, stage());
		expect(refused.status).toBe(1);
		expect(refused.stdout + refused.stderr).not.toContain(CANARY.replaceAll('-', ''));
	});
});
