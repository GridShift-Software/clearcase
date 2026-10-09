// Safe rendering of untrusted narrative, the link policy, browser-safe module boundaries, and a
// headless Chromium proof (offline) that hostile narrative cannot execute while a control page does.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { classifyLink } from '../../src/lib/case-package/links.ts';
import { displayFilename, documentRoute, exportCell, isSafeAppHref, renderNarrative, safeExternalHref } from '../../src/lib/case-package/render.ts';
import { servePolicy } from '../../src/lib/case-package/media.ts';
import { cleanup, tempDir } from './fixtures/synth.ts';

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await cleanup(d); });

const RV = 'sha256:' + 'ab'.repeat(32);
const resolve = (ref: string, page: number | null) => (ref.startsWith('OD-') ? documentRoute(RV, ref, page) : null);
const tags = (html: string) => new Set([...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[1]!.toLowerCase()));

const MARK = (tag: string) => `document.body.setAttribute('data-pwned','${tag}')`;
export const HOSTILE: string[] = [
  `x <img src=x onerror="${MARK('img')}"> y`,
  `</p><script>${MARK('script')}</script>`,
  `[[OD-001" onmouseover="${MARK('attr')}]]`,
  `[click](javascript:${MARK('md')}) and <javascript:${MARK('auto')}>`,
  `<svg onload="${MARK('svg')}"></svg><math><mtext><img src=x onerror="${MARK('math')}"></mtext></math>`,
  `<iframe srcdoc="<script>parent.${MARK('frame')}</script>"></iframe>`,
  `<a href="javascript:${MARK('a')}">x</a><form action="javascript:${MARK('form')}"><button>go</button></form>`,
  `<style>@import url(http://evil.example/x.css)</style><meta http-equiv="refresh" content="0;url=javascript:${MARK('meta')}"><base href="http://evil.example/">`,
  `<object data="javascript:${MARK('object')}"></object><embed src="javascript:${MARK('embed')}">`,
  `[[OD-001]] [[OD-001#p3]] [[XD-017]] [[od-001]] [[OD-001#p0]] [[ OD-002 ]]`,
  `invoice\u202Efdp.exe\u200B and a tab\tand\r\nCRLF\n\nsecond paragraph &amp; &lt;b&gt;`,
  `{{constructor.constructor('${MARK('tpl')}')()}} \${${MARK('tpl2')}} <!-- <script>${MARK('comment')}</script> -->`,
];

describe('renderNarrative', () => {
  it('escapes everything and emits only p, br, a.cite and span.cite-broken', () => {
    for (const s of HOSTILE) {
      const html = renderNarrative(s, { resolveCitationHref: resolve });
      for (const t of tags(html)) expect(['p', 'br', 'a', 'span']).toContain(t);
      expect(html).not.toMatch(/<[^>]*\son[a-z]+=/i);
      for (const m of html.matchAll(/href="([^"]*)"/g)) expect(isSafeAppHref(m[1]!.replace(/&amp;/g, '&'))).toBe(true);
    }
  });

  it('links resolvable citations to app routes and shows the rest as broken', () => {
    const html = renderNarrative('See [[OD-001]], [[OD-001#p3]] and [[XD-017]].', { resolveCitationHref: resolve });
    expect(html).toBe(`<p>See <a class="cite" href="/v/sha256%3A${'ab'.repeat(32)}/doc/OD-001">OD-001</a>, <a class="cite" href="/v/sha256%3A${'ab'.repeat(32)}/doc/OD-001?page=3">OD-001 p.3</a> and <span class="cite-broken" title="Citation does not resolve">[[XD-017]]</span>.</p>`);
  });

  it('renders a citation as broken when the app returns an unsafe href', () => {
    for (const bad of ['javascript:alert(1)', '//evil.example/x', 'https://evil.example/', '/a/../b', '/a\\b', '/a b', '/%2e%2e/x', '/x"onclick="y', '']) {
      const html = renderNarrative('[[OD-001]]', { resolveCitationHref: () => bad });
      expect(html).toContain('cite-broken');
      expect(html).not.toContain('href');
    }
  });

  it('shows hidden characters visibly and keeps paragraphs and line breaks', () => {
    expect(renderNarrative('a\u202Eb\u200Bc\nd\r\n\r\ne', { resolveCitationHref: resolve })).toBe('<p>a⟨U+202E⟩b⟨U+200B⟩c<br>d</p><p>e</p>');
    expect(displayFilename('invoice\u202Efdp.exe')).toBe('invoice⟨U+202E⟩fdp.exe');
    expect([...displayFilename('x'.repeat(300))]).toHaveLength(120);
  });
});

