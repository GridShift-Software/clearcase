import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The ticket requires `bun test tests/ci`; the same cases must also appear in the job's Vitest report.
const testRunner = process.env.VITEST ? 'vitest' : 'bun:test';
const { afterEach, test }: Pick<typeof import('vitest'), 'afterEach' | 'test'> = await import(testRunner);
const app = fileURLToPath(new URL('../..', import.meta.url));
const fake = path.join(app, 'tests/ci/fake-guest.sh');
const scratch: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    const uploads = path.join(dir, 'guest/uploads');
    if (existsSync(uploads)) for (const upload of readFileSync(uploads, 'utf8').trim().split('\n')) {
      if (/^\/tmp\/clearcase-ci-verify\.[A-Za-z0-9]+$/.test(upload)) rmSync(upload, { recursive: true, force: true });
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(scenario = 'pass') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clearcase-ci-harness-'));
  scratch.push(dir);
  const source = path.join(dir, 'source');
  const guest = path.join(dir, 'guest');
  const bin = path.join(guest, 'bin');
  for (const subdir of [bin, path.join(guest, 'home/runner'), path.join(source, 'scripts/ci'), path.join(source, 'tests')]) mkdirSync(subdir, { recursive: true });
  for (const tool of ['sudo', 'systemctl', 'pgrep', 'install', 'bun', 'fake-ci-chrome', 'ssh', 'gh']) symlinkSync(fake, path.join(bin, tool));
  writeFileSync(path.join(guest, 'real-bun'), execFileSync('bash', ['-c', 'command -v bun'], { encoding: 'utf8' }).trim());
  writeFileSync(path.join(guest, 'scenario'), scenario);
  writeFileSync(path.join(guest, 'service-state'), 'active\n');
  const diag = path.join(guest, 'home/runner/actions-runner/_diag');
  mkdirSync(diag, { recursive: true });
  writeFileSync(path.join(diag, 'Worker_fixture.log'), 'previous job\n');
  writeFileSync(path.join(guest, 'events'), '');
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
  const env = { ...process.env, CLEARCASE_CI_SSH: fake, FAKE_GUEST_ROOT: guest, GH_HOST: 'github.invalid', HOME: path.join(guest, 'home/runner'), PATH: `${bin}:${process.env.PATH}`, CLEARCASE_CI_QUIET_SECONDS: '0.04', CLEARCASE_CI_IDLE_OBSERVATIONS: '3', CLEARCASE_CI_DRAIN_TIMEOUT: '1' };
  const run = (...args: string[]) => {
    const result = spawnSync(path.join(source, 'scripts/ci/pc1-vm'), args, { cwd: source, env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return result;
  };
  const events = () => readFileSync(path.join(guest, 'events'), 'utf8').trim().split('\n').filter(Boolean);
  const store = path.join(guest, 'home/runner/ci-results');
  const results = () => readdirSync(store).filter((name) => name.startsWith(`${sha}-`)).map((name) => path.join(store, name));
  return { source, guest, sha, env, run, events, store, results };
}

function provisionFixture(scenario = 'pass') {
  const f = fixture(scenario);
  const runner = path.join(f.guest, 'home/runner/actions-runner');
  mkdirSync(path.join(runner, 'bin'));
  mkdirSync(path.join(f.guest, 'etc/sysctl.d'), { recursive: true });
  for (const tool of ['apt-get', 'sysctl', 'chown', 'id', 'runuser', 'curl', 'sha256sum', 'tar', 'fake-ci-deps']) symlinkSync(fake, path.join(f.guest, 'bin', tool));
  writeFileSync(path.join(runner, '.service'), 'actions.runner.GridShift-Software-clearcase.clearcase-pc1-vm\n');
  writeFileSync(path.join(runner, '.clearcase-version'), '98.0.0\n');
  writeFileSync(path.join(f.guest, 'os-release'), 'PRETTY_NAME="Synthetic guest"\n');
  writeFileSync(path.join(runner, 'svc.sh'), '#!/bin/bash\nexec systemctl "$1" actions.runner.GridShift-Software-clearcase.clearcase-pc1-vm\n');
  writeFileSync(path.join(runner, 'bin/installdependencies.sh'), '#!/bin/bash\nfake-ci-deps\n');
  for (const script of ['svc.sh', 'bin/installdependencies.sh']) chmodSync(path.join(runner, script), 0o755);
  const provision = () => spawnSync(fake, ['provision', path.join(f.source, 'scripts/ci/guest-provision.sh')], { cwd: f.source, env: f.env, encoding: 'utf8', timeout: 10_000 });
  return { ...f, provision };
}

for (const state of ['inactive', 'failed']) {
  for (const [scenario, status] of [['pass', 0], ['tar-fail', 1], ['provision-term', 143]] satisfies [string, number][]) {
    test(`provision preserves ${state} at entry after ${scenario}`, () => {
      const f = provisionFixture(scenario);
      writeFileSync(path.join(f.guest, 'service-state'), `${state}\n`);
      const result = f.provision();
      assert.equal(result.status, status, result.stderr + result.stdout);
      assert.equal(result.signal, null);
      assert.equal(readFileSync(path.join(f.guest, 'service-state'), 'utf8'), `${state}\n`);
      assert.equal(f.events().some((event) => ['stop', 'start', 'lock-missing'].includes(event)), false);
    });
  }
}

for (const [scenario, status] of [['pass', 0], ['tar-fail', 1], ['provision-term', 143]] satisfies [string, number][]) {
  test(`provision restores active at entry after ${scenario} under the lock`, () => {
    const f = provisionFixture(scenario);
    const result = f.provision();
    assert.equal(result.status, status, result.stderr + result.stdout);
    assert.equal(result.signal, null);
    assert.equal(readFileSync(path.join(f.guest, 'service-state'), 'utf8'), 'active\n');
    assert.equal(f.events().filter((event) => event === 'stop').length, 1);
    assert.equal(f.events().at(-1), 'start');
    assert.equal(f.events().includes('lock-missing'), false);
  });
}

test('provision refuses unreadable entry state before any mutation', () => {
  const f = provisionFixture('state-unreadable');
  const result = f.provision();
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr, /could not read.*service state/);
  assert.deepEqual(f.events(), []);
  assert.equal(readFileSync(path.join(f.guest, 'service-state'), 'utf8'), 'active\n');
});

test('provision refuses transitional entry state before any mutation', () => {
  const f = provisionFixture();
  writeFileSync(path.join(f.guest, 'service-state'), 'activating\n');
  const result = f.provision();
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr, /could not read a stable runner service state/);
  assert.deepEqual(f.events(), []);
  assert.equal(readFileSync(path.join(f.guest, 'service-state'), 'utf8'), 'activating\n');
});

