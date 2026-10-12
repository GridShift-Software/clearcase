// CLI flags, reports and exit codes on a synthetic case.
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseStrictJson } from '../../src/lib/case-package/strict-json.ts';
import { cleanup, synthHtml, synthRoots, tempDir, writeCaseFolder } from './fixtures/synth.ts';

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await cleanup(d); });
const cli = (...args: string[]) => spawnSync(process.execPath, [path.resolve('scripts/case-package/cli.ts'), ...args], { encoding: 'utf8' });

describe('cli', () => {
  it('converts, validates, acknowledges and reports with the documented exit codes', async () => {
    const root = await tempDir('cli');
    dirs.push(root);
    const caseDir = path.join(root, 'case');
    await writeCaseFolder(caseDir);
    const html = path.join(root, 'workspace.html');
    await writeFile(html, synthHtml(synthRoots()));
    const before = (await readdir(caseDir, { recursive: true })).sort();
    const out = path.join(root, 'pkg');
    const report = path.join(root, 'report.json');

    const conv = cli('convert', '--html', html, '--case-folder', caseDir, '--case-id', 'synthetic-case', '--out', out, '--report', report);
    expect(conv.status, conv.stderr).toBe(0);
    expect(conv.stderr).toContain('verdict: report');
    const r = parseStrictJson(await (await import('node:fs/promises')).readFile(report, 'utf8')) as any;
    expect(r.caseId).toBe('synthetic-case');
    expect(r.resultsVersion).toMatch(/^sha256:/);
    expect(r.counts.V5_META_COUNT_DISAGREEMENT).toBe(2);

    expect(cli('validate', '--package', out, '--case-folder', caseDir).status).toBe(0);
    expect(cli('validate', '--package', out, '--case-folder', caseDir, '--activation-check').status).toBe(3);
    const ack = path.join(root, 'ack.json');
    expect(cli('acknowledge', '--report', report, '--out', ack).status).toBe(0);
    expect(cli('validate', '--package', out, '--case-folder', caseDir, '--activation-check', '--ack', ack).status).toBe(0);
    const baseline = path.join(root, 'baseline.json');
    await writeFile(baseline, JSON.stringify(r.warningFingerprints));
    expect(cli('validate', '--package', out, '--case-folder', caseDir, '--activation-check', '--baseline', baseline).status).toBe(0);

    // rejection: a package that fails validation, and HTML that is not a v5 workspace
    await writeFile(path.join(out, 'datasets', 'people.json'), '{}');
    expect(cli('validate', '--package', out, '--case-folder', caseDir).status).toBe(1);
    const bad = path.join(root, 'bad.html');
    await writeFile(bad, '<html>no data</html>');
    expect(cli('convert', '--html', bad, '--case-folder', caseDir, '--case-id', 'x', '--out', path.join(root, 'pkg2')).status).toBe(1);

    // usage and input errors
    expect(cli('convert', '--html', html).status).toBe(2);
    expect(cli('convert', '--html', html, '--case-folder', caseDir, '--case-id', 'Bad Id', '--out', path.join(root, 'p3')).status).toBe(2);
    expect(cli('convert', '--html', html, '--case-folder', caseDir, '--case-id', 'x', '--out', path.join(caseDir, 'inside')).status).toBe(2);
    await mkdir(path.join(root, 'full'));
    await writeFile(path.join(root, 'full', 'x'), '1');
    expect(cli('convert', '--html', html, '--case-folder', caseDir, '--case-id', 'x', '--out', path.join(root, 'full')).status).toBe(2);
    expect(cli('frobnicate').status).toBe(2);
    expect((await readdir(caseDir, { recursive: true })).sort()).toEqual(before);
  });

  it('answers each usage or input error with exit 2 and one stderr line naming it, never a stack trace', async () => {
    const root = await tempDir('cli-usage');
    dirs.push(root);
    const caseDir = path.join(root, 'case');
    await writeCaseFolder(caseDir);
    const html = path.join(root, 'workspace.html');
    await writeFile(html, synthHtml(synthRoots()));
    await writeFile(path.join(root, 'not-json.json'), 'not json');
    await writeFile(path.join(root, 'object.json'), '{}');
    const T = (p: string) => path.join(root, p);
    const cases: [string[], RegExp][] = [
      [[], /^error: usage: cli\.ts convert\|validate\|acknowledge \[flags\]$/],
      [['frobnicate'], /^error: usage: cli\.ts convert\|validate\|acknowledge \[flags\]$/],
      [['convert', '--bogus'], /^error: Unknown option '--bogus'/],
      [['convert', '--html', html], /^error: convert needs --html, --case-folder, --case-id and --out$/],
      [['convert', '--html', T('missing.html'), '--case-folder', caseDir, '--case-id', 'x', '--out', T('o1')], /^error: --html cannot be read$/],
      [['convert', '--html', html, '--case-folder', T('missing'), '--case-id', 'x', '--out', T('o2')], /^error: --case-folder is not a directory$/],
      [['convert', '--html', html, '--case-folder', caseDir, '--case-id', 'x', '--out', T('o3'), '--report', path.join(caseDir, 'r.json')], /^error: --report is inside the case folder; ClearCase never writes there$/],
      [['validate'], /^error: validate needs --package and --case-folder$/],
      [['validate', '--package', T('p'), '--case-folder', caseDir, '--baseline', T('missing.json')], /^error: --baseline \S+missing\.json cannot be read as JSON: ENOENT/],
      [['validate', '--package', T('p'), '--case-folder', caseDir, '--baseline', T('not-json.json')], /^error: --baseline \S+not-json\.json cannot be read as JSON: /],
      [['validate', '--package', T('p'), '--case-folder', caseDir, '--baseline', T('object.json')], /^error: --baseline must be a JSON array of fingerprints$/],
      [['acknowledge', '--report', T('r.json')], /^error: acknowledge needs --report and --out$/],
      [['acknowledge', '--report', T('missing.json'), '--out', T('ack.json')], /^error: --report \S+missing\.json cannot be read as JSON: ENOENT/],
      [['acknowledge', '--report', T('not-json.json'), '--out', T('ack.json')], /^error: --report \S+not-json\.json cannot be read as JSON: /],
    ];
    for (const [args, stderr] of cases) {
      const r = cli(...args);
      const shown = `bun scripts/case-package/cli.ts ${args.join(' ')}\nexpected exit 2 and stderr ${stderr}\ngot exit ${r.status} (signal ${r.signal}), stderr:\n${r.stderr}`;
      expect(r.status, shown).toBe(2);
      expect(r.stderr.trimEnd().split('\n'), shown).toHaveLength(1);
      expect(r.stderr.trimEnd(), shown).toMatch(stderr);
    }
  });
});
