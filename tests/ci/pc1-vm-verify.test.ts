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
// The line verify and verdict print under every PASS or FAIL.
const scope = 'scope: check and test of this SHA in the CI VM only; not a GitHub check status, branch protection or approval by the external reviewer';
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

function registerFixture(scenario = 'pass') {
  const f = provisionFixture(scenario);
  const runner = path.join(f.guest, 'home/runner/actions-runner');
  for (const tool of ['fake-ci-svc', 'fake-ci-config', 'mv']) symlinkSync(fake, path.join(f.guest, 'bin', tool));
  writeFileSync(path.join(runner, 'svc.sh'), '#!/bin/bash\nexec fake-ci-svc "$@"\n');
  writeFileSync(path.join(runner, 'config.sh'), '#!/bin/bash\nexec fake-ci-config "$@"\n');
  for (const script of ['svc.sh', 'config.sh']) chmodSync(path.join(runner, script), 0o755);
  writeFileSync(path.join(runner, '.runner'), 'previous registration\n');
  writeFileSync(path.join(runner, '.credentials'), 'previous credential\n');
  const script = path.join(f.source, 'scripts/ci/guest-provision.sh');
  const options = { cwd: f.source, env: f.env, encoding: 'utf8', input: 'synthetic-registration-token\n', timeout: 10_000 } as const;
  const register = () => spawnSync(fake, ['register', script], options);
  const registerLocked = () => spawnSync('flock', [path.join(f.guest, 'verify.lock'), fake, 'register', script], options);
  const registration = () => ['.runner', '.credentials'].map((file) => readFileSync(path.join(runner, file), 'utf8'));
  const state = () => readFileSync(path.join(f.guest, 'service-state'), 'utf8');
  return { ...f, register, registerLocked, registration, state };
}

test('register replaces the registration and starts the service under the verification lock', () => {
  const f = registerFixture();
  const result = f.register();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(f.events(), ['stop', 'uninstall', 'config', 'svc-install', 'start']);
  assert.deepEqual(f.registration(), ['new registration\n', 'new credential\n']);
  assert.equal(f.state(), 'active\n');
});

for (const [state, expected] of [['active', 'active'], ['inactive', 'inactive'], ['failed', 'inactive']] satisfies [string, string][]) {
  for (const [scenario, status] of [['config-fail', 1], ['config-term', 143]] satisfies [string, number][]) {
    test(`register restores ${state} at entry and the previous registration after ${scenario}`, () => {
      const f = registerFixture(scenario);
      writeFileSync(path.join(f.guest, 'service-state'), `${state}\n`);
      const result = f.register();
      assert.equal(result.status, status, result.stderr + result.stdout);
      assert.equal(result.signal, null);
      // Reinstalling the unit cannot recreate a failed state; it must not start the service either.
      assert.equal(f.state(), `${expected}\n`);
      assert.deepEqual(f.registration(), ['previous registration\n', 'previous credential\n']);
      const events = f.events();
      assert.deepEqual(events, [...(state === 'active' ? ['stop'] : []), 'uninstall', 'config', 'svc-install', ...(state === 'active' ? ['start'] : [])]);
      assert.equal(existsSync(path.join(f.guest, 'home/runner/actions-runner/.service')), true);
    });
  }
}

test('register restores exactly the previous registration files after a partial config failure', () => {
  const f = registerFixture('config-partial-fail');
  const result = f.register();
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.deepEqual(f.registration(), ['previous registration\n', 'previous credential\n']);
  assert.equal(existsSync(path.join(f.guest, 'home/runner/actions-runner/.credentials_rsaparams')), false);
  assert.equal(f.state(), 'active\n');
});