describe('link policy', () => {
  it('rejects unsafe schemes after browser-equivalent normalisation', () => {
    for (const u of ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'java\tscript:x', 'java\nscript:x', '\u0000javascript:x', 'data:text/html,<script>', 'vbscript:x', 'file:///etc/passwd', 'blob:x', 'about:blank', 'view-source:x', 'ftp://x', 'wss://x']) {
      expect(classifyLink(u).kind, u).toBe('rejected');
      expect(safeExternalHref(u)).toBeNull();
    }
  });
  it('rejects protocol-relative, UNC, absolute, drive and traversing locators', () => {
    for (const u of ['//evil.example/x', '\\\\server\\share', '/etc/passwd', 'C:/x', 'C|/x', '../x', './a/%2e%2e/b', './a%2Fb', 'https://user:pw@example.invalid/']) expect(classifyLink(u).kind, u).toBe('rejected');
  });
  it('allows https and mailto as inert external links, http as text only and ./ locators as package paths', () => {
    expect(classifyLink('https://example.invalid/a?b=1')).toMatchObject({ kind: 'external', scheme: 'https' });
    expect(classifyLink('mailto:a@example.invalid')).toMatchObject({ kind: 'external', scheme: 'mailto' });
    expect(classifyLink('http://example.invalid/').kind).toBe('text-only');
    expect(classifyLink('tel:123').kind).toBe('text-only');
    expect(classifyLink('./DISCOVERY%20A/a%20b.pdf#page=2')).toEqual({ kind: 'package', path: 'DISCOVERY A/a b.pdf', directory: false, fragment: 'page=2' });
  });
  it('guards CSV exports against formula injection', () => {
    for (const s of ['=1+1', '+1', '-1', '@SUM(A1)', '\t=x']) expect(exportCell(s).startsWith("'")).toBe(true);
    expect(exportCell('plain')).toBe('plain');
  });
  it('never serves originals as active content', () => {
    expect(servePolicy('text/html', 'a.html').headers['Content-Type']).toBe('text/plain; charset=utf-8');
    expect(servePolicy('image/svg+xml', 'a.svg')).toMatchObject({ mode: 'download', headers: { 'Content-Type': 'application/octet-stream' } });
    expect(servePolicy('application/pdf', 'a.pdf', true).mode).toBe('download');
    expect(servePolicy('image/png', 'a.png').headers['Content-Security-Policy']).toContain('sandbox');
    expect(servePolicy('application/pdf', 'x"\r\nSet-Cookie: a.pdf').headers['Content-Disposition']).not.toMatch(/[\r\n]/);
    for (const t of ['text/html', 'image/svg+xml', 'application/xml', 'application/pdf', 'image/png', 'message/rfc822']) expect(servePolicy(t, 'f').headers['X-Content-Type-Options']).toBe('nosniff');
  });
});

