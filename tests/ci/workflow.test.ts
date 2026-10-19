// What the CI workflow (.github/workflows/ci.yml) must keep true, read from the file: GitHub only runs it on a push, so
// a mistake here would show up as a red job after the fact.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const text = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const { Bun: bun } = globalThis as unknown as { Bun: { YAML: { parse(s: string): { jobs: Record<string, { steps: Record<string, unknown>[] }> } } } };
const doc = bun.YAML.parse(text);
const steps = doc.jobs.check!.steps;
const runs = steps.map((s) => (typeof s.run === 'string' ? s.run : '')).filter(Boolean);

describe('CI workflow receipts', () => {
	// actions/upload-artifact refuses these in a path, and a receipt's folder is named after its --name.
	const REFUSED = /["\\:<>|*?\r\n]/;
	const names = runs.flatMap((r) => [...r.matchAll(/--name\s+(\S+)/g)].map((m) => m[1]!));

	it('names the three receipts', () => {
		expect(names).toEqual(['check', 'test', 'gate-hosted']);
	});
	it.each(names)('receipt name %s has no character that artifact upload refuses', (n) => {
		expect(n).not.toMatch(REFUSED);
	});
	it('asks the summary for exactly the receipts the job writes', () => {
		const summary = runs.find((r) => r.includes('scripts/ci/summary.ts'))!;
		expect(summary.trim().split(/\s+/).slice(2).filter((w) => !w.startsWith('"'))).toEqual(names);
	});
});

// GRS-138: PC1 run 39260890102 downloaded Node 26.10.0 into the runner's tool cache and then failed with exit code 127 on
// its binary. The job uses Node 24 LTS (ADR 0008), keeps the action pinned, prints what it can learn about the guest when
// the Node step fails, falls back to nodejs.org's own tarball (checked against its published SHA-256), and the gate step
// proves the node it runs is a real Node. Nothing here may carry a Cloudflare credential.
describe('CI workflow Node for the hosted gate', () => {
	const NODE_VERSION = /^24\.\d+\.\d+$/;
	const setup = steps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/setup-node@'))!;
	const byName = (re: RegExp) => steps.find((s) => re.test(String(s.name ?? '')))!;
	const index = (s: unknown) => steps.indexOf(s as never);
	const diagnostics = byName(/node.*diagnos/i), fallback = byName(/node.*fallback/i), gate = byName(/^gate-hosted$/);
	const whenNodeFails = (s: Record<string, unknown>) => expect(String(s.if)).toMatch(new RegExp(`steps\\.${String(setup.id)}\\.outcome == 'failure'`));

	it('pins Node 24 LTS in the action, which stays pinned to a commit and may fail without ending the job', () => {
		expect(setup.uses).toBe('actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0'.split(' ')[0]);
		expect((setup.with as { 'node-version': string })['node-version']).toMatch(NODE_VERSION);
		expect(setup.id).toBeTruthy();
		expect(setup['continue-on-error']).toBe(true);
	});
	it('prints the guest facts of a Node that does not run, after the Node step and before the gate', () => {
		expect(diagnostics, 'a step named for Node diagnostics').toBeTruthy();
		whenNodeFails(diagnostics);
		expect(index(diagnostics)).toBeGreaterThan(index(setup));
		expect(index(diagnostics)).toBeLessThan(index(gate));
		for (const part of ['uname -a', '/etc/os-release', 'mount', '/home/runner', '/tmp', 'df ', 'file ', 'ldd ', 'ls -la', 'ldconfig -p', 'libstdc', 'libatomic', 'libgcc', 'RUNNER_TOOL_CACHE'])
			expect(String(diagnostics.run), part).toContain(part);
	});
	it('falls back to the official tarball of the same version, verified, tried and first on PATH', () => {
		expect(fallback, 'a step named for the Node fallback').toBeTruthy();
		whenNodeFails(fallback);
		expect(index(fallback)).toBeGreaterThan(index(diagnostics));
		expect(index(fallback)).toBeLessThan(index(gate));
		const run = String(fallback.run), version = (setup.with as { 'node-version': string })['node-version'];
		expect(run).toContain(`https://nodejs.org/dist/v${version}/`);
		expect(run).toContain(`node-v${version}-linux-x64.tar.gz`);
		expect(run).toContain('SHASUMS256.txt');
		expect(run).toMatch(/[0-9a-f]{64}/);
		expect(run).toContain('sha256sum');
		expect(run).toContain('RUNNER_TEMP');
		expect(run).toContain('ldd ');
		expect(run).toContain('--version');
		expect(run).toContain('GITHUB_PATH');
	});
	it('proves in the gate step that node is a real Node and names it, inside the receipted command', () => {
		const run = String(gate.run);
		expect(run).toContain('process.versions.bun');
		expect(run).toContain('process.execPath');
		expect(run.indexOf('"$proof"'), 'the proof is an argument of the receipted command').toBeGreaterThan(run.indexOf('--name gate-hosted'));
		expect(run.indexOf('node -e "$1" && exec bun run --bun gate:hosted'), 'the proof runs before the gate, in the same command').toBeGreaterThan(run.indexOf('--name gate-hosted'));
		expect(run).toContain('--tool node');
	});
	it('carries no Cloudflare credential, secret or account', () => {
		expect(text).not.toMatch(/\$\{\{\s*secrets\./);
		for (const s of steps) for (const k of Object.keys((s.env as Record<string, unknown>) ?? {})) expect(k, `env ${k} of ${String(s.name ?? s.uses)}`).not.toMatch(/CLOUDFLARE|TOKEN|SECRET|ACCOUNT|API_KEY/i);
	});
});

describe('CI gate-hosted step state directory', () => {
	// The step's own setup and EXIT trap, run as GitHub runs a step (bash -e) in a scratch checkout. PC1 run 39298591537
	// printed GATE PASS and still failed: the test step (hosted-cleanup-ownership.test.ts) leaves a real .local/hosted,
	// `ln -sfn` then links inside that directory, and the trap's `rm -f` cannot remove a directory.
	const gate = steps.find((s) => s.name === 'gate-hosted')!;
	const setup = String(gate.run).split('proof=')[0]!;
	const runSetup = (before: (checkout: string) => void) => {
		const checkout = mkdtempSync(path.join(tmpdir(), 'ci-gate-hosted-'));
		try {
			before(checkout);
			const probe = `${setup}\n[ -L .local/hosted ] || { echo "not a link: $(ls -ld .local/hosted)"; exit 7; }\nreadlink .local/hosted > link.txt\n`;
			const r = spawnSync('bash', ['-e', '-c', probe], { cwd: checkout, encoding: 'utf8' });
			const link = existsSync(path.join(checkout, 'link.txt')) ? readFileSync(path.join(checkout, 'link.txt'), 'utf8').trim() : '';
			return { ...r, link, left: readdirSync(path.join(checkout, '.local')) };
		} finally {
			rmSync(checkout, { recursive: true, force: true });
		}
	};
	it('links .local/hosted to its tmpfs directory and leaves nothing behind on a fresh checkout', () => {
		const r = runSetup((c) => mkdirSync(path.join(c, '.local'), { recursive: true }));
		expect(r.status, r.stderr).toBe(0);
		expect(r.link).toMatch(/^\/dev\/shm\/clearcase-ci-hosted\./);
		expect(r.left).toEqual([]);
		expect(existsSync(r.link), 'the step\'s tmp directory is removed').toBe(false);
	});
	it('replaces a real .local/hosted an earlier step left, and exits 0 after the trap', () => {
		const r = runSetup((c) => {
			mkdirSync(path.join(c, '.local', 'hosted'), { recursive: true });
			writeFileSync(path.join(c, '.local', 'hosted', 'start-44000.pid.lock'), '');
		});
		expect(r.status, r.stderr).toBe(0);
		expect(r.stderr).not.toMatch(/Is a directory/);
		expect(r.link).toMatch(/^\/dev\/shm\/clearcase-ci-hosted\./);
		expect(r.left, 'the trap removed the entry whichever it was').toEqual([]);
	});
});

describe('hosted run limits', () => {
	it('stops the offline namespace before the job\'s own limit, so a hang still leaves a gate-hosted receipt', () => {
		const limit = Number(/VERIFY_CLEARCASE_HOSTED_TIMEOUT_MS \?\? ([\d_]+)/.exec(readFileSync(new URL('../../.agents/skills/verify-clearcase-hosted/lib/main.mjs', import.meta.url), 'utf8'))![1]!.replaceAll('_', ''));
		const job = Number(/timeout-minutes: (\d+)/.exec(text)![1]) * 60_000;
		expect(limit).toBeLessThanOrEqual(25 * 60_000);
		expect(limit).toBeLessThan(job);
	});
});
