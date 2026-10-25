import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const readerPath = 'src/lib/viewer/hosted/static/pdf-reader.mjs';
const reader = readFileSync(join(repo, readerPath), 'utf8');
let scratch: string | undefined;
afterEach(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });
function check(file: string, bytes: string, extra: Record<string, string> = {}) {
  scratch = mkdtempSync(join(tmpdir(), 'cc-reader-source-'));
  const files = { 'run.sh': 'true\n', 'tool.py': 'print(1)\n', '.github/workflows/ci.yml': 'jobs:\n  check:\n    steps:\n      - uses: actions/checkout@' + 'a'.repeat(40) + '\n', [file]: bytes, ...extra };
  for (const [path, contents] of Object.entries(files)) { const dest = join(scratch, path); mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, contents); }
  for (const args of [['init', '-q'], ['add', '-A']]) expect(spawnSync('git', args, { cwd: scratch }).status).toBe(0);
  return spawnSync('bun', [join(repo, 'scripts/ci/source-check.ts')], { cwd: scratch, encoding: 'utf8' });
}
describe('reviewed reader source import exception', () => {
  it('permits only the exact reviewed path and bytes', () => { const r = check(readerPath, reader); expect(r.status, r.stdout + r.stderr).toBe(0); });
  it('refuses identical bytes at another path', () => { const r = check('other/pdf-reader.mjs', reader); expect(r.status).toBe(1); expect(r.stdout).toContain('not a tracked file'); });
  it.each(['\n', '\nimport "./missing.mjs";\n', '\nconst invalid = ;\n'])('refuses modified reader bytes %j', extra => {
    const r = check(readerPath, reader + extra); expect(r.status).toBe(1); expect(r.stdout).toContain('reviewed PDF reader bytes mismatch');
    if (extra.includes('missing')) expect(r.stdout).toContain('imports ./missing.mjs');
    if (extra.includes('invalid')) expect(r.stdout).toContain('[js-syntax]');
  });
  it('does not waive other JS imports beside a valid reader', () => {
    const r = check(readerPath, reader, { 'other.mjs': 'import "./absent.js";' });
    expect(r.status).toBe(1); expect(r.stdout).toContain('imports ./absent.js');
  });
});
