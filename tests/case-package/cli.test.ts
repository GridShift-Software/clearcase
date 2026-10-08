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
});
