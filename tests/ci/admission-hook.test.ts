// GRS-158: the repository is public, and a pull request's run uses the pull request's own workflow file, so a job guard
// cannot keep a fork's code off the persistent runner. The runner refuses at its own boundary: a root-owned job-started
// hook that guest-provision.sh installs, which reads the event payload the runner wrote and ends the job unless the event
// is this repository's own. These tests run the hook exactly as provision installs it (in the fake guest of
// fake-guest.sh), as a child of a process named Runner.Worker that goes on to run its steps afterwards, as the real worker
// does: a plain non-zero exit of the hook fails the job but not its `if: always()` steps (actions/runner v2.338.0,
// StepsRunner.cs), so a denial has to stop the worker.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const app = fileURLToPath(new URL('../..', import.meta.url));
const fake = path.join(app, 'tests/ci/fake-guest.sh');
const REPO = 'GridShift-Software/clearcase';
const FORK = 'someone/clearcase';
const SHA = 'a'.repeat(40);
const scratch: string[] = [];
afterAll(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

// The guest provision leaves behind, with a stand-in for the runner's worker: a copy of bash named Runner.Worker, because
// the hook finds the worker by the name of an ancestor process.
function guest() {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'clearcase-ci-hook-')));
  scratch.push(dir);
  const bin = path.join(dir, 'bin');
  mkdirSync(path.join(dir, 'home/runner/actions-runner/bin'), { recursive: true });
  mkdirSync(path.join(dir, 'etc/sysctl.d'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const tool of ['sudo', 'systemctl', 'pgrep', 'install', 'bun', 'apt-get', 'sysctl', 'chown', 'id', 'runuser', 'curl', 'sha256sum', 'tar', 'fake-ci-deps']) copyFileSync(fake, path.join(bin, tool));
  writeFileSync(path.join(dir, 'real-bun'), execFileSync('bash', ['-c', 'command -v bun'], { encoding: 'utf8' }).trim());
  writeFileSync(path.join(dir, 'scenario'), 'pass');
  writeFileSync(path.join(dir, 'service-state'), 'inactive\n');
  writeFileSync(path.join(dir, 'events'), '');
  writeFileSync(path.join(dir, 'os-release'), 'PRETTY_NAME="Synthetic guest"\n');
  writeFileSync(path.join(dir, 'home/runner/actions-runner/.clearcase-version'), '99.0.0\n');
  writeFileSync(path.join(dir, 'home/runner/actions-runner/bin/installdependencies.sh'), '#!/bin/bash\nfake-ci-deps\n', { mode: 0o755 });
  const env = { ...process.env, FAKE_GUEST_ROOT: dir, HOME: path.join(dir, 'home/runner'), PATH: `${bin}:${process.env.PATH}` };
  const provisioned = spawnSync(fake, ['provision', path.join(app, 'scripts/ci/guest-provision.sh')], { cwd: app, env, encoding: 'utf8', timeout: 20_000 });
  const worker = path.join(dir, 'Runner.Worker');
  copyFileSync(execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim(), worker);
  const lib = path.join(dir, 'usr/local/lib/clearcase-ci');
  const event = path.join(dir, 'home/runner/actions-runner/_work/_temp/_github_workflow/event.json');
  mkdirSync(path.dirname(event), { recursive: true });
  return { dir, provisioned, lib, hook: path.join(lib, 'job-started-hook.sh'), policy: path.join(lib, 'job-started-policy.py'), worker, event, env, log: path.join(dir, 'home/runner/clearcase-admission.log') };
}
const shared = guest();

