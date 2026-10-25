// Static validation of the journey's source: the acceptance entry must reach only the real system. These read the
// source text; they run nothing against any deployment.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = import.meta.dirname;
const src = (n: string) => readFileSync(path.join(dir, n), 'utf8');
const sources = readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'));
const ENTRY = ['run.ts', 'scenario.ts', 'config.ts', 'http.ts', 'session.ts', 'routes.ts', 'report.ts', 'readback.ts', 'judge.ts', 'html.ts', 'fixtures.ts', 'common.ts'];

describe('the acceptance entry reaches only the real system', () => {
  it('no production-path module imports the self-test world or its harness', () => {
    for (const n of ENTRY) expect(src(n), n).not.toMatch(/from '\.\/(world|harness)\.ts'|from "\.\/(world|harness)\.ts"/);
  });
  it('the command line passes the real fetch and offers no injection point', () => {
    const run = src('run.ts');
    expect(run).toMatch(/makeActor\(n, cfg\.base, [^)]*, fetch\)/);
    expect(run).not.toMatch(/process\.env\.\w*(?:FETCH|TRANSPORT|DOUBLE|MOCK|FAKE|STUB)/i);
    expect(run).not.toMatch(/import\(/);
  });
  it('no source mints, forges or logs a session: no sign-in call, no token header, no Authorization', () => {
    for (const n of ENTRY) {
      const s = src(n);
      expect(s, n).not.toMatch(/authorization['"]?\s*:/i);
      expect(s, n).not.toMatch(/\bsignIn\b|createSession|sign_in_tokens|\/v1\/sessions|testIdentity|clerk\.com|clerk\.accounts/i);
    }
  });
  it('the only cookie source is a supplied storage state', () => {
    expect(src('http.ts')).toContain('cookieHeader(session)');
    expect(src('http.ts')).not.toMatch(/set-cookie/i);
  });
  it('no test is skipped, todo, or only-ed anywhere in the directory', () => {
    for (const n of readdirSync(dir).filter((x) => x.endsWith('.test.ts'))) expect(src(n), n).not.toMatch(/\b(?:it|test|describe)\.(?:skip|todo|only|skipIf|runIf)\b|\bxit\(|\bxdescribe\(/);
  });
  it('a missing prerequisite exits non-zero: HOLD is 3 and is never routed to a pass', () => {
    const run = src('run.ts');
    expect(run).toMatch(/process\.exit\(3\)/);
    expect(run).not.toMatch(/hold\([^)]*\)[^;]*process\.exit\(0\)/);
    expect(src('config.ts')).not.toMatch(/process\.env|readFileSync|fetch\(/);
  });
  it('every request is sent with redirects not followed and a bounded body', () => {
    const http = src('http.ts');
    expect(http).toContain("redirect: 'manual'");
    expect(http).toContain('MAX_BODY');
  });
  it('the doc and the code agree on the environment variable names', () => {
    const doc = readFileSync(path.join(dir, '../../docs/acceptance/native-alpha-journey.md'), 'utf8');
    const used = new Set(sources.flatMap((n) => [...src(n).matchAll(/CLEARCASE_JOURNEY_[A-Z0-9_]+/g)].map((m) => m[0])));
    for (const name of used) expect(doc, name).toContain(name);
  });
});
