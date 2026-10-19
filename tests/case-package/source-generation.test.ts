// GRS-24 F2: the conversion report records which workspace generation the converter detected (and the builder version
// where the source states one), so no package has to be told apart by its content. v5 adds nothing, so its package
// identity stays what json-workspace.test.ts pins. Every value below is invented.
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeUtf8Strict, parseStrictJson } from '../../src/lib/case-package/strict-json.ts';
import { convertV5 } from '../../src/lib/case-package/v5/adapter.ts';
import { cleanup, synthHtml, synthRoots, tempDir, writeCaseFolder } from './fixtures/synth.ts';

type J = Record<string, any>;
const roots: string[] = [];
afterAll(async () => { for (const r of roots) await cleanup(r); });

async function report(html: Uint8Array): Promise<J> {
  const root = await tempDir('source-generation');
  roots.push(root);
  const caseDir = path.join(root, 'case');
  await writeCaseFolder(caseDir);
  const res = await convertV5({ html, htmlName: 'workspace.html', caseFolder: caseDir, caseId: 'synthetic-generation' });
  expect(res.ok).toBe(true);
  return (parseStrictJson(decodeUtf8Strict(res.files!.get('datasets/conversion-report.json')!)) as J).data;
}

describe('the conversion report records the detected source generation', () => {
  it('names the newer builder\'s generation and its META.version', async () => {
    const r = synthRoots();
    r.META.version = 'V1';
    expect((await report(synthHtml(r))).source).toEqual({ generation: 'v5-js-newer', builderVersion: 'V1' });
  });

  it('names the JSON-script generation', async () => {
    const tag = `<script id="app-data" type="application/json">${JSON.stringify({ meta: { builtAt: '2002-06-07 08:09' } })}</script>`;
    const html = new TextEncoder().encode(['<!DOCTYPE html>', '<html><head><meta charset="utf-8"><title>Synthetic</title></head><body>', tag, '<script>', 'const NAV = [];', '</script>', '</body></html>', ''].join('\n'));
    expect((await report(html)).source).toEqual({ generation: 'json-script' });
  });

  it('adds nothing for v5, whose package bytes stay as they were', async () => {
    expect('source' in (await report(synthHtml(synthRoots())))).toBe(false);
  });
});