type Env = Record<string, string | undefined>;
// The runner's job: write the payload, run the hook as `bash -e <hook>` from a worker process, and then run the job's other
// steps, one of which is an always() step that writes a marker. Returns whether the hook let the job go on.
function job(payload: unknown, env: Env = {}, options: { g?: ReturnType<typeof guest>; write?: boolean; age?: number } = {}) {
  const g = options.g ?? shared;
  mkdirSync(path.dirname(g.event), { recursive: true });
  rmSync(g.event, { force: true });
  if (options.write !== false) {
    writeFileSync(g.event, typeof payload === 'string' ? payload : JSON.stringify(payload));
    const when = new Date(Date.now() - (options.age ?? 0) * 1000);
    utimesSync(g.event, when, when);
  }
  const marks = path.join(g.dir, 'marks');
  rmSync(marks, { force: true });
  const steps = `bash -e "$HOOK"; echo "hook=$?" >>"$MARKS"; echo "always-step" >>"$MARKS"`;
  const result = spawnSync(g.worker, ['-c', steps], {
    cwd: g.dir, encoding: 'utf8', timeout: 20_000,
    env: { PATH: g.env.PATH, HOOK: g.hook, MARKS: marks, GITHUB_EVENT_PATH: g.event, GITHUB_REPOSITORY: REPO, ...env },
  });
  const marked = existsSync(marks) ? readFileSync(marks, 'utf8') : '';
  return { ...result, admitted: marked.includes('hook=0'), alwaysStepRan: marked.includes('always-step'), killed: result.signal === 'SIGKILL' };
}

const pullRequest = (head: string | null, extra: Record<string, unknown> = {}) => ({
  action: 'synchronize', number: 7, repository: { full_name: REPO },
  pull_request: { number: 7, base: { ref: 'dev', repo: { full_name: REPO } }, head: { ref: 'feature/x', sha: SHA, repo: head === null ? null : { full_name: head } } },
  sender: { login: 'someone', type: 'User' }, ...extra,
});
const push = (ref: string, extra: Record<string, unknown> = {}) => ({ ref, before: SHA, after: SHA, repository: { full_name: REPO }, pusher: { name: 'someone' }, ...extra });
const dispatch = (ref: string, repository = REPO) => ({ ref, inputs: {}, repository: { full_name: repository }, workflow: '.github/workflows/ci.yml', sender: { login: 'someone' } });