test('provision refuses a held verification lock before any mutation', () => {
  const f = provisionFixture();
  const result = spawnSync('flock', [path.join(f.guest, 'verify.lock'), fake, 'provision', path.join(f.source, 'scripts/ci/guest-provision.sh')], { cwd: f.source, env: f.env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr, /another verification or provision is running/);
  assert.deepEqual(f.events(), []);
  assert.equal(readFileSync(path.join(f.guest, 'service-state'), 'utf8'), 'active\n');
});

for (const scenario of ['job-after-observation', 'transient-after-observation', 'transient-during-stop']) {
  test(`verify refuses ${scenario}, preserves state and runs no checks`, () => {
    const f = fixture(scenario);
    const result = f.run('verify', 'HEAD');
    assert.equal(result.status, 3, result.stderr + result.stdout);
    assert.match(result.stderr, /job activity changed during admission/);
    assert.equal(readFileSync(path.join(f.guest, 'service-state'), 'utf8'), 'active\n');
    assert.equal(f.events().some((event) => ['chrome', 'install', 'check', 'test', 'summary'].includes(event)), false);
    if (scenario.endsWith('after-observation')) assert.deepEqual(f.events(), ['pgrep']);
    else assert.equal(f.events().at(-1), 'start');
  });
}

test('verify requires consecutive quiet observations before stopping a quiet runner', () => {
  const f = fixture();
  const result = f.run('verify', 'HEAD');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const events = f.events();
  assert.deepEqual(events.slice(0, events.indexOf('stop')), ['pgrep', 'pgrep', 'pgrep']);
  assert.equal(readFileSync(path.join(f.guest, 'service-state'), 'utf8'), 'active\n');
});

test('verify honors the configured idle observation count before stopping', () => {
  const f = fixture();
  f.env.CLEARCASE_CI_IDLE_OBSERVATIONS = '5';
  const result = f.run('verify', 'HEAD');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const events = f.events();
  assert.deepEqual(events.slice(0, events.indexOf('stop')), Array.from({ length: 5 }, () => 'pgrep'));
});

for (const scenario of ['worker-after-observation', 'drain-timeout']) {
  test(`verify refuses ${scenario} before stopping or running checks`, () => {
    const f = fixture(scenario);
    if (scenario === 'drain-timeout') f.env.CLEARCASE_CI_DRAIN_TIMEOUT = '0.1';
    const result = f.run('verify', 'HEAD');
    assert.equal(result.status, 3, result.stderr + result.stdout);
    assert.match(result.stderr, scenario === 'drain-timeout' ? /drain timeout/ : /worker present during drain/);
    assert.deepEqual(f.events(), ['pgrep', 'pgrep']);
    assert.equal(readFileSync(path.join(f.guest, 'service-state'), 'utf8'), 'active\n');
  });
}

test('verify bundles the exact SHA, runs the job through real receipts and summary, and answers without GitHub', () => {
  const f = fixture();
  const refsBefore = git(f.source, 'show-ref');
  const result = f.run('verify', 'HEAD');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, new RegExp(`^PASS ${f.sha}$`, 'm'));
  assert.deepEqual(f.events(), ['pgrep', 'pgrep', 'pgrep', 'stop', 'pgrep', 'chrome', 'install', 'check', 'test', 'summary', 'start']);
  assert.equal(git(f.source, 'show-ref'), refsBefore);
  const [stored] = f.results();
  assert.ok(stored);
  assert.match(path.basename(stored), new RegExp(`^${f.sha}-verify-[A-Za-z0-9]+$`));
  assert.equal(readFileSync(path.join(stored, 'verdict.txt'), 'utf8'), `PASS ${f.sha}\n`);
  for (const name of ['check', 'test']) {
    const receiptDir = readdirSync(stored).find((entry) => entry.endsWith(`-${name}`));
    assert.ok(receiptDir);
    const receipt = readFileSync(path.join(stored, receiptDir, 'receipt.json'), 'utf8');
    assert.match(receipt, /"result": "PASS"/);
    assert.match(receipt, new RegExp(`"head": "${f.sha}"`));
    assert.match(receipt, /"dirty": false/);
  }
  assert.match(readFileSync(path.join(stored, 'summary.json'), 'utf8'), /"verdict": "PASS"/);
  const verdict = f.run('verdict', f.sha);
  assert.equal(verdict.status, 0, verdict.stderr);
  assert.equal(verdict.stdout, `PASS ${f.sha}\nreceipts ${stored}\n`);
  // The upload and checkout are removed; the results remain outside them.
  for (const upload of readFileSync(path.join(f.guest, 'uploads'), 'utf8').trim().split('\n')) assert.equal(existsSync(upload), false);
});

