import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHarness, git, scope } from './pc1-vm-support';

const testRunner = process.env.VITEST ? 'vitest' : 'bun:test';
const { afterEach, test }: Pick<typeof import('vitest'), 'afterEach' | 'test'> = await import(testRunner);
const { fixture, verdicts, cleanup } = createHarness();
afterEach(cleanup);


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


test('invalid arguments and missing cached origin/dev fail before contacting the guest', () => {
  const f = fixture();
  for (const args of [['verify'], ['verdict'], ['verdict', '../../bad'], ['verify', 'HEAD', 'extra']]) assert.equal(f.run(...args).status, 2);
  git(f.source, 'update-ref', '-d', 'refs/remotes/origin/dev');
  assert.notEqual(f.run('verify', 'HEAD').status, 0);
  assert.deepEqual(f.events(), []);
  assert.equal(existsSync(path.join(f.guest, 'uploads')), false);
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
