import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { localLoad } from '../../../scripts/publish/local-loader.ts';
import { buildCase } from '../../e2e/pilot/lib/fixtures.ts';
import { cleanup, service, tempRoot } from '../../../src/lib/local-case/test-support.ts';

const root = await tempRoot('local-loader-13');
const lc = service(path.join(root, 'store'));
await lc.startup();
const fixture = await buildCase(path.join(root, 'case'), { caseId: 'adapter-test' });
await lc.importPackage(fixture.caseDir, fixture.pkgDir);
const ctx = { store: lc.store, resultsVersion: fixture.resultsVersion };
afterAll(async () => { await lc.shutdown(); await cleanup(root); });

test('unchanged matter and people loaders read the imported store and restore the app seam', async () => {
  const g = globalThis as { __clearcase?: unknown };
  const previous = g.__clearcase;
  const matter = await localLoad(ctx, 'analysis/matter');
  const people = await localLoad(ctx, 'evidence/people');
  if (!matter || !people) throw new Error('Missing loader output');
  expect(matter.matter).toBeTruthy();
  expect(people.people).toEqual(expect.arrayContaining([expect.any(Object)]));
  expect(g.__clearcase).toBe(previous);
  await expect(localLoad(ctx, 'analysis/not-a-view')).rejects.toThrow();
  expect(g.__clearcase).toBe(previous);
});

test('Bun resolves $lib and extensionless server imports for both routes', () => {
  const output = execFileSync('bun', ['-e', `
    import { localLoad } from './scripts/publish/local-loader.ts';
    import { service } from './src/lib/local-case/test-support.ts';
    const lc = service(${JSON.stringify(path.join(root, 'bun-store'))});
    await lc.startup();
    await lc.importPackage(${JSON.stringify(fixture.caseDir)}, ${JSON.stringify(fixture.pkgDir)});
    try {
      const ctx = { store: lc.store, resultsVersion: ${JSON.stringify(fixture.resultsVersion)} };
      const m = await localLoad(ctx, 'analysis/matter');
      const p = await localLoad(ctx, 'evidence/people');
      const nested = await localLoad(ctx, 'litigation/elements_tab');
      let outsideRejected = false;
      try { await import(new URL('./src/routes/v/[vid]/litigation/legality_tab/+page.server.ts', 'file://' + process.cwd() + '/').href); } catch { outsideRejected = true; }
      console.log(JSON.stringify([!!m.matter, Array.isArray(p.people) && p.people.length > 0, Array.isArray(nested.elements), outsideRejected]));
    } finally { await lc.shutdown(); }
  `], { cwd: process.cwd(), encoding: 'utf8' });
  expect(JSON.parse(output.trim().split('\n').at(-1)!)).toEqual([true, true, true, true]);
});
