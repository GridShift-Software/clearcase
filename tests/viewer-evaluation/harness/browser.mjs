// Browser plumbing for the evaluation: launch Playwright's installed Chrome for Testing, record every request that
// tries to leave the harness origin (and abort it), every dialog, popup and top-level navigation, and give checks a
// handle on the current renderer frame.
import { chromium } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function chromePath() {
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  const dirs = existsSync(base) ? readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort() : [];
  for (const d of dirs.reverse()) { const p = path.join(base, d, 'chrome-linux64', 'chrome'); if (existsSync(p)) return p; }
  throw new Error('no Playwright Chrome for Testing under ~/.cache/ms-playwright');
}

export const VIEWPORTS = {
  'desktop-1440x900': { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  'desktop-1024x768': { viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 },
  'mobile-390x844': { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36' },
};

export async function launch() {
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, env: { ...process.env, TMPDIR: '/tmp' }, args: ['--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-domain-reliability', '--no-pings', '--disable-features=PushMessaging,GCMChannelStatusRequest,MediaRouter,OptimizationHints,Translate'] });
  return browser;
}

/** One isolated context per viewport, with egress, dialog, popup and navigation monitors. */
export async function openShell(browser, origin, viewportName) {
  const context = await browser.newContext({ ...VIEWPORTS[viewportName], acceptDownloads: false, serviceWorkers: 'block' });
  const mon = { egress: [], dialogs: [], popups: [], topNavigations: [], console: [] };
  await context.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(origin + '/') || u.startsWith('blob:') || u.startsWith('data:')) return route.continue();
    mon.egress.push({ url: u.slice(0, 160), frame: route.request().frame()?.url().slice(0, 80) ?? null });
    return route.abort('blockedbyclient');
  });
  context.on('page', (p) => mon.popups.push(p.url()));
  const page = await context.newPage();
  page.on('dialog', (d) => { mon.dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  page.on('console', (m) => { if (m.type() === 'error') mon.console.push(m.text().slice(0, 200)); });
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) mon.topNavigations.push(f.url()); });
  await page.goto(`${origin}/shell.html`);
  await page.waitForFunction(() => document.body.dataset.shell === 'ready');
  mon.popups.length = 0;
  mon.topNavigations.length = 0;
  return { context, page, mon };
}

/** The live renderer frame (the shell's only iframe). */
export function rendererFrame(page) {
  return page.frames().filter((f) => !f.isDetached() && f.parentFrame() === page.mainFrame() && /\/r\/\w+\.html/.test(f.url())).at(-1) ?? null;
}
