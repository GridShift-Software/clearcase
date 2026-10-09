import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderNarrative } from '../../../src/lib/case-package/render.ts';

it('detects execution in a raw control while hostile narratives stay inert in Chromium', async () => {
  const root = await mkdtemp(path.join(process.env.CLEARCASE_TEST_TMP ?? os.tmpdir(), 'cc23-browser-'));
  const chromium = process.env.CLEARCASE_CHROMIUM ?? path.join(os.homedir(), '.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell');
  const payloads = [
    '<img src=missing onerror="window.gateExecutions++">',
    '<svg onload="window.gateExecutions++"></svg>',
    '<script>window.gateExecutions++</script>',
    '<iframe srcdoc="<script>parent.gateExecutions++</script>"></iframe>',
    '[link](javascript:window.gateExecutions++)',
    '[[GT-001]]',
  ];
  const safe = payloads.map((text) => renderNarrative(text, { resolveCitationHref: () => 'javascript:window.gateExecutions++' })).join('');
  try {
    const observe = async (name: string, markup: string): Promise<unknown> => {
      const page = path.join(root, name + '.html');
      await writeFile(page, `<!doctype html><meta charset="utf-8"><script>window.gateExecutions=0;</script><div id="payload">${markup}</div><pre id="result"></pre><script>setTimeout(()=>{const nodes=[...document.querySelectorAll('#payload *')];document.getElementById('result').textContent=JSON.stringify({executed:window.gateExecutions>0,tags:nodes.map(n=>n.tagName),unsafeAttributes:nodes.flatMap(n=>[...n.attributes].map(a=>a.name)).filter(n=>n.startsWith('on')||n==='src'||n==='srcdoc')});},250);</script>`);
      const run = spawnSync(chromium, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + path.join(root, name + '-profile'), '--dump-dom', '--virtual-time-budget=1000', pathToFileURL(page).href], { encoding: 'utf8', timeout: 15_000 });
      expect(run.status).toBe(0);
      const match = /<pre id="result">([^<]+)<\/pre>/.exec(run.stdout);
      if (!match) throw new Error('Chromium did not produce the probe result');
      return JSON.parse(match[1]);
    };
    expect(await observe('control', payloads.slice(0, 4).join(''))).toMatchObject({ executed: true });
    expect(await observe('safe', safe)).toEqual({ executed: false, tags: ['P', 'P', 'P', 'P', 'P', 'P', 'SPAN'], unsafeAttributes: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