for (const scenario of ['check-fail', 'test-fail', 'chrome-fail', 'install-fail', 'stop-fail', 'start-fail', 'busy-after-stop']) {
  test(`verify stores FAIL and attempts start after stop when ${scenario}`, () => {
    const f = fixture(scenario);
    const result = f.run('verify', 'HEAD');
    assert.equal(result.status, scenario === 'busy-after-stop' ? 3 : 1, result.stderr + result.stdout);
    assert.match(result.stdout, new RegExp(`^FAIL ${f.sha}$`, 'm'));
    const events = f.events();
    assert.equal(events.filter((event) => event === 'stop').length, 1);
    assert.equal(events.at(-1), 'start');
    assert.ok(events.indexOf('start') > events.indexOf('stop'));
    assert.equal(events.some((event) => event.startsWith('forbidden')), false);
    const [stored] = f.results();
    assert.ok(stored);
    assert.equal(readFileSync(path.join(stored, 'verdict.txt'), 'utf8'), `FAIL ${f.sha}\n`);
    if (scenario === 'check-fail' || scenario === 'test-fail') assert.match(readFileSync(path.join(stored, 'summary.json'), 'utf8'), /"verdict": "FAIL"/);
    const verdict = f.run('verdict', f.sha);
    assert.equal(verdict.status, 1, verdict.stderr);
    assert.equal(verdict.stdout, `FAIL ${f.sha}\nreceipts ${stored}\n`);
  });
}

