import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHarness, fake } from './pc1-vm-support';

// The ticket requires `bun test tests/ci`; the same cases must also appear in the job's Vitest report.
const testRunner = process.env.VITEST ? 'vitest' : 'bun:test';
const { afterEach, test }: Pick<typeof import('vitest'), 'afterEach' | 'test'> = await import(testRunner);
const { provisionFixture, cleanup } = createHarness();
afterEach(cleanup);


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


// The runner-side admission hook (GRS-158): root-owned files outside the runner's directory, and the systemd drop-in that
// sets ACTIONS_RUNNER_HOOK_JOB_STARTED for the runner service.
const hookDir = (guest: string) => path.join(guest, 'usr/local/lib/clearcase-ci');

const hookPath = (guest: string) => path.join(hookDir(guest), 'job-started-hook.sh');

const dropIn = (guest: string) => path.join(guest, 'etc/systemd/system/actions.runner.GridShift-Software-clearcase.clearcase-pc1-vm.service.d/10-clearcase-admission.conf');


function registerFixture(scenario = 'pass') {
  const f = provisionFixture(scenario);
  const runner = path.join(f.guest, 'home/runner/actions-runner');
  for (const tool of ['fake-ci-svc', 'fake-ci-config', 'mv']) copyFileSync(fake, path.join(f.guest, 'bin', tool));
  writeFileSync(path.join(runner, 'svc.sh'), '#!/bin/bash\nexec fake-ci-svc "$@"\n');
  writeFileSync(path.join(runner, 'config.sh'), '#!/bin/bash\nexec fake-ci-config "$@"\n');
  for (const script of ['svc.sh', 'config.sh']) chmodSync(path.join(runner, script), 0o755);
  writeFileSync(path.join(runner, '.runner'), 'previous registration\n');
  writeFileSync(path.join(runner, '.credentials'), 'previous credential\n');
  // A guest that provision has already given the admission hook (GRS-158): register refuses to run without it.
  mkdirSync(hookDir(f.guest), { recursive: true });
  mkdirSync(path.dirname(dropIn(f.guest)), { recursive: true });
  writeFileSync(hookPath(f.guest), '#!/bin/bash\nexit 0\n');
  chmodSync(hookPath(f.guest), 0o755);
  writeFileSync(path.join(hookDir(f.guest), 'job-started-policy.py'), '');
  writeFileSync(dropIn(f.guest), `[Service]\nEnvironment=ACTIONS_RUNNER_HOOK_JOB_STARTED=${hookPath(f.guest)}\n`);
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


// GRS-158: the repository is public, so the runner itself refuses a job whose event is not this repository's. The hook
// and its policy are root-owned files outside the runner's writable directory; a systemd drop-in sets the variable the
// runner reads, and the runner has to restart to read it.
const installedAs = (guest: string) => readFileSync(path.join(guest, 'installs'), 'utf8').trim().split('\n');

const mode = (file: string) => (statSync(file).mode & 0o777).toString(8);


test('provision installs the root-owned admission hook, its policy and the drop-in that enables the hook, and reloads systemd before it restarts the runner', () => {
  const f = provisionFixture();
  const result = f.provision();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(mode(hookPath(f.guest)), '755');
  assert.equal(mode(path.join(hookDir(f.guest), 'job-started-policy.py')), '644');
  assert.equal(mode(dropIn(f.guest)), '644');
  assert.equal(mode(hookDir(f.guest)), '755');
  assert.equal(mode(path.dirname(dropIn(f.guest))), '755');
  // The runner user can neither replace nor edit any of them, because root owns them and no one else can write.
  for (const target of [hookDir(f.guest), path.dirname(dropIn(f.guest)), hookPath(f.guest), path.join(hookDir(f.guest), 'job-started-policy.py'), dropIn(f.guest)]) {
    assert.ok(installedAs(f.guest).some((line) => line.startsWith('root:root ') && line.endsWith(target)), `${target} is not installed as root:root`);
  }
  const active = readFileSync(dropIn(f.guest), 'utf8').split('\n').filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(active, ['[Service]', `Environment=ACTIONS_RUNNER_HOOK_JOB_STARTED=${hookPath(f.guest)}`]);
  const events = f.events();
  assert.ok(events.indexOf('daemon-reload') > events.indexOf('stop'), events.join());
  assert.ok(events.indexOf('daemon-reload') < events.lastIndexOf('start'), events.join());
  assert.equal(events.at(-1), 'start');
  assert.equal(readFileSync(path.join(f.guest, 'service-state'), 'utf8'), 'active\n');
});


test('provision restarts a runner that is already at the current version once, to load a hook it did not have', () => {
  const f = provisionFixture();
  writeFileSync(path.join(f.guest, 'home/runner/actions-runner/.clearcase-version'), '99.0.0\n');
  const result = f.provision();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const events = f.events();
  assert.equal(events.includes('extract'), false, 'the runner archive was unpacked again');
  assert.deepEqual(events.filter((event) => ['stop', 'daemon-reload', 'start'].includes(event)), ['stop', 'daemon-reload', 'start']);
  assert.equal(readFileSync(path.join(f.guest, 'service-state'), 'utf8'), 'active\n');
});


test('provision of a guest that already has the hook stops and starts nothing', () => {
  const f = provisionFixture();
  assert.equal(f.provision().status, 0);
  writeFileSync(path.join(f.guest, 'events'), '');
  const before = readFileSync(hookPath(f.guest), 'utf8');
  const result = f.provision();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(f.events().filter((event) => ['stop', 'start', 'lock-missing'].includes(event)), []);
  assert.equal(readFileSync(hookPath(f.guest), 'utf8'), before);
});


test('provision installs the hook but leaves an inactive runner stopped', () => {
  const f = provisionFixture();
  writeFileSync(path.join(f.guest, 'service-state'), 'inactive\n');
  const result = f.provision();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(existsSync(hookPath(f.guest)), true);
  assert.equal(existsSync(dropIn(f.guest)), true);
  assert.equal(f.events().some((event) => ['stop', 'start'].includes(event)), false);
  assert.equal(readFileSync(path.join(f.guest, 'service-state'), 'utf8'), 'inactive\n');
});


test('provision leaves the runner stopped, rather than start it without the hook, when systemd does not load the drop-in', () => {
  const f = provisionFixture('dropin-ignored');
  const result = f.provision();
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr, /admission hook is not loaded/);
  assert.equal(f.events().includes('start'), false);
  assert.equal(readFileSync(path.join(f.guest, 'service-state'), 'utf8'), 'inactive\n');
});