const ADMITTED: [string, unknown, Env][] = [
  ['a pull request from a branch of this repository', pullRequest(REPO, { action: 'opened' }), { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/7/merge' }],
  ['a new commit on that pull request', pullRequest(REPO), { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/7/merge' }],
  ['a push to dev', push('refs/heads/dev'), { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/dev' }],
  ['a manual run on a branch of this repository', dispatch('refs/heads/feature/grs-158-x'), { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/feature/grs-158-x' }],
];

describe('the admission hook that provision installs', () => {
  it('was installed by provision, so these tests run the real thing', () => {
    expect(shared.provisioned.status, shared.provisioned.stderr + shared.provisioned.stdout).toBe(0);
    expect(existsSync(shared.hook)).toBe(true);
    expect(existsSync(shared.policy)).toBe(true);
  });

  it('lets the job go on for a pull request from this repository, a push to dev and a manual run', () => {
    for (const [name, payload, env] of ADMITTED) {
      const run = job(payload, env);
      expect(run.admitted, `${name}: ${run.stderr}${run.stdout}`).toBe(true);
      expect(run.alwaysStepRan, name).toBe(true);
      expect(run.killed, name).toBe(false);
    }
  });

  // Each row is an event the workflow's own guard may or may not have been dropped for: the hook decides from the payload
  // the runner wrote, so none of them depends on the workflow file.
  const DENIED: [string, unknown, Env][] = [
    ['a pull request from a fork', pullRequest(FORK), { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/7/merge' }],
    ['a pull request a writer opened from a fork', pullRequest(FORK, { action: 'opened', sender: { login: 'gridshift-admin', type: 'User' }, author_association: 'MEMBER' }), { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/7/merge', GITHUB_ACTOR: 'gridshift-admin', GITHUB_TRIGGERING_ACTOR: 'gridshift-admin' }],
    ['a push by an outsider to that fork pull request', pullRequest(FORK, { action: 'synchronize', sender: { login: 'outsider', type: 'User' } }), { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/7/merge', GITHUB_ACTOR: 'outsider', GITHUB_TRIGGERING_ACTOR: 'outsider' }],
    ['a pull request whose fork was deleted', pullRequest(null), { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/7/merge' }],
    ['a pull request into a fork', { ...pullRequest(REPO), pull_request: { ...pullRequest(REPO).pull_request, base: { ref: 'dev', repo: { full_name: FORK } } } }, { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/7/merge' }],
    ['a pull request with no head repository field', { ...pullRequest(REPO), pull_request: { number: 7, base: { ref: 'dev', repo: { full_name: REPO } }, head: { ref: 'x' } } }, { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/7/merge' }],
    ['a pull_request_target run for a fork', pullRequest(FORK), { GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_REF: 'refs/heads/dev' }],
    ['a pull_request_target run for a branch of this repository', pullRequest(REPO), { GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_REF: 'refs/heads/dev' }],
    ['a fork pull request that claims to be a push', pullRequest(FORK), { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/dev' }],
    ['an issue comment', { action: 'created', repository: { full_name: REPO }, issue: { number: 7 }, comment: { body: '/run' } }, { GITHUB_EVENT_NAME: 'issue_comment', GITHUB_REF: 'refs/heads/main' }],
    ['an issue opened by the public', { action: 'opened', repository: { full_name: REPO }, issue: { number: 8 } }, { GITHUB_EVENT_NAME: 'issues', GITHUB_REF: 'refs/heads/main' }],
    ['a workflow_run after a fork\'s run', { action: 'completed', repository: { full_name: REPO }, workflow_run: { event: 'pull_request', head_repository: { full_name: FORK } } }, { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REF: 'refs/heads/main' }],
    ['a schedule', { schedule: '0 * * * *', repository: { full_name: REPO } }, { GITHUB_EVENT_NAME: 'schedule', GITHUB_REF: 'refs/heads/main' }],
    ['a push to main', push('refs/heads/main'), { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' }],
    ['a push to a branch that ends in dev', push('refs/heads/feature/dev'), { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/feature/dev' }],
    ['a push of a tag named dev', push('refs/tags/dev'), { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/dev' }],
    ['a push whose payload ref differs from the environment', push('refs/heads/main'), { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/dev' }],
    ['a push to dev whose environment names another ref', push('refs/heads/dev'), { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' }],
    ['a push to dev whose payload also holds a fork pull request', push('refs/heads/dev', { pull_request: pullRequest(FORK).pull_request }), { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/dev' }],
    ['a manual run whose environment names another ref', dispatch('refs/heads/dev'), { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main' }],
    ['a push to dev in a fork', push('refs/heads/dev', { repository: { full_name: FORK } }), { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/dev', GITHUB_REPOSITORY: FORK }],
    ['a manual run in a fork', dispatch('refs/heads/dev', FORK), { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/dev', GITHUB_REPOSITORY: FORK }],
    ['a fork\'s payload under this repository\'s name in the environment', dispatch('refs/heads/dev', FORK), { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/dev' }],
    ['this repository\'s payload under a fork\'s name in the environment', dispatch('refs/heads/dev'), { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/dev', GITHUB_REPOSITORY: FORK }],
    ['the repository name in another case', { ...dispatch('refs/heads/dev'), repository: { full_name: REPO.toLowerCase() } }, { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/dev', GITHUB_REPOSITORY: REPO.toLowerCase() }],
    ['a payload with no repository', { ref: 'refs/heads/dev', inputs: {} }, { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/dev' }],
    ['a payload whose repository is not an object', { ref: 'refs/heads/dev', repository: REPO }, { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/dev' }],
    ['an event with no name', pullRequest(REPO), { GITHUB_EVENT_NAME: '', GITHUB_REF: 'refs/pull/7/merge' }],
    ['an event with a name in another case', pullRequest(REPO), { GITHUB_EVENT_NAME: 'Pull_Request', GITHUB_REF: 'refs/pull/7/merge' }],
    ['an event whose name is not one of the three', pullRequest(REPO), { GITHUB_EVENT_NAME: 'pull_request_review', GITHUB_REF: 'refs/pull/7/merge' }],
  ];
  it('ends the job, and its always() steps, for every event that is not this repository\'s own', () => {
    for (const [name, payload, env] of DENIED) {
      const run = job(payload, env);
      expect(run.admitted, name).toBe(false);
      expect(run.alwaysStepRan, `${name}: the always() step ran after the hook refused`).toBe(false);
      expect(run.killed, `${name}: the worker was not stopped`).toBe(true);
    }
  });

  it('refuses a payload it cannot trust: missing, not at the runner\'s path, a link, stale, empty, not JSON, not an object, with a repeated key', () => {
    const ok = pullRequest(REPO);
    const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/7/merge' };
    const outside = path.join(shared.dir, 'elsewhere.json');
    writeFileSync(outside, JSON.stringify(ok));
    const cases: [string, ReturnType<typeof job>][] = [
      ['no payload file', job(ok, env, { write: false })],
      ['no GITHUB_EVENT_PATH', job(ok, { ...env, GITHUB_EVENT_PATH: undefined })],
      ['an empty GITHUB_EVENT_PATH', job(ok, { ...env, GITHUB_EVENT_PATH: '' })],
      ['a valid payload at another path', job(ok, { ...env, GITHUB_EVENT_PATH: outside })],
      ['a relative path', job(ok, { ...env, GITHUB_EVENT_PATH: 'event.json' })],
      ['a stale payload', job(ok, env, { age: 3600 })],
      ['an empty payload', job('', env)],
      ['text that is not JSON', job('not json', env)],
      ['a JSON list', job('[]', env)],
      ['a JSON string', job('"x"', env)],
      ['a repeated key', job(`{"repository":{"full_name":"${FORK}"},"repository":{"full_name":"${REPO}"},"pull_request":${JSON.stringify(ok.pull_request)}}`, env)],
    ];
    // A link at the payload path, to an otherwise valid payload.
    const link = job(ok, env);
    rmSync(shared.event);
    symlinkSync(outside, shared.event);
    const marks = path.join(shared.dir, 'marks');
    rmSync(marks, { force: true });
    const viaLink = spawnSync(shared.worker, ['-c', 'bash -e "$HOOK"; echo "always-step" >>"$MARKS"'], { cwd: shared.dir, encoding: 'utf8', env: { PATH: shared.env.PATH, HOOK: shared.hook, MARKS: marks, GITHUB_EVENT_PATH: shared.event, GITHUB_REPOSITORY: REPO, ...env } });
    expect(link.admitted).toBe(true);
    expect(viaLink.signal, 'a link at the payload path').toBe('SIGKILL');
    expect(existsSync(marks)).toBe(false);
    for (const [name, run] of cases) {
      expect(run.admitted, name).toBe(false);
      expect(run.alwaysStepRan, `${name}: the always() step ran`).toBe(false);
      expect(run.killed, name).toBe(true);
    }
  });

  it('refuses a payload reached through a linked directory, though the file itself is a regular file', () => {
    const g = guest();
    const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/7/merge' };
    expect(job(pullRequest(REPO), env, { g }).admitted).toBe(true);
    const dir = path.dirname(g.event);
    renameSync(dir, `${dir}.real`);
    symlinkSync(`${dir}.real`, dir);
    const linked = job(pullRequest(REPO), env, { g });
    expect(linked.admitted).toBe(false);
    expect(linked.alwaysStepRan).toBe(false);
    expect(linked.killed).toBe(true);
  });

  it('does not read the hook\'s decision from anything a workflow can set: its own environment, PYTHONPATH, or a planted module', () => {
    // Only the event payload, GITHUB_REPOSITORY, GITHUB_EVENT_NAME and GITHUB_REF are read. A planted json.py on PYTHONPATH
    // that would make the policy admit everything is not imported (python -I), and variables that look like decisions do nothing.
    const planted = path.join(shared.dir, 'planted');
    mkdirSync(planted, { recursive: true });
    writeFileSync(path.join(planted, 'json.py'), 'import sys\nsys.exit(0)\n');
    writeFileSync(path.join(planted, 'sitecustomize.py'), 'import sys\nsys.exit(0)\n');
    const fork = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/7/merge' };
    for (const env of [{ PYTHONPATH: planted }, { PYTHONSTARTUP: path.join(planted, 'json.py'), PYTHONHOME: planted }, { CLEARCASE_ADMIT: '1', ADMISSION: 'allow', GITHUB_ACTOR: REPO.split('/')[0] }, { BASH_ENV: path.join(planted, 'json.py') }]) {
      const run = job(pullRequest(FORK), { ...fork, ...env });
      expect(run.admitted, JSON.stringify(env)).toBe(false);
      expect(run.alwaysStepRan, JSON.stringify(env)).toBe(false);
    }
    // And the same variables do not stop this repository's own job.
    expect(job(pullRequest(REPO), { ...fork, PYTHONPATH: planted }).admitted).toBe(true);
  });

  it('ends the job when its own policy cannot run, instead of letting it go on', () => {
    const g = guest();
    expect(g.provisioned.status, g.provisioned.stderr).toBe(0);
    const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/dev' };
    expect(job(dispatch('refs/heads/dev'), env, { g }).admitted).toBe(true);
    rmSync(g.policy);
    const missing = job(dispatch('refs/heads/dev'), env, { g });
    expect(missing.admitted, 'a missing policy').toBe(false);
    expect(missing.alwaysStepRan, 'a missing policy').toBe(false);
    expect(missing.killed, 'a missing policy').toBe(true);
    writeFileSync(g.policy, 'raise SystemExit("broken")\n');
    const broken = job(dispatch('refs/heads/dev'), env, { g });
    expect(broken.alwaysStepRan, 'a policy that raises').toBe(false);
    expect(broken.killed, 'a policy that raises').toBe(true);
    writeFileSync(g.policy, 'import this_module_does_not_exist\n');
    const crash = job(dispatch('refs/heads/dev'), env, { g });
    expect(crash.alwaysStepRan, 'a policy that cannot import').toBe(false);
    writeFileSync(g.policy, 'x = (\n');
    expect(job(dispatch('refs/heads/dev'), env, { g }).alwaysStepRan, 'a policy that does not parse').toBe(false);
  });

  it('fails the hook, without a worker to stop, when it finds no Runner.Worker above it', () => {
    // On the real runner this test sits under the real Runner.Worker, which the hook would find and end (PR 80, run
    // 39458745094). So the hook runs in a PID namespace with its own /proc, where only the wrapper is above it; the
    // wrapper reports whether this process is visible and how the hook ended, because it can only exit with a status.
    const inside = 'echo "visible=$([ -e "/proc/$OUTSIDE" ] && echo yes || echo no)"; bash -e "$HOOK"; status=$?; echo "hook-status=$status"; exit "$status"';
    const run = spawnSync('unshare', ['-Urpf', '--mount-proc', 'bash', '-c', inside], { encoding: 'utf8', env: { PATH: shared.env.PATH, HOOK: shared.hook, OUTSIDE: String(process.pid), GITHUB_EVENT_PATH: shared.event, GITHUB_REPOSITORY: FORK, GITHUB_EVENT_NAME: 'pull_request' } });
    expect(run.stdout, 'the hook did not run in its own PID namespace').toContain('visible=no');
    expect(run.stdout, 'the hook was ended by a signal').toMatch(/hook-status=1\n/);
    expect(run.status).not.toBe(0);
    expect(run.signal).toBe(null);
    expect(run.stderr).toMatch(/Runner\.Worker/);
  });

  it('says why it refused, and writes the reason to a file the next person can read', () => {
    const run = job(pullRequest(FORK), { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/7/merge' });
    expect(run.stderr + run.stdout).toMatch(/admission: denied.*head/is);
    expect(readFileSync(shared.log, 'utf8')).toMatch(/denied.*pull_request/);
  });

  it('and its policy carry no write bit for the runner user\'s group or others', () => {
    // provision installs both as root:root (tests/ci/pc1-vm-verify.test.ts reads the account each install used).
    for (const file of [shared.hook, shared.policy, shared.lib]) expect(statSync(file).mode & 0o022, file).toBe(0);
  });
});