for (const scenario of ['busy', 'pgrep-error']) {
  test(`verify refuses ${scenario} without stopping the service or running checks`, () => {
    const f = fixture(scenario);
    const result = f.run('verify', 'HEAD');
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(result.stderr, scenario === 'busy' ? /running a job/ : /could not inspect/);
    assert.deepEqual(f.events(), ['pgrep']);
    assert.equal(existsSync(f.store), false);
  });
}

test('verdict returns UNKNOWN and exit 2 for a miss without needing a local commit or changing runner state', () => {
  const f = fixture();
  const sha = 'a'.repeat(40);
  const result = f.run('verdict', sha);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, `UNKNOWN ${sha}\n`);
  assert.deepEqual(f.events(), []);
});

test('verdict reads GitHub run keys and ignores an unfinished or mismatched result', () => {
  const f = fixture();
  const completed = path.join(f.store, `${f.sha}-123-1`);
  const unfinished = path.join(f.store, `${f.sha}-verify-pending`);
  const wrong = path.join(f.store, `${f.sha}-124-1`);
  for (const entry of [completed, unfinished, wrong]) mkdirSync(entry, { recursive: true });
  writeFileSync(path.join(completed, 'verdict.txt'), `PASS ${f.sha}\n`);
  writeFileSync(path.join(wrong, 'verdict.txt'), `PASS ${'b'.repeat(40)}\n`);
  const result = f.run('verdict', f.sha);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `PASS ${f.sha}\nreceipts ${completed}\n`);
  assert.deepEqual(f.events(), []);
});

test('verdict selects the latest completed attempt for the same SHA, including FAIL after PASS', () => {
  const f = fixture();
  assert.equal(f.run('verify', 'HEAD').status, 0);
  writeFileSync(path.join(f.guest, 'scenario'), 'test-fail');
  assert.equal(f.run('verify', 'HEAD').status, 1);
  assert.equal(f.results().length, 2);
  const verdict = f.run('verdict', f.sha);
  assert.equal(verdict.status, 1, verdict.stderr);
  assert.match(verdict.stdout, new RegExp(`^FAIL ${f.sha}$`, 'm'));
});

test('verdict returns UNKNOWN when the store contains only incomplete entries', () => {
  const f = fixture();
  mkdirSync(path.join(f.store, `${f.sha}-verify-incomplete`), { recursive: true });
  const verdict = f.run('verdict', f.sha);
  assert.equal(verdict.status, 2, verdict.stderr);
  assert.equal(verdict.stdout, `UNKNOWN ${f.sha}\n`);
});

test('invalid arguments and missing cached origin/dev fail before contacting the guest', () => {
  const f = fixture();
  for (const args of [['verify'], ['verdict'], ['verdict', '../../bad'], ['verify', 'HEAD', 'extra']]) assert.equal(f.run(...args).status, 2);
  git(f.source, 'update-ref', '-d', 'refs/remotes/origin/dev');
  assert.notEqual(f.run('verify', 'HEAD').status, 0);
  assert.deepEqual(f.events(), []);
  assert.equal(existsSync(path.join(f.guest, 'uploads')), false);
});

