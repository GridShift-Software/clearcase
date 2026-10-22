import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, createHarness, scope } from './pc1-vm-support';

const testRunner = process.env.VITEST ? 'vitest' : 'bun:test';
const { afterEach, test }: Pick<typeof import('vitest'), 'afterEach' | 'test'> = await import(testRunner);
const { fixture, verdicts, cleanup } = createHarness();
afterEach(cleanup);


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
