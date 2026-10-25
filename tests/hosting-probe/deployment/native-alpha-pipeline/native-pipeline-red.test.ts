// RED first for the checked pipeline's explicit native profile (target -> stage -> prebuilt). Written against the
// accepted-D GRS-107 checker before the profile exists, through the CLI only, so each failure is an assertion about
// behaviour, not a missing module. Synthetic fixtures; unit only: no provider, account, deploy or funding evidence.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

const ROOT = path.join(import.meta.dirname, '../../../..');
const TARGET = path.join(ROOT, 'deploy/probes/target.ts');
const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const CLIENTS = path.join(FIXTURES, 'clients');
const ARTIFACT = path.join(FIXTURES, 'artifact');
const DIGEST = 'sha256:527f3699b9bf4c6412afe8949034696b8ea3d3bb00a866360e7369eeec95f4eb';
const SCRATCH = path.join(ROOT, '.local/hosting-probe/deployment', `native-red-${process.pid}`);
mkdirSync(SCRATCH, { recursive: true });
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
const cli = (...args: string[]) => spawnSync(process.execPath, [TARGET, ...args], { encoding: 'utf8', cwd: ROOT });
const wrangler = (client: string) => readFileSync(path.join(CLIENTS, client, 'wrangler.jsonc'), 'utf8');
const variant = (name: string, text: string) => {
	const file = path.join(SCRATCH, name);
	writeFileSync(file, text);
	return file;
};

describe('native profile: a supported native Wrangler config passes the checked pipeline', () => {
	for (const client of ['client-a', 'client-b'])
		test(`check ${client} --profile native passes its own native target`, () => {
			const r = cli('check', client, '--profile', 'native', '--clients', CLIENTS);
			expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ status: 0, stdout: `TARGET PASS check ${client} profile=native\n`, stderr: '' });
		});

	test('stage --profile native stages the checked config, artifact and migrations with a native stage record, then prebuilt verifies it', () => {
		const out = path.join(SCRATCH, 'stage-a');
		const s = cli('stage', 'client-a', '--profile', 'native', '--clients', CLIENTS, '--artifact', ARTIFACT, '--digest', DIGEST, '--out', out);
		expect({ status: s.status, stderr: s.stderr }).toEqual({ status: 0, stderr: '' });
		const record = JSON.parse(readFileSync(path.join(out, 'stage.json'), 'utf8'));
		expect(record).toMatchObject({ schema: 'clearcase.deploy-stage.native/1', profile: 'native', adapter: 'wrangler', client: 'client-a', artifact: DIGEST, state: 'STAGED-UNVERIFIED', fundedAdmission: false, deployed: false });
		// Fix r1 (M2): prebuilt now needs the external reviewed pins, computed from the reviewed fixtures and never from the stage.
		const sha = (f: string) => `sha256:${createHash('sha256').update(readFileSync(f)).digest('hex')}`;
		const pins = ['--pin-target', sha(path.join(CLIENTS, 'client-a/target.json')), '--pin-config', sha(path.join(CLIENTS, 'client-a/wrangler.jsonc')), '--pin-artifact', DIGEST, '--pin-migrations', JSON.parse(readFileSync(path.join(CLIENTS, 'client-a/target.json'), 'utf8')).runtime.migrationsSha256, '--pin-entry', sha(path.join(ARTIFACT, 'cloudflare/_worker.js')), '--pin-source', JSON.parse(readFileSync(path.join(CLIENTS, 'client-a/target.json'), 'utf8')).runtime.sourceSha];
		const p = cli('prebuilt', 'client-a', '--profile', 'native', '--clients', CLIENTS, '--stage', out, ...pins);
		expect({ status: p.status, stdout: p.stdout, stderr: p.stderr }).toEqual({ status: 0, stdout: 'TARGET PASS prebuilt client-a profile=native\n', stderr: '' });
	});
});

describe('native profile: refusals name the native reason', () => {
	const refused = (args: string[], reason: string) => {
		const r = cli(...args);
		expect(r.status, r.stderr).toBe(1);
		expect(r.stderr).toContain(reason);
	};
	test("client B's custom-domain hostname in client A's native config is refused, naming client B", () =>
		refused(['check', 'client-a', '--profile', 'native', '--clients', CLIENTS, '--config', variant('swap-host.jsonc', wrangler('client-a').replace('"pattern": "a.sandbox.gridshift.co.za"', '"pattern": "b.sandbox.gridshift.co.za"'))], 'b.sandbox.gridshift.co.za belongs to client-b'));
	test('workers_dev true is refused', () =>
		refused(['check', 'client-a', '--profile', 'native', '--clients', CLIENTS, '--config', variant('dev.jsonc', wrangler('client-a').replace('"workers_dev": false', '"workers_dev": true'))], 'workers_dev is true, not false'));
	test('preview_urls true is refused', () =>
		refused(['check', 'client-a', '--profile', 'native', '--clients', CLIENTS, '--config', variant('prev.jsonc', wrangler('client-a').replace('"preview_urls": false', '"preview_urls": true'))], 'preview_urls is true, not false'));
	test('an R2 binding outside the EU jurisdiction is refused', () =>
		refused(['check', 'client-a', '--profile', 'native', '--clients', CLIENTS, '--config', variant('r2.jsonc', wrangler('client-a').replace('"jurisdiction": "eu"', '"jurisdiction": "fedramp"'))], 'r2 jurisdiction is "fedramp", not "eu"'));
	test('a cf config under the native profile is refused as a measured capability gap, not checked loosely', () =>
		refused(['check', 'client-a', '--profile', 'native', '--clients', CLIENTS, '--format', 'cf', '--config', variant('cf.ts', 'export default {};\n')], 'native profile capability gap'));
});

describe('legacy /1 behaviour is unchanged', () => {
	test('the legacy CLI still passes each reviewed legacy client', () => {
		for (const client of ['client-a', 'client-b']) expect(cli('check', client)).toMatchObject({ status: 0, stdout: `TARGET PASS check ${client}\n` });
	});
});
