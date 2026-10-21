import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { scanPaths } from '../../../deploy/probes/scan.ts';

const SCRATCH = path.join(import.meta.dirname, '../../../.local/hosting-probe/deployment', `scan-${process.pid}`);
const CANARY = 'cc-canary-0f1e2d3c4b5a69788796a5b4';
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

function tree(files: Record<string, string>) {
	const root = path.join(SCRATCH, `t${Math.random().toString(16).slice(2)}`);
	for (const [f, body] of Object.entries(files)) (mkdirSync(path.dirname(path.join(root, f)), { recursive: true }), writeFileSync(path.join(root, f), body));
	return root;
}

describe('credential scan', () => {
	test('a clean tree passes, and a hit names the file and rule, never the text', () => {
		const root = tree({ 'clean/_worker.js': 'export default {};\n', 'logs/run.log': `CLOUDFLARE_API_TOKEN=${CANARY}\n` });
		expect(scanPaths({ roots: [path.join(root, 'clean')], canaries: [CANARY] })).toEqual({ hits: [], files: 1 });
		const r = scanPaths({ roots: [root], canaries: [CANARY], base: root });
		expect(r.hits).toEqual([{ file: 'logs/run.log', rule: 'canary-1' }, { file: 'logs/run.log', rule: 'token-variable' }]);
		expect(JSON.stringify(r)).not.toContain(CANARY);
	});

	test.each([
		['a token variable in JSON', '{"CLOUDFLARE_API_TOKEN": "abcdefghijklmnopqrstuvwxyz012345"}', 'token-variable'],
		['an account-owned token', 'token cfat_abcdefghijklmnopqrstuvwxyz0123456789', 'cloudflare-prefixed-token'],
		['a bearer header', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz.0123', 'auth-header'],
		['a Clerk secret key', 'sk_test_abcdefghijklmnopqrstuvwxyz01', 'clerk-secret-key'],
		['a private key', `-----BEGIN PRIVATE KEY-----\n${'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'.repeat(3)}\n`, 'private-key'],
		['Wrangler OAuth state', 'oauth_token = "abcdefghijklmnop"\n', 'oauth-state'],
	])('finds %s', (_what, body, rule) => expect(scanPaths({ roots: [tree({ 'f.txt': body })], canaries: [] }).hits.map((h) => h.rule)).toEqual([rule]));

	test('a canary inside a binary file is found', () => {
		const root = tree({ 'state.sqlite': `SQLite format 3\0\0\0${CANARY}\0` });
		expect(scanPaths({ roots: [root], canaries: [CANARY] }).hits.map((h) => h.rule)).toEqual(['canary-1']);
	});

	test('a library that only names the private-key header is not a hit', () => expect(scanPaths({ roots: [tree({ 'pem.js': 'const HEADER = "-----BEGIN PRIVATE KEY-----";\n' })], canaries: [] }).hits).toEqual([]));

	test('a short canary, which would match by chance, is refused', () => expect(() => scanPaths({ roots: [SCRATCH], canaries: ['short'] })).toThrow(/shorter than 12/));

	test('the CLI reads canaries from a file and exits 1 on a hit, 0 when clean, 2 on a missing path', () => {
		const root = tree({ 'out/summary.json': `{"note":"${CANARY}"}` });
		const canaries = path.join(SCRATCH, 'canaries.txt');
		writeFileSync(canaries, `${CANARY}\n`);
		const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(import.meta.dirname, '../../../deploy/probes/scan.ts'), ...args], { encoding: 'utf8' });
		const hit = cli('--canaries', canaries, root);
		expect(hit.status).toBe(1);
		expect(hit.stdout).not.toContain(CANARY);
		expect(hit.stdout.trim().split('\n').at(-1)).toBe('SCAN FAIL: 1 files, 1 canaries, 1 hits');
		expect(cli(tree({ 'a.txt': 'nothing\n' })).status).toBe(0);
		expect(cli(path.join(SCRATCH, 'absent')).status).toBe(2);
	});
});