test('the workflow store step copies receipts and records merge and PR head SHAs separately', () => {
  const f = fixture();
  const workflow = readFileSync(path.join(app, '.github/workflows/ci.yml'), 'utf8');
  const step = workflow.split('      - name: store verdict\n')[1]?.split('      - if: always()\n')[0];
  assert.ok(step);
  const block = step.split('        run: |\n')[1];
  assert.ok(block);
  const script = block.split('\n').map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  const receipts = path.join(f.guest, 'temp/receipts');
  mkdirSync(path.join(receipts, 'receipt-check'), { recursive: true });
  writeFileSync(path.join(receipts, 'receipt-check/receipt.json'), '{"result":"PASS"}\n');
  writeFileSync(path.join(receipts, 'receipt-check/stdout.txt'), 'synthetic private output\n');
  writeFileSync(path.join(receipts, 'receipt-check/stderr.txt'), 'synthetic private error\n');
  writeFileSync(path.join(receipts, 'summary.md'), '# Synthetic summary\n');
  writeFileSync(path.join(receipts, 'summary.json'), JSON.stringify({ head: f.sha, verdict: 'PASS' }));
  const prHead = 'b'.repeat(40);
  for (const [attempt, status, expected] of [['1', 'success', 'PASS'], ['2', 'failure', 'FAIL'], ['3', 'cancelled', 'FAIL']]) {
    const result = spawnSync('bash', ['-c', script], { cwd: f.source, env: { ...f.env, GITHUB_SHA: f.sha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: attempt, PR_HEAD_SHA: prHead, JOB_STATUS: status, RUNNER_TEMP: path.dirname(receipts) }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const target = path.join(f.store, `${f.sha}-123-${attempt}`);
    assert.equal(readFileSync(path.join(target, 'verdict.txt'), 'utf8'), `${expected} ${f.sha}\n`);
    assert.equal(readFileSync(path.join(target, 'receipt-check/receipt.json'), 'utf8'), '{"result":"PASS"}\n');
    assert.equal(readFileSync(path.join(target, 'summary.md'), 'utf8'), '# Synthetic summary\n');
    assert.equal(existsSync(path.join(target, 'receipt-check/stdout.txt')), false);
    assert.equal(existsSync(path.join(target, 'receipt-check/stderr.txt')), false);
    const metadata = readFileSync(path.join(target, 'run-metadata.json'), 'utf8');
    assert.match(metadata, new RegExp(`"GITHUB_SHA": "${f.sha}"`));
    assert.match(metadata, new RegExp(`"PR_HEAD_SHA": "${prHead}"`));
  }
  for (const [attempt, summary] of [['4', '{}'], ['5', '[]'], ['6', JSON.stringify({ head: prHead, verdict: 'PASS' })], ['7', 'invalid JSON']]) {
    writeFileSync(path.join(receipts, 'summary.json'), summary);
    const result = spawnSync('bash', ['-c', script], { cwd: f.source, env: { ...f.env, GITHUB_SHA: f.sha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: attempt, PR_HEAD_SHA: prHead, JOB_STATUS: 'success', RUNNER_TEMP: path.dirname(receipts) }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(readFileSync(path.join(f.store, `${f.sha}-123-${attempt}`, 'verdict.txt'), 'utf8'), `FAIL ${f.sha}\n`);
  }
});

for (const state of ['inactive', 'failed']) {
  for (const [scenario, status] of [['pass', 0], ['check-fail', 1], ['guest-term', 143]] satisfies [string, number][]) {
    test(`verify preserves ${state} at entry after ${scenario}`, () => {
      const f = fixture(scenario);
      writeFileSync(path.join(f.guest, 'service-state'), `${state}\n`);
      const result = f.run('verify', 'HEAD');
      assert.equal(result.status, status, result.stderr + result.stdout);
      assert.equal(readFileSync(path.join(f.guest, 'service-state'), 'utf8'), `${state}\n`);
      assert.equal(f.events().includes('start'), false);
      assert.equal(f.events().includes('stop'), false);
      assert.match(result.stdout, new RegExp(`^${status === 0 ? 'PASS' : 'FAIL'} ${f.sha}$`, 'm'));
    });
  }
}

test('verify fails closed when the entry service state cannot be read', () => {
  const f = fixture('state-unreadable');
  const result = f.run('verify', 'HEAD');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not read.*service state/);
  assert.deepEqual(f.events(), []);
  assert.equal(readFileSync(path.join(f.guest, 'service-state'), 'utf8'), 'active\n');
});

test('verify restores an active service after SIGTERM to the guest shell', () => {
  const f = fixture('guest-term');
  const result = f.run('verify', 'HEAD');
  assert.equal(result.status, 143, result.stderr + result.stdout);
  assert.equal(readFileSync(path.join(f.guest, 'service-state'), 'utf8'), 'active\n');
  assert.equal(f.events().at(-1), 'start');
  assert.match(result.stdout, new RegExp(`^FAIL ${f.sha}$`, 'm'));
});

test('verify refuses a held admission lock before inspecting jobs or mutating service state', () => {
  const f = fixture();
  const result = spawnSync('flock', [path.join(f.guest, 'verify.lock'), path.join(f.source, 'scripts/ci/pc1-vm'), 'verify', 'HEAD'], { cwd: f.source, env: f.env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr, /another verification is running/);
  assert.deepEqual(f.events(), []);
  assert.equal(readFileSync(path.join(f.guest, 'service-state'), 'utf8'), 'active\n');
});

test('verify refuses unreadable diagnostic history before stopping the service', () => {
  const f = fixture();
  rmSync(path.join(f.guest, 'home/runner/actions-runner/_diag'), { recursive: true });
  const result = f.run('verify', 'HEAD');
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr, /could not inspect job activity before stop/);
  assert.deepEqual(f.events(), []);
});

test('verify refuses a job arriving between idle observation and stop and restores the service', () => {
  const f = fixture('job-during-stop');
  const result = f.run('verify', 'HEAD');
  assert.equal(result.status, 3, result.stderr + result.stdout);
  assert.match(result.stderr, /job activity changed during admission/);
  assert.equal(readFileSync(path.join(f.guest, 'service-state'), 'utf8'), 'active\n');
  assert.deepEqual(f.events(), ['pgrep', 'pgrep', 'pgrep', 'stop', 'pgrep', 'start']);
  const verdict = f.run('verdict', f.sha);
  assert.equal(verdict.status, 1);
});

for (const link of ['entry', 'verdict', 'root']) {
  test(`verdict rejects a symlinked ${link} without accepting an external PASS`, () => {
    const f = fixture();
    const outside = path.join(f.guest, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'verdict.txt'), `PASS ${f.sha}\n`);
    const entry = path.join(f.store, `${f.sha}-123-1`);
    if (link === 'root') {
      mkdirSync(path.join(outside, `${f.sha}-123-1`));
      writeFileSync(path.join(outside, `${f.sha}-123-1/verdict.txt`), `PASS ${f.sha}\n`);
      symlinkSync(outside, f.store);
    } else {
      mkdirSync(f.store, { recursive: true });
      if (link === 'entry') symlinkSync(outside, entry);
      else {
        mkdirSync(entry);
        symlinkSync(path.join(outside, 'verdict.txt'), path.join(entry, 'verdict.txt'));
      }
    }
    const result = f.run('verdict', f.sha);
    assert.equal(result.status, 2, result.stderr + result.stdout);
    assert.equal(result.stdout, `UNKNOWN ${f.sha}\n`);
    assert.match(result.stderr, /unsafe.*store|symlink|outside/);
    assert.deepEqual(f.events(), []);
  });
}

for (const link of ['receipt', 'directory', 'summary', 'root', 'stdout', 'fifo']) {
  test(`workflow store rejects a symlinked ${link} and publishes no verdict`, () => {
    const f = fixture();
    const workflow = readFileSync(path.join(app, '.github/workflows/ci.yml'), 'utf8');
    const block = workflow.split('      - name: store verdict\n')[1]?.split('      - if: always()\n')[0]?.split('        run: |\n')[1];
    assert.ok(block);
    const script = block.split('\n').map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n');
    const outside = path.join(f.guest, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'receipt.json'), '{"synthetic":"private"}\n');
    const receipts = path.join(f.guest, 'temp/receipts');
    mkdirSync(path.dirname(receipts), { recursive: true });
    if (link === 'root') symlinkSync(outside, receipts);
    else {
      mkdirSync(receipts);
      writeFileSync(path.join(receipts, 'summary.json'), JSON.stringify({ head: f.sha, verdict: 'PASS' }));
      if (link === 'directory') symlinkSync(outside, path.join(receipts, 'receipt-check'));
      else if (link === 'summary') {
        rmSync(path.join(receipts, 'summary.json'));
        symlinkSync(path.join(outside, 'receipt.json'), path.join(receipts, 'summary.json'));
      } else {
        mkdirSync(path.join(receipts, 'receipt-check'));
        const incoming = path.join(receipts, 'receipt-check', link === 'stdout' ? 'stdout.txt' : 'receipt.json');
        if (link === 'fifo') execFileSync('mkfifo', [incoming]);
        else symlinkSync(path.join(outside, 'receipt.json'), incoming);
      }
    }
    const result = spawnSync('bash', ['-c', script], { cwd: f.source, env: { ...f.env, GITHUB_SHA: f.sha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', JOB_STATUS: 'success', RUNNER_TEMP: path.dirname(receipts) }, encoding: 'utf8', timeout: 10_000 });
    assert.notEqual(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stderr, /symlink|unsafe|outside/);
    assert.equal(existsSync(path.join(f.store, `${f.sha}-123-1`)), false);
    assert.deepEqual(readdirSync(f.store), []);
  });
}
