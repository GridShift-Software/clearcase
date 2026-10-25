// The command line's refusals, run as a real child process with a scrubbed environment. No request is ever made: every
// case here stops before the network, which is the point (a missing prerequisite is a HOLD with a non-zero exit).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [path.join(import.meta.dirname, 'run.ts'), ...args], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 60_000 });

describe('run.ts without its prerequisites', () => {
  it.each([['upload-import'], ['signoff-publish'], ['after-restart']])('%s with an empty environment is a HOLD (exit 3), naming what is missing, sending nothing', (phase) => {
    const r = run([phase]);
    expect(r.status).toBe(3);
    expect(r.stdout).toContain('"verdict": "HOLD"');
    expect(r.stdout).toContain('CLEARCASE_JOURNEY_BASE_URL is not set');
    expect(r.stdout).toContain('nothing was sent');
  });
  it('verify with nothing produced is a HOLD, never a pass', () => {
    const r = run(['verify'], { CLEARCASE_JOURNEY_EXPECTED_SHA: 'a'.repeat(40), CLEARCASE_JOURNEY_OUT: '/nonexistent/journey-out' });
    expect(r.status).toBe(3);
    expect(r.stdout).not.toContain('JOURNEY PASS');
  });
  it('an unknown command, an extra argument and no command are usage errors (exit 2)', () => {
    for (const args of [['bogus'], ['upload-import', 'extra'], []]) expect(run(args).status).toBe(2);
  });
  it('a plain-http origin is a HOLD even with every other variable present', () => {
    const r = run(['upload-import'], { CLEARCASE_JOURNEY_BASE_URL: 'http://native.example.invalid' });
    expect(r.status).toBe(3);
    expect(r.stdout).toContain('must be https');
  });
});