// The previous registration is moved aside one file at a time. A failure or TERM partway leaves later files in place,
// and only files that were absent at entry may be removed.
for (const [scenario, status] of [['mv-fail', 1], ['mv-term', 143]] satisfies [string, number][]) {
  test(`register keeps every previous registration file when the move aside stops partway (${scenario})`, () => {
    const f = registerFixture(scenario);
    const runner = path.join(f.guest, 'home/runner/actions-runner');
    writeFileSync(path.join(runner, '.credentials_rsaparams'), 'previous key\n');
    const result = f.register();
    assert.equal(result.status, status, result.stderr + result.stdout);
    assert.deepEqual(f.registration(), ['previous registration\n', 'previous credential\n']);
    assert.equal(readFileSync(path.join(runner, '.credentials_rsaparams'), 'utf8'), 'previous key\n');
    assert.equal(f.state(), 'active\n');
    assert.equal(f.events().includes('config'), false);
  });
}

test('register refuses a held verification lock before any mutation', () => {
  const f = registerFixture();
  const result = f.registerLocked();
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr, /another verification or provision is running/);
  assert.deepEqual(f.events(), []);
  assert.deepEqual(f.registration(), ['previous registration\n', 'previous credential\n']);
  assert.equal(f.state(), 'active\n');
});

for (const [setup, pattern] of [['state-unreadable', /could not read.*service state/], ['activating', /could not read a stable runner service state/]] satisfies [string, RegExp][]) {
  test(`register refuses ${setup} entry state before any mutation`, () => {
    const f = registerFixture(setup === 'state-unreadable' ? setup : 'pass');
    if (setup === 'activating') writeFileSync(path.join(f.guest, 'service-state'), 'activating\n');
    const result = f.register();
    assert.notEqual(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stderr, pattern);
    assert.deepEqual(f.events(), []);
    assert.deepEqual(f.registration(), ['previous registration\n', 'previous credential\n']);
  });
}

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
  // verify needs GitHub for the pause (user decision, 18 October); the verdict read never calls it.
  const githubCalls = f.github().length;
  const verdict = f.run('verdict', f.sha);
  assert.equal(f.github().length, githubCalls);
  assert.equal(verdict.status, 0, verdict.stderr);
  assert.equal(verdict.stdout, `PASS ${f.sha}\nreceipts ${stored}\n${scope}\n`);
  // The upload and checkout are removed; the results remain outside them.
  for (const upload of readFileSync(path.join(f.guest, 'uploads'), 'utf8').trim().split('\n')) assert.equal(existsSync(upload), false);
});

for (const scenario of ['check-fail', 'test-fail', 'chrome-fail', 'install-fail']) {
  test(`verify stores FAIL and starts the service again when ${scenario}`, () => {
    const f = fixture(scenario);
    const result = f.run('verify', 'HEAD');
    assert.equal(result.status, 1, result.stderr + result.stdout);
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
    assert.equal(verdict.stdout, `FAIL ${f.sha}\nreceipts ${stored}\n${scope}\n`);
  });
}