describe('browser-safe modules', () => {
  it('browser.ts and everything it imports use no filesystem code or Node built-ins', async () => {
    const seen = new Set<string>();
    const visit = async (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = await readFile(file, 'utf8');
      for (const m of src.matchAll(/^\s*(?:import|export)\s[^'"]*from\s+'([^']+)'/gm)) {
        const spec = m[1]!;
        expect(spec.startsWith('.'), `${path.basename(file)} imports ${spec}`).toBe(true);
        await visit(path.resolve(path.dirname(file), spec));
      }
    };
    await visit(path.resolve('src/lib/case-package/browser.ts'));
    expect(seen.size).toBeGreaterThan(5);
    for (const f of seen) expect(await readFile(f, 'utf8')).not.toMatch(/['"]node:|['"](fs|path|crypto|zlib|os)['"]/);
  });
});

const CHROMIUM = process.env.CLEARCASE_CHROMIUM ?? path.join(os.homedir(), '.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell');

/** The <body ...> start tag of a dumped DOM: execution markers are attributes on it. */
const bodyTag = (dom: string): string => /<body[^>]*>/.exec(dom)?.[0] ?? '';

/** Dump the DOM of a local page in headless Chromium inside its own empty network namespace. */
function dumpDom(file: string, profile: string): string {
  const p = spawnSync('unshare', ['-rn', CHROMIUM, '--headless', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, '--allow-file-access-from-files', '--virtual-time-budget=3000', '--dump-dom', `file://${file}`], { encoding: 'utf8', timeout: 60_000 });
  if (p.status !== 0) throw new Error(`chromium exited ${p.status}: ${p.stderr}`);
  return p.stdout;
}

describe('hostile narrative in headless Chromium (offline)', () => {
  it('executes the control page and none of the rendered hostile narrative', async () => {
    expect(existsSync(CHROMIUM), `Chromium not found at ${CHROMIUM}; set CLEARCASE_CHROMIUM`).toBe(true);
    const version = spawnSync(CHROMIUM, ['--version'], { encoding: 'utf8' }).stdout.trim();
    console.log(`chromium: ${CHROMIUM} (${version})`);
    const dir = await tempDir('chromium');
    dirs.push(dir);

    // control: the same payloads inserted raw must execute, proving the probe can detect execution
    const raw = HOSTILE.map((s) => `<div>${s}</div>`).join('\n');
    await writeFile(path.join(dir, 'control.html'), `<!doctype html><html><body>${raw}<script>document.body.setAttribute('data-control','ran')</script></body></html>`);
    const control = dumpDom(path.join(dir, 'control.html'), path.join(dir, 'p1'));
    expect(bodyTag(control)).toContain('data-control="ran"');
    expect(bodyTag(control)).toMatch(/\sdata-pwned="/);

    // static: server-rendered output of renderNarrative, no script of our own
    const rendered = HOSTILE.map((s) => renderNarrative(s, { resolveCitationHref: resolve })).join('\n');
    await writeFile(path.join(dir, 'static.html'), `<!doctype html><html><body><div id="out">${rendered}</div></body></html>`);
    const stat = dumpDom(path.join(dir, 'static.html'), path.join(dir, 'p2'));
    expect(bodyTag(stat)).not.toMatch(/data-pwned/);
    expect(stat).toContain('<a class="cite" href="/v/sha256%3A');

    // dynamic: the browser bundle of browser.ts renders inside the page via innerHTML
    const entry = path.join(dir, 'entry.ts');
    await writeFile(entry, `import { renderNarrative, documentRoute } from '${path.resolve('src/lib/case-package/browser.ts')}';\n(globalThis as any).CC = { renderNarrative, documentRoute };\n`);
    const bundle = path.join(dir, 'bundle.js');
    const b = spawnSync(process.execPath, ['build', entry, '--target', 'browser', '--format', 'iife', '--outfile', bundle], { encoding: 'utf8' });
    expect(b.status, b.stderr).toBe(0);
    const js = await readFile(bundle, 'utf8');
    expect(js).not.toMatch(/require\(["']node:|from ["']node:/);
    const harness = `const H = ${JSON.stringify(HOSTILE).replace(/<\//g, '<\\/')};
      const out = document.getElementById('out');
      for (const s of H) out.insertAdjacentHTML('beforeend', CC.renderNarrative(s, { resolveCitationHref: (r, p) => r.startsWith('OD-') ? CC.documentRoute('${RV}', r, p) : null }));
      const bad = [...out.querySelectorAll('*')].filter((e) => !['P','BR','A','SPAN'].includes(e.tagName) || [...e.attributes].some((a) => !['class','href','title'].includes(a.name)));
      document.body.setAttribute('data-rendered', String(out.querySelectorAll('p').length));
      document.body.setAttribute('data-unexpected', String(bad.length));`;
    await writeFile(path.join(dir, 'dynamic.html'), `<!doctype html><html><body><div id="out"></div><script>${js.replace(/<\/script/gi, '<\\/script')}</script><script>${harness}</script></body></html>`);
    const dyn = dumpDom(path.join(dir, 'dynamic.html'), path.join(dir, 'p3'));
    expect(bodyTag(dyn)).toMatch(/data-rendered="(\d+)"/);
    expect(Number(/data-rendered="(\d+)"/.exec(dyn)![1])).toBeGreaterThan(10);
    expect(dyn).toContain('data-unexpected="0"');
    expect(bodyTag(dyn)).not.toMatch(/data-pwned/);
  });
});