test('provision does not start the runner when systemd cannot reload', () => {
  const f = provisionFixture('daemon-reload-fail');
  const result = f.provision();
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  assert.equal(f.events().includes('start'), false);
  assert.equal(readFileSync(path.join(f.guest, 'service-state'), 'utf8'), 'inactive\n');
});


for (const [missing, remove] of [['script', (guest: string) => hookPath(guest)], ['policy', (guest: string) => path.join(hookDir(guest), 'job-started-policy.py')], ['drop-in', (guest: string) => dropIn(guest)]] satisfies [string, (guest: string) => string][]) {
  test(`register refuses to run without the ${missing} of the admission hook, before any mutation`, () => {
    const f = registerFixture();
    rmSync(remove(f.guest));
    const result = f.register();
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(result.stderr, /admission hook is not installed; run provision first/);
    assert.deepEqual(f.events(), []);
    assert.deepEqual(f.registration(), ['previous registration\n', 'previous credential\n']);
    assert.equal(f.state(), 'active\n');
  });
}


test('register does not start the runner when systemd does not load the drop-in for the reinstalled unit', () => {
  const f = registerFixture('dropin-ignored');
  const result = f.register();
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr, /admission hook is not loaded/);
  assert.equal(f.events().includes('start'), false);
  assert.equal(f.state(), 'inactive\n');
});