// The checks never ran to completion, so these exits are not verdicts: no entry is published and nothing is printed that
// reads like one. A verdict from an earlier verify of the same SHA stays the answer.
const verdicts = (f: ReturnType<typeof fixture>) => (existsSync(f.store) ? f.results() : []).filter((entry) => existsSync(path.join(entry, 'verdict.txt')));
for (const [scenario, status] of [['stop-fail', 1], ['busy-after-stop', 3], ['job-during-stop', 3], ['transient-during-stop', 3], ['guest-term', 143]] satisfies [string, number][]) {
  for (const earlier of [false, true]) {
    test(`verify publishes no verdict and no scope line when ${scenario}${earlier ? ' after an earlier PASS' : ''}`, () => {
      const f = fixture();
      if (earlier) assert.equal(f.run('verify', 'HEAD').status, 0);
      const [first] = verdicts(f);
      writeFileSync(path.join(f.guest, 'scenario'), scenario);
      writeFileSync(path.join(f.guest, 'service-state'), 'active\n');
      // The fake derives some behaviour from the events so far, so start the second run from none.
      writeFileSync(path.join(f.guest, 'events'), '');
      const result = f.run('verify', 'HEAD');
      assert.equal(result.status, status, result.stderr + result.stdout);
      const events = f.events();
      assert.equal(events.at(-1), 'start');
      if (['stop-fail', 'busy-after-stop'].includes(scenario)) {
        assert.equal(events.filter((event) => event === 'stop').length, 1);
        assert.ok(events.indexOf('start') > events.indexOf('stop'));
        assert.equal(events.some((event) => event.startsWith('forbidden')), false);
      }
      assert.equal(readFileSync(path.join(f.guest, 'service-state'), 'utf8'), 'active\n');
      assert.equal(/^(PASS|FAIL) /m.test(result.stdout), false, result.stdout);
      assert.equal(result.stdout.includes(scope), false);
      assert.equal(verdicts(f).length, earlier ? 1 : 0);
      const verdict = f.run('verdict', f.sha);
      if (earlier) {
        assert.equal(verdict.status, 0, verdict.stderr);
        assert.equal(verdict.stdout, `PASS ${f.sha}\nreceipts ${first}\n${scope}\n`);
      } else {
        assert.equal(verdict.status, 2, verdict.stderr);
        assert.equal(verdict.stdout, `UNKNOWN ${f.sha}\n`);
      }
    });
  }
}

test('a failed service start after passing checks changes the exit status, not the verdict', () => {
  const f = fixture('start-fail');
  const result = f.run('verify', 'HEAD');
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr, /runner restart failed/);
  const events = f.events();
  assert.equal(events.filter((event) => event === 'stop').length, 1);
  assert.equal(events.at(-1), 'start');
  assert.ok(events.indexOf('start') > events.indexOf('stop'));
  assert.equal(events.some((event) => event.startsWith('forbidden')), false);
  const [stored] = f.results();
  assert.ok(stored);
  assert.equal(readFileSync(path.join(stored, 'verdict.txt'), 'utf8'), `PASS ${f.sha}\n`);
  assert.ok(result.stdout.endsWith(`PASS ${f.sha}\nreceipts ${stored}\n${scope}\n`), result.stdout);
  const verdict = f.run('verdict', f.sha);
  assert.equal(verdict.status, 0, verdict.stderr);
  assert.equal(verdict.stdout, `PASS ${f.sha}\nreceipts ${stored}\n${scope}\n`);
});

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
  assert.equal(result.stdout, `PASS ${f.sha}\nreceipts ${completed}\n${scope}\n`);
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
      if (scenario === 'guest-term') assert.equal(/^(PASS|FAIL) /m.test(result.stdout), false, result.stdout);
      else assert.match(result.stdout, new RegExp(`^${status === 0 ? 'PASS' : 'FAIL'} ${f.sha}$`, 'm'));
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
  assert.equal(/^(PASS|FAIL) /m.test(result.stdout), false, result.stdout);
});

