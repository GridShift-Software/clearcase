import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { rcloneRemote } from '../../../scripts/publish/upload.ts';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'cc-rclone-report-'));
  await writeFile(path.join(root, 'rclone'), '#!/bin/sh\nprintf "%s\\n" "$RCLONE_REPORT"\nexit "$RCLONE_STATUS"\n');
  await chmod(path.join(root, 'rclone'), 0o700);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => rm(root, { recursive: true, force: true }));

// Exercise the real subprocess/report boundary; the executable emits only synthetic rclone protocol output.
function compare(report: string, status: number) {
  vi.stubEnv('PATH', root + path.delimiter + process.env.PATH);
  vi.stubEnv('RCLONE_REPORT', report);
  vi.stubEnv('RCLONE_STATUS', String(status));
  return rcloneRemote({ remote: 'synthetic:bucket', resultsVersion: `sha256:${'a'.repeat(64)}` }).compare(root, ['view/synthetic.json']);
}

test.each([
  ['+', 'absent', 1], ['*', 'differs', 1], ['=', 'same', 0],
] as const)('rclone %s maps to %s', async (symbol, state, status) => {
  expect(await compare(`${symbol} view/synthetic.json`, status)).toEqual(new Map([['view/synthetic.json', state]]));
});
test('rclone - means missing source, never permission to create a destination object', async () => {
  await expect(compare('- view/synthetic.json', 1)).rejects.toThrow('source');
});
test('rclone ! is a comparison error', async () => {
  await expect(compare('! view/synthetic.json', 1)).rejects.toThrow('could not compare');
});
