// GRS-158 CI failure (PR 80, run 39458745094): on the real runner the test step runs under the real Runner.Worker, and the
// admission hook ends the nearest Runner.Worker above it. admission-hook.test.ts gives every hook run a stand-in worker
// except one, which runs the hook with no worker above it to check it fails without killing anything; there the hook
// found the real one and ended the CI job in its test step. This runs the whole hook test file the way CI does, under an
// outer process named Runner.Worker that then goes on to its next step, and requires that process to survive.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const app = fileURLToPath(new URL('../..', import.meta.url));
const scratch: string[] = [];
afterAll(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

describe('the hook tests inside a runner job', () => {
  it('leave the Runner.Worker above them running, whatever process tree they sit in', () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'clearcase-ci-outer-')));
    scratch.push(dir);
    // The real job: Runner.Worker, then the step's shell, then the test run. A copy of bash stands in for the worker.
    const outer = path.join(dir, 'Runner.Worker');
    copyFileSync(spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim(), outer);
    const marks = path.join(dir, 'marks');
    const steps = `bun run --bun test tests/ci/admission-hook.test.ts >"$LOGFILE" 2>&1; echo "tests=$?" >>"$MARKS"; echo "next-step" >>"$MARKS"`;
    const run = spawnSync(outer, ['-c', steps], {
      cwd: app, encoding: 'utf8', timeout: 110_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: dir, MARKS: marks, LOGFILE: path.join(dir, 'inner.log') },
    });
    const marked = existsSync(marks) ? readFileSync(marks, 'utf8') : '';
    expect(run.signal, 'the worker was ended by the hook tests').toBe(null);
    expect(marked, 'the job did not reach its next step').toContain('next-step');
    expect(marked, 'the hook tests failed inside the job').toContain('tests=0');
  }, 120_000);
});