test('verify refuses a held admission lock before inspecting jobs or mutating service state', () => {
  const f = fixture();
  // The holder here outlives verify, so the lock never frees: the label stays off instead of waiting out the default bound.
  f.env.CLEARCASE_CI_RESUME_WAIT_SECONDS = '0.2';
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
  assert.equal(verdict.status, 2);
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

const runnerApi = 'repos/GridShift-Software/clearcase/actions/runners';
const pause = `api -X DELETE ${runnerApi}/22/labels/clearcase-pc1 --silent`;
const resume = `api -X POST ${runnerApi}/22/labels -f labels[]=clearcase-pc1 --silent`;
const isRead = (call: string) => call.startsWith(`api ${runnerApi} --jq `);
const githubState = (f: ReturnType<typeof fixture>) => readFileSync(path.join(f.guest, 'github'), 'utf8');

test('verify pauses dispatch through GitHub before touching the guest and resumes it after the restart', () => {
  const f = fixture();
  const result = f.run('verify', 'HEAD');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const calls = f.github();
  assert.deepEqual(calls.map(({ call }) => isRead(call) ? 'read' : call), ['read', pause, 'read', resume]);
  // The pause and its confirmation precede every guest observation; the resume follows the service restart.
  assert.deepEqual(calls.slice(0, 3).map(({ at }) => at), [0, 0, 0]);
  const events = f.events();
  assert.equal(events.at(-1), 'start');
  assert.equal(calls[3]?.at, events.length);
  assert.equal(githubState(f), '22 online false true\n');
  assert.equal(existsSync(path.join(f.guest, 'uploads')), true);
});

test('verify pins the guest host key to one known_hosts path on every SSH session, before and after the pause', () => {
  const f = fixture();
  const state = path.join(f.guest, 'ci-state');
  f.env.CLEARCASE_CI_STATE = state;
  const before = readdirSync(f.source).sort();
  const result = f.run('verify', 'HEAD');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const sessions = readFileSync(path.join(f.guest, 'ssh-known-hosts'), 'utf8').split('\n').filter(Boolean);
  // Upload, checks and the resume's lock confirmation all follow the GitHub pause.
  assert.ok(sessions.length >= 3, sessions.join('\n'));
  for (const option of sessions) {
    assert.equal(option, `UserKnownHostsFile=${state}/known_hosts`);
    assert.doesNotMatch(option, /\s/);
  }
  assert.deepEqual(readdirSync(f.source).sort(), before);
});

test('pc1-vm refuses a state directory containing whitespace before any command runs', () => {
  const f = fixture();
  f.env.CLEARCASE_CI_STATE = path.join(f.guest, 'ci state');
  const result = f.run('verify', 'HEAD');
  assert.equal(result.status, 2, result.stderr + result.stdout);
  assert.match(result.stderr, /CLEARCASE_CI_STATE must not contain whitespace/);
  assert.deepEqual(f.events(), []);
  assert.deepEqual(f.github(), []);
});

for (const scenario of ['check-fail', 'busy', 'guest-term', 'job-after-observation', 'drain-timeout', 'stop-fail', 'start-fail']) {
  test(`verify resumes dispatch through GitHub after ${scenario}`, () => {
    const f = fixture(scenario);
    if (scenario === 'drain-timeout') f.env.CLEARCASE_CI_DRAIN_TIMEOUT = '0.1';
    const result = f.run('verify', 'HEAD');
    assert.notEqual(result.status, 0, result.stderr + result.stdout);
    const calls = f.github();
    assert.equal(calls.filter(({ call }) => call === pause).length, 1);
    assert.deepEqual(calls.at(-1), { at: f.events().length, call: resume });
    assert.equal(githubState(f), '22 online false true\n');
  });
}

test('verify refuses a worker still running after the GitHub pause without stopping the service', () => {
  const f = fixture('busy');
  const result = f.run('verify', 'HEAD');
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr, /running a job/);
  assert.deepEqual(f.events(), ['pgrep']);
  assert.equal(readFileSync(path.join(f.guest, 'service-state'), 'utf8'), 'active\n');
  assert.deepEqual(f.github().map(({ call }) => isRead(call) ? 'read' : call), ['read', pause, 'read', resume]);
});

test('verify refuses without contacting the guest when GitHub is unreachable for the pause', () => {
  const f = fixture();
  writeFileSync(path.join(f.guest, 'github-scenario'), 'unreachable');
  const result = f.run('verify', 'HEAD');
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr, /could not read clearcase-pc1-vm's state from GitHub; verify refuses without a GitHub pause/);
  assert.deepEqual(f.events(), []);
  assert.equal(existsSync(path.join(f.guest, 'uploads')), false);
  assert.equal(existsSync(f.store), false);
  assert.deepEqual(f.github().map(({ call }) => isRead(call)), [true]);
  assert.equal(readFileSync(path.join(f.guest, 'service-state'), 'utf8'), 'active\n');
});

test('verify refuses without contacting the guest when the GitHub pause fails', () => {
  const f = fixture();
  writeFileSync(path.join(f.guest, 'github-scenario'), 'pause-fail');
  const result = f.run('verify', 'HEAD');
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr, /could not pause clearcase-pc1-vm through GitHub; verify refuses without a pause/);
  assert.deepEqual(f.events(), []);
  assert.equal(existsSync(path.join(f.guest, 'uploads')), false);
  // A failed removal may mean another verify removed the label first, so this one must not add it back.
  assert.deepEqual(f.github().map(({ call }) => isRead(call) ? 'read' : call), ['read', pause]);
  assert.ok(result.stderr.includes(`gh api -X POST ${runnerApi}/22/labels -f 'labels[]=clearcase-pc1'`), result.stderr);
  assert.equal(githubState(f), '22 online false true\n');
});

