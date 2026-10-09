import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

it.each([true, false])('does not read an outside directory during folded lookup (matching name present: %s)', async (present) => {
  const root = await mkdtemp(path.join(process.env.CLEARCASE_TEST_TMP ?? os.tmpdir(), 'cc23-containment-'));
  const caseFolder = path.join(root, 'case');
  const outside = path.join(root, 'outside');
  try {
    await mkdir(caseFolder);
    await mkdir(outside);
    await symlink(outside, path.join(caseFolder, 'linked'));
    if (present) await writeFile(path.join(outside, 'Secret.PDF'), '%PDF-1.4\n% invented containment original\n%%EOF\n');
    const watcher = fileURLToPath(new URL('./watch-directory.py', import.meta.url));
    const probe = fileURLToPath(new URL('./containment-probe.ts', import.meta.url));
    const run = spawnSync('python3', [watcher, outside, probe, caseFolder], { encoding: 'utf8', timeout: 20_000 });
    expect(run.status, run.stderr).toBe(0);
    const observed = JSON.parse(run.stdout) as { result: { verdict: string; counts: Record<string, number>; candidate: boolean }; outsideDirectoryReads: string[] };
    expect(observed.outsideDirectoryReads).toEqual([]);
    expect(observed.result).toMatchObject({ verdict: 'reject', counts: { ORIG_ESCAPE: 1 }, candidate: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
