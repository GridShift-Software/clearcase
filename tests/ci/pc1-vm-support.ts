import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const app = fileURLToPath(new URL('../..', import.meta.url));
export const fake = path.join(app, 'tests/ci/fake-guest.sh');
export const scope = 'scope: check and test of this SHA in the CI VM only; not a GitHub check status, branch protection or approval by the external reviewer';
export const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function createHarness() {
  const scratch: string[] = [];
  const cleanup = () => {
    for (const dir of scratch.splice(0)) {
      const uploads = path.join(dir, 'guest/uploads');
      if (existsSync(uploads)) for (const upload of readFileSync(uploads, 'utf8').trim().split('\n')) {
        if (/^\/tmp\/clearcase-ci-verify\.[A-Za-z0-9]+$/.test(upload)) rmSync(upload, { recursive: true, force: true });
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };

function fixture(scenario = 'pass') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clearcase-ci-harness-'));
  scratch.push(dir);
  const source = path.join(dir, 'source');
  const guest = path.join(dir, 'guest');
  const bin = path.join(guest, 'bin');
  for (const subdir of [bin, path.join(guest, 'home/runner'), path.join(source, 'scripts/ci'), path.join(source, 'tests')]) mkdirSync(subdir, { recursive: true });
  for (const tool of ['sudo', 'systemctl', 'pgrep', 'install', 'bun', 'fake-ci-chrome', 'ssh', 'gh']) copyFileSync(fake, path.join(bin, tool));
  writeFileSync(path.join(guest, 'real-bun'), execFileSync('bash', ['-c', 'command -v bun'], { encoding: 'utf8' }).trim());
  writeFileSync(path.join(guest, 'scenario'), scenario);
  writeFileSync(path.join(guest, 'service-state'), 'active\n');
  const diag = path.join(guest, 'home/runner/actions-runner/_diag');
  mkdirSync(diag, { recursive: true });
  writeFileSync(path.join(diag, 'Worker_fixture.log'), 'previous job\n');
  writeFileSync(path.join(guest, 'events'), '');
  // GitHub's view of the runner: id, status, busy and whether it carries the clearcase-pc1 label.
  writeFileSync(path.join(guest, 'github'), '22 online false true\n');
  writeFileSync(path.join(guest, 'github-scenario'), 'ok');
  cpSync(path.join(app, 'scripts/agent-tools'), path.join(source, 'scripts/agent-tools'), { recursive: true });
  for (const script of ['pc1-vm', 'summary.ts', 'guest-provision.sh']) cpSync(path.join(app, 'scripts/ci', script), path.join(source, 'scripts/ci', script));
  writeFileSync(path.join(source, 'scripts/ci/install-chrome.sh'), '#!/bin/bash\nset -euo pipefail\nfake-ci-chrome\n');
  chmodSync(path.join(source, 'scripts/ci/install-chrome.sh'), 0o755);
  writeFileSync(path.join(source, 'package.json'), '{"packageManager":"bun@1.4.2"}\n');
  writeFileSync(path.join(source, 'tests/example.test.ts'), '// Synthetic file inventoried by the real CI summary.\n');
  git(source, 'init', '-q');
  git(source, 'config', 'user.name', 'CI fixture');
  git(source, 'config', 'user.email', 'ci-fixture@localhost');
  git(source, 'add', '-A');
  git(source, 'commit', '-qm', 'base');
  git(source, 'update-ref', 'refs/remotes/origin/dev', 'HEAD');
  writeFileSync(path.join(source, 'revision.txt'), 'fresh bundled revision\n');
  git(source, 'add', 'revision.txt');
  git(source, 'commit', '-qm', 'candidate');
  const sha = git(source, 'rev-parse', 'HEAD');
  // This must never enter the checkout or receipts: verify tests the committed bundle, not the working tree.
  writeFileSync(path.join(source, 'uncommitted.txt'), 'not in the bundle\n');
  const env = { ...process.env, CLEARCASE_CI_SSH: fake, FAKE_GUEST_ROOT: guest, GH_HOST: 'github.invalid', HOME: path.join(guest, 'home/runner'), PATH: `${bin}:${process.env.PATH}`, CLEARCASE_CI_QUIET_SECONDS: '0.04', CLEARCASE_CI_IDLE_OBSERVATIONS: '3', CLEARCASE_CI_DRAIN_TIMEOUT: '1', CLEARCASE_CI_PAUSE_SETTLE_SECONDS: '0', CLEARCASE_CI_RESUME_WAIT_SECONDS: '300', CLEARCASE_CI_STATE: '' };
  const run = (...args: string[]) => {
    const result = spawnSync(path.join(source, 'scripts/ci/pc1-vm'), args, { cwd: source, env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return result;
  };
  const events = () => readFileSync(path.join(guest, 'events'), 'utf8').trim().split('\n').filter(Boolean);
  const store = path.join(guest, 'home/runner/ci-results');
  const results = () => readdirSync(store).filter((name) => name.startsWith(`${sha}-`)).map((name) => path.join(store, name));
  // Each GitHub call with the number of guest events that preceded it.
  const github = () => existsSync(path.join(guest, 'github-calls')) ? readFileSync(path.join(guest, 'github-calls'), 'utf8').trim().split('\n').filter(Boolean).map((line) => {
    const [at, ...call] = line.split(' ');
    return { at: Number(at), call: call.join(' ') };
  }) : [];
  return { source, guest, sha, env, run, events, store, results, github };
}

function provisionFixture(scenario = 'pass') {
  const f = fixture(scenario);
  const runner = path.join(f.guest, 'home/runner/actions-runner');
  mkdirSync(path.join(runner, 'bin'));
  mkdirSync(path.join(f.guest, 'etc/sysctl.d'), { recursive: true });
  for (const tool of ['apt-get', 'sysctl', 'chown', 'id', 'runuser', 'curl', 'sha256sum', 'tar', 'fake-ci-deps']) copyFileSync(fake, path.join(f.guest, 'bin', tool));
  writeFileSync(path.join(runner, '.service'), 'actions.runner.GridShift-Software-clearcase.clearcase-pc1-vm\n');
  writeFileSync(path.join(runner, '.clearcase-version'), '98.0.0\n');
  writeFileSync(path.join(f.guest, 'os-release'), 'PRETTY_NAME="Synthetic guest"\n');
  writeFileSync(path.join(runner, 'svc.sh'), '#!/bin/bash\nexec systemctl "$1" actions.runner.GridShift-Software-clearcase.clearcase-pc1-vm\n');
  writeFileSync(path.join(runner, 'bin/installdependencies.sh'), '#!/bin/bash\nfake-ci-deps\n');
  for (const script of ['svc.sh', 'bin/installdependencies.sh']) chmodSync(path.join(runner, script), 0o755);
  const provision = () => spawnSync(fake, ['provision', path.join(f.source, 'scripts/ci/guest-provision.sh')], { cwd: f.source, env: f.env, encoding: 'utf8', timeout: 10_000 });
  return { ...f, provision };
}

const verdicts = (f: ReturnType<typeof fixture>) => (existsSync(f.store) ? f.results() : []).filter((entry) => existsSync(path.join(entry, 'verdict.txt')));

  return { fixture, provisionFixture, verdicts, cleanup };
}