test('verify refuses a job GitHub assigned before the pause took effect, without contacting the guest', () => {
  const f = fixture();
  writeFileSync(path.join(f.guest, 'github-scenario'), 'busy-after-pause');
  const result = f.run('verify', 'HEAD');
  assert.equal(result.status, 3, result.stderr + result.stdout);
  assert.match(result.stderr, /still assigned a job after the GitHub pause/);
  assert.deepEqual(f.events(), []);
  assert.equal(existsSync(path.join(f.guest, 'uploads')), false);
  assert.deepEqual(f.github().map(({ call }) => isRead(call) ? 'read' : call), ['read', pause, 'read', resume]);
  assert.equal(githubState(f), '22 online false true\n');
});

for (const [setup, pattern] of [['busy', /clearcase-pc1-vm is running a job/], ['missing', /GitHub does not list a runner named clearcase-pc1-vm/]] satisfies [string, RegExp][]) {
  test(`verify refuses a runner GitHub reports ${setup} at entry without pausing it`, () => {
    const f = fixture();
    if (setup === 'busy') writeFileSync(path.join(f.guest, 'github'), '22 online true true\n');
    else writeFileSync(path.join(f.guest, 'github-scenario'), 'missing');
    const result = f.run('verify', 'HEAD');
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(result.stderr, pattern);
    assert.deepEqual(f.events(), []);
    assert.deepEqual(f.github().map(({ call }) => isRead(call)), [true]);
  });
}

test('verify leaves a runner that was already paused at entry paused', () => {
  const f = fixture();
  writeFileSync(path.join(f.guest, 'github'), '22 online false false\n');
  const result = f.run('verify', 'HEAD');
  // Another verify may hold that pause and lift it mid-run, so this one refuses rather than relying on it.
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr, /already paused \(no clearcase-pc1 label\), possibly by another verify/);
  assert.deepEqual(f.events(), []);
  assert.equal(existsSync(path.join(f.guest, 'uploads')), false);
  assert.deepEqual(f.github().map(({ call }) => isRead(call)), [true]);
  assert.equal(githubState(f), '22 online false false\n');
});

test('verify reports a failed resume with the command that lifts the pause', () => {
  const f = fixture();
  writeFileSync(path.join(f.guest, 'github-scenario'), 'resume-fail');
  const result = f.run('verify', 'HEAD');
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stdout, new RegExp(`^PASS ${f.sha}$`, 'm'));
  assert.ok(result.stderr.includes(`gh api -X POST ${runnerApi}/22/labels -f 'labels[]=clearcase-pc1'`), result.stderr);
  assert.equal(readFileSync(path.join(f.guest, 'service-state'), 'utf8'), 'active\n');
  assert.equal(githubState(f), '22 online false false\n');
});

// Job control gives verify its own process group, which receives the interrupt as a terminal's Ctrl-C would.
function interrupted(f: ReturnType<typeof fixture>) {
  const script = 'set -m; "$1" verify HEAD & job=$!; until grep -qx chrome "$2"; do sleep 0.02; done; kill -INT -- "-$job"; wait "$job"; status=$?; while pgrep -g "$job" >/dev/null; do sleep 0.02; done; exit "$status"';
  const result = spawnSync('bash', ['-c', script, 'interrupt', path.join(f.source, 'scripts/ci/pc1-vm'), path.join(f.guest, 'events')], { cwd: f.source, env: f.env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.signal, null);
  return result;
}

test('verify resumes dispatch when the workstation is interrupted during the checks', () => {
  const f = fixture('chrome-hang');
  const result = interrupted(f);
  assert.equal(result.status, 130, result.stderr + result.stdout);
  assert.deepEqual(f.github().at(-1)?.call, resume);
  assert.equal(githubState(f), '22 online false true\n');
  assert.equal(readFileSync(path.join(f.guest, 'service-state'), 'utf8'), 'active\n');
});

test('a workstation interrupt during the checks publishes no verdict and leaves an earlier PASS the answer', () => {
  const f = fixture();
  assert.equal(f.run('verify', 'HEAD').status, 0);
  const [first] = verdicts(f);
  writeFileSync(path.join(f.guest, 'scenario'), 'chrome-hang');
  // interrupted() waits for a chrome event, so clear the first run's or it interrupts before the second run starts.
  writeFileSync(path.join(f.guest, 'events'), '');
  const result = interrupted(f);
  assert.equal(result.status, 130, result.stderr + result.stdout);
  assert.ok(f.events().includes('chrome'), 'the second verify reached the checks');
  assert.equal(/^(PASS|FAIL) /m.test(result.stdout), false, result.stdout);
  assert.equal(result.stdout.includes(scope), false);
  assert.deepEqual(verdicts(f), [first]);
  const verdict = f.run('verdict', f.sha);
  assert.equal(verdict.status, 0, verdict.stderr);
  assert.equal(verdict.stdout, `PASS ${f.sha}\nreceipts ${first}\n${scope}\n`);
});

// A guest session outlives its SSH client (OpenSSH sends a command run without a pty no signal). The label may come back
// only once a fresh session sees the guest lock free, which is after the guest has restarted the runner.
function detached(f: ReturnType<typeof fixture>, hangSeconds: string) {
  writeFileSync(path.join(f.guest, 'scenario'), 'chrome-hang');
  writeFileSync(path.join(f.guest, 'detached'), '');
  writeFileSync(path.join(f.guest, 'hang-seconds'), hangSeconds);
  const finished = () => {
    for (let waited = 0; waited < 150 && f.events().at(-1) !== 'start'; waited++) spawnSync('sleep', ['0.1']);
    return f.events().at(-1) === 'start';
  };
  return { finished, lockChecks: () => existsSync(path.join(f.guest, 'lock-checks')) ? readFileSync(path.join(f.guest, 'lock-checks'), 'utf8').trim().split('\n') : [] };
}

test('verify resumes dispatch after an interrupt only once the detached guest session has restarted the runner', () => {
  const f = fixture();
  f.env.CLEARCASE_CI_RESUME_WAIT_SECONDS = '30';
  const guest = detached(f, '1.5');
  const result = interrupted(f);
  assert.equal(result.status, 130, result.stderr + result.stdout);
  assert.equal(guest.finished(), true);
  const calls = f.github();
  assert.equal(calls.filter(({ call }) => call === resume).length, 1);
  // The resume is after the guest's own restart (its last event), never in the gap before the guest stops the runner.
  assert.deepEqual(calls.at(-1), { at: f.events().length, call: resume });
  assert.equal(guest.lockChecks().length, 1);
  assert.equal(githubState(f), '22 online false true\n');
  assert.equal(readFileSync(path.join(f.guest, 'service-state'), 'utf8'), 'active\n');
});

test('verify leaves the label off and prints the command when the guest still holds the lock past the bound', () => {
  const f = fixture();
  f.env.CLEARCASE_CI_RESUME_WAIT_SECONDS = '0.3';
  const guest = detached(f, '2');
  const result = interrupted(f);
  assert.equal(result.status, 130, result.stderr + result.stdout);
  assert.equal(f.github().some(({ call }) => call === resume), false);
  assert.equal(githubState(f), '22 online false false\n');
  assert.ok(result.stderr.includes(`scripts/ci/pc1-vm ssh sudo flock -w 300 /run/clearcase-ci-verify.lock true && gh api -X POST ${runnerApi}/22/labels -f 'labels[]=clearcase-pc1'`), result.stderr);
  // The guest session carries on and restores the runner by itself; the operator then lifts the pause.
  assert.equal(guest.finished(), true);
  assert.equal(readFileSync(path.join(f.guest, 'service-state'), 'utf8'), 'active\n');
});

test('verify leaves the label off and prints the command when no fresh session can reach the guest', () => {
  const f = fixture();
  writeFileSync(path.join(f.guest, 'lock-check-unreachable'), '');
  const result = f.run('verify', 'HEAD');
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stdout, new RegExp(`^PASS ${f.sha}$`, 'm'));
  assert.equal(f.github().some(({ call }) => call === resume), false);
  assert.equal(githubState(f), '22 online false false\n');
  assert.ok(result.stderr.includes(`gh api -X POST ${runnerApi}/22/labels -f 'labels[]=clearcase-pc1'`), result.stderr);
});

test('a normal verify confirms the lock with one fresh session before the resume, and a pre-guest refusal needs none', () => {
  const f = fixture();
  assert.equal(f.run('verify', 'HEAD').status, 0);
  assert.equal(existsSync(path.join(f.guest, 'lock-checks')), true);
  assert.match(readFileSync(path.join(f.guest, 'lock-checks'), 'utf8'), /^sudo flock -w 300 \/run\/clearcase-ci-verify\.lock true\n$/);
  const refused = fixture('pass');
  writeFileSync(path.join(refused.guest, 'github-scenario'), 'busy-after-pause');
  assert.equal(refused.run('verify', 'HEAD').status, 3);
  assert.equal(existsSync(path.join(refused.guest, 'lock-checks')), false);
  assert.deepEqual(refused.github().at(-1)?.call, resume);
});

test('of two racing verifies exactly one pauses; the loser refuses before the guest and never adds the label', () => {
  const f = fixture();
  writeFileSync(path.join(f.guest, 'github-scenario'), 'race');
  const out = (name: string) => path.join(f.guest, name);
  const script = 'pc1=$1; out=$2; "$pc1" verify HEAD >"$out/a.out" 2>"$out/a.err" & a=$!; "$pc1" verify HEAD >"$out/b.out" 2>"$out/b.err" & b=$!; wait "$a"; echo $? >"$out/a.status"; wait "$b"; echo $? >"$out/b.status"';
  const result = spawnSync('bash', ['-c', script, 'race', path.join(f.source, 'scripts/ci/pc1-vm'), f.guest], { cwd: f.source, env: f.env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const runs = ['a', 'b'].map((name) => ({ status: Number(readFileSync(out(`${name}.status`), 'utf8')), stdout: readFileSync(out(`${name}.out`), 'utf8'), stderr: readFileSync(out(`${name}.err`), 'utf8') }));
  const winner = runs.find((run) => run.status === 0);
  const loser = runs.find((run) => run.status !== 0);
  assert.ok(winner && loser, JSON.stringify(runs));
  assert.match(winner.stdout, new RegExp(`^PASS ${f.sha}$`, 'm'));
  assert.equal(loser.status, 1);
  assert.match(loser.stderr, /could not pause clearcase-pc1-vm through GitHub; verify refuses without a pause/);
  assert.equal(/^(PASS|FAIL) /m.test(loser.stdout), false);
  const calls = f.github();
  assert.equal(calls.filter(({ call }) => call === pause).length, 2);
  // Only the winner reaches the guest and only the winner gives the label back, after its own restart.
  assert.equal(f.events().filter((event) => event === 'stop').length, 1);
  assert.equal(readFileSync(path.join(f.guest, 'uploads'), 'utf8').trim().split('\n').length, 1);
  assert.equal(calls.filter(({ call }) => call === resume).length, 1);
  assert.deepEqual(calls.at(-1), { at: f.events().length, call: resume });
  assert.equal(githubState(f), '22 online false true\n');
  assert.equal(readFileSync(path.join(f.guest, 'service-state'), 'utf8'), 'active\n');
});

test('verdict answers with GitHub unreachable and never calls GitHub', () => {
  const f = fixture();
  assert.equal(f.run('verify', 'HEAD').status, 0);
  const before = f.github().length;
  writeFileSync(path.join(f.guest, 'github-scenario'), 'unreachable');
  const verdict = f.run('verdict', f.sha);
  assert.equal(verdict.status, 0, verdict.stderr);
  assert.match(verdict.stdout, new RegExp(`^PASS ${f.sha}$`, 'm'));
  assert.equal(f.github().length, before);
});

test('every self-hosted workflow job requires the clearcase-pc1 label that verify removes', () => {
  const workflows = path.join(app, '.github/workflows');
  const runsOn = readdirSync(workflows).flatMap((name) => readFileSync(path.join(workflows, name), 'utf8').split('\n').filter((line) => /^\s*runs-on:/.test(line)));
  assert.ok(runsOn.length > 0);
  for (const line of runsOn) assert.match(line, /\bclearcase-pc1\b/, line);
});

test('verify and verdict print what a verdict proves and what it does not', () => {
  const f = fixture();
  const pass = f.run('verify', 'HEAD');
  assert.equal(pass.status, 0, pass.stderr + pass.stdout);
  const [stored] = f.results();
  assert.ok(pass.stdout.endsWith(`PASS ${f.sha}\nreceipts ${stored}\n${scope}\n`), pass.stdout);
  writeFileSync(path.join(f.guest, 'scenario'), 'check-fail');
  const fail = f.run('verify', 'HEAD');
  assert.equal(fail.status, 1, fail.stderr + fail.stdout);
  assert.ok(fail.stdout.endsWith(`\n${scope}\n`), fail.stdout);
  const verdict = f.run('verdict', f.sha);
  assert.equal(verdict.status, 1, verdict.stderr);
  assert.ok(verdict.stdout.endsWith(`\n${scope}\n`), verdict.stdout);
  // A refusal proves nothing, so it prints no scope.
  writeFileSync(path.join(f.guest, 'scenario'), 'busy');
  assert.equal(f.run('verify', 'HEAD').stdout.includes(scope), false);
});

test('docs/ci-runner.md states the scope line, the pause commands and the defaults verify uses', () => {
  const docs = readFileSync(path.join(app, 'docs/ci-runner.md'), 'utf8');
  const script = readFileSync(path.join(app, 'scripts/ci/pc1-vm'), 'utf8');
  assert.ok(docs.includes(scope));
  assert.ok(docs.includes(`gh api -X DELETE ${runnerApi}/ID/labels/clearcase-pc1`));
  assert.ok(docs.includes(`gh api -X POST ${runnerApi}/ID/labels -f 'labels[]=clearcase-pc1'`));
  for (const [setting, value] of [['CLEARCASE_CI_PAUSE_SETTLE_SECONDS', '5'], ['CLEARCASE_CI_RESUME_WAIT_SECONDS', '300'], ['CLEARCASE_CI_QUIET_SECONDS', '5'], ['CLEARCASE_CI_IDLE_OBSERVATIONS', '3'], ['CLEARCASE_CI_DRAIN_TIMEOUT', '30']]) {
    assert.ok(script.includes(`\${${setting}:-${value}}`), setting);
    assert.ok(docs.includes(`\`${setting}\` (default \`${value}\`)`), setting);
  }
});
