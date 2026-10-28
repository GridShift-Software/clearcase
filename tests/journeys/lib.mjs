import { chromium, request as playwrightRequest } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(ROOT, '../..');
export const MODE = process.env.MODE || 'local';
export const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:41195').replace(/\/$/, '');
export const OUT = path.resolve(process.env.RESULTS_DIR || path.join(REPO, '.local/journeys/results'));
const env = name => (process.env[name] || '').trim();
// The sign-in budget is a setting (GRS-267): 5000 on a production Clerk instance (the release-candidate gate); the shared
// development instance is run with SIGN_IN_MS=8000, the accepted interim (docs/sprint/runbooks/09c-clerk-instance.md).
const budgetMs = (name, fallback) => {
  if (!env(name)) return fallback;
  const value = Number(env(name));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive whole number of milliseconds`);
  return value;
};
export const PAGE_MS = 2000, PDF_MS = 3000, SIGN_IN_MS = budgetMs('SIGN_IN_MS', 5000);
// GRS-269: Clerk's Device Trust asks for an email code whenever a password sign-in comes from a browser it has not seen, and every
// journey starts a fresh browser. Unset (or "fresh") is that behaviour. "returning" signs in once untimed to enrol the device,
// signs out of the app, and times a second sign-in in the same context against the same SIGN_IN_MS.
export const SIGN_IN_DEVICE = env('SIGN_IN_DEVICE') || 'fresh';
const bytesOf = name => (env(name) ? Number(env(name)) : null);
// No case value is committed: the three PDF samples (a small, a medium and the largest original of the case under test)
// come from the environment. The byte sizes and the bundle (group) names are optional; a size is checked when given.
export const samples = [
  { band: 'small', ref: env('SMALL_REF'), bytes: bytesOf('SMALL_BYTES'), bundle: env('SMALL_BUNDLE') },
  { band: 'medium', ref: env('MEDIUM_REF'), bytes: bytesOf('MEDIUM_BYTES'), bundle: env('MEDIUM_BUNDLE') },
  { band: 'largest', ref: env('LARGE_REF'), bytes: bytesOf('LARGE_BYTES'), bundle: env('LARGE_BUNDLE') },
];
export const NEEDS = { samples: ['SMALL_REF', 'MEDIUM_REF', 'LARGE_REF'], small: ['SMALL_REF'], documents: ['EXPECTED_DOCUMENTS'] };
const NEED_WHAT = { EXPECTED_DOCUMENTS: 'the Overview document count of the case under test, a positive integer' };
/** What stops a run before any browser starts, as messages; empty when the environment can run `needs`. */
export function preflightProblems(needs = []) {
  const problems = [];
  if (!['local', 'hosted'].includes(MODE)) problems.push('MODE must be local or hosted');
  if (!['fresh', 'returning'].includes(SIGN_IN_DEVICE)) problems.push('SIGN_IN_DEVICE must be fresh (the default) or returning');
  else if (SIGN_IN_DEVICE === 'returning' && (MODE !== 'hosted' || !process.env.CREDENTIALS_JSON)) problems.push('SIGN_IN_DEVICE=returning needs MODE=hosted and CREDENTIALS_JSON; without a sign-in there is nothing to time');
  if (MODE === 'hosted') {
    if (!env('EXPECTED_SHA')) problems.push('MODE=hosted needs EXPECTED_SHA, the deployed build revision that /health must report; refusing to run against an unidentified deployment');
    if (!env('CASE_ID')) problems.push('MODE=hosted needs CASE_ID');
    if (!/^https?:\/\//.test(process.env.BASE_URL || '')) problems.push('MODE=hosted needs BASE_URL, the staging or preview origin');
  }
  for (const name of needs) if (!env(name)) problems.push(`${name} is required (${NEED_WHAT[name] || 'the reference of a document of the case under test'})`);
  if (needs.includes('EXPECTED_DOCUMENTS') && env('EXPECTED_DOCUMENTS') && !/^[1-9]\d*$/.test(env('EXPECTED_DOCUMENTS'))) problems.push(`EXPECTED_DOCUMENTS must be a positive integer`);
  if (env('CLEARCASE_BROWSER_LOCK') !== 'none' && !process.env.CLEARCASE_BROWSER_SLOT) problems.push('run under the browser lock (orch-bin/browser-lock, or the path in CLEARCASE_BROWSER_LOCK), or set CLEARCASE_BROWSER_LOCK=none where no workspace lock exists; docs/development.md "Browser admission"');
  return problems;
}
export function refuse(problems) {
  console.error(`journeys: refusing to run\n${problems.map(p => `  - ${p}`).join('\n')}`);
  process.exitCode = 2;
}
export function check(ok, message) { if (!ok) throw new Error(message); }
export function route(rv, suffix = 'overview', caseId = process.env.CASE_ID) {
  check(['local', 'hosted'].includes(MODE), 'MODE must be local or hosted');
  check(rv, 'RESULTS_VERSION or a discoverable published version is required');
  check(MODE === 'local' || caseId, 'CASE_ID is required for hosted');
  return `${BASE_URL}${MODE === 'hosted' ? `/cases/${encodeURIComponent(caseId)}` : ''}/v/${encodeURIComponent(rv)}/${suffix}`;
}
/**
 * Every element the selector contract matches for `name`: the `data-testid` hook when the page has one, otherwise the
 * local fallback. A plain union would follow DOM order, so a hidden legacy control placed before the hooked one would
 * win; the fallback is therefore only allowed while no element on the page carries the hook.
 */
export function hookAll(page, name, fallback) {
  const testid = `[data-testid="${name}"]`;
  return page.locator(fallback ? `${testid}, :root:not(:has(${testid})) :is(${fallback})` : testid);
}
export function hook(page, name, fallback) {
  return hookAll(page, name, fallback).first();
}
export const paint = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
export async function ready(page, id) {
  const main = page.locator(`main[data-ready="${id}"]`);
  await main.waitFor({ state: 'visible' });
  await main.getByRole('heading', { level: 1 }).first().waitFor();
  check(!await main.getByText(/^(Coming soon|Internal Error|Not Found|Hosted runtime is unavailable)$/i).count(), 'Error or placeholder instead of view');
}
export async function firstPDF(page, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    for (const frame of page.frames()) {
      const rendered = await frame.evaluate(() => {
        const marked = document.querySelector('[data-testid="pdf-page"][data-page-number="1"][data-rendered="true"]');
        const canvas = document.querySelector('canvas');
        const legacy = window.__viewer?.rendered >= 1;
        return !!(marked || (legacy && canvas?.width > 0 && canvas?.height > 0));
      }).catch(() => false);
      if (rendered) return;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('First PDF page did not complete rendering');
}
function capture(context) {
  const stats = { requests: 0, responses: 0, http4xx: 0, http5xx: 0, status401: 0, status503: 0, ranges206: 0, failedRequests: 0, abortedRequests: 0, pageErrors: 0, errors: [], failures: [] };
  context.on('request', () => stats.requests++);
  context.on('response', response => {
    const s = response.status(); stats.responses++;
    if (s === 206) stats.ranges206++;
    if (s === 401) stats.status401++;
    if (s === 503) stats.status503++;
    if (s >= 400 && s < 500) stats.http4xx++;
    if (s >= 500) stats.http5xx++;
    if (s >= 400) stats.errors.push({ status: s, resourceType: response.request().resourceType() });
  });
  context.on('requestfailed', request => {
    if (request.failure()?.errorText.includes('ERR_ABORTED')) stats.abortedRequests++;
    else { stats.failedRequests++; stats.failures.push({ protocol: new URL(request.url()).protocol, resourceType: request.resourceType(), error: request.failure()?.errorText }); }
  });
  context.on('page', page => page.on('pageerror', () => stats.pageErrors++));
  return stats;
}
// A sign-in failure whose message is safe to show: it names a step, never a URL, value or Playwright stack.
class SignInError extends Error {}
const SIGN_IN_DEADLINE_MS = 60000;
// One password sign-in, timed as the step `name` against `budget` (null: information only). Returns whether Clerk asked for the code.
async function signIn(j, { name = 'sign-in', budget = SIGN_IN_MS } = {}) {
  let codeStep = false;
  // No secret values, URLs, headers, DOM snapshots or Playwright exception stacks are logged.
  let credentials;
  try { credentials = JSON.parse(await fs.readFile(process.env.CREDENTIALS_JSON, 'utf8')); }
  catch { throw new Error('Unable to read credentials JSON'); }
  // Clerk issues the sign-in code on a second-factor prepare call that starts after the previous step is submitted; a code typed
  // before that call has answered is refused with a 400. So each prepare call is tracked, and the code is typed once the one
  // started after the last pre-code submit has succeeded. A failed call fails the sign-in, it never types the code anyway.
  const prepares = [];
  const onRequest = request => { if (/\/prepare_second_factor(\?|$)/.test(request.url())) prepares.push({ request, startedAt: performance.now(), done: false, ok: false }); };
  const onResponse = response => { const p = prepares.find(x => x.request === response.request()); if (p) { p.done = true; p.ok = response.ok(); } };
  const onFailed = request => { const p = prepares.find(x => x.request === request); if (p) p.done = true; };
  j.page.on('request', onRequest); j.page.on('response', onResponse); j.page.on('requestfailed', onFailed);
  await j.measure(name, async () => {
    // One deadline bounds the whole sign-in: navigation, every wait, and the final paint.
    const deadline = Date.now() + SIGN_IN_DEADLINE_MS;
    const remaining = () => Math.max(1, deadline - Date.now());
    const left = () => Math.min(5000, remaining());
    const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, remaining())));
    const quietly = p => p.catch(() => false);
    try {
      await j.page.goto(`${BASE_URL}${process.env.SIGN_IN_PATH || '/sign-in'}`, { waitUntil: 'domcontentloaded', timeout: remaining() });
      // Clerk's hosted flow restarts if its button is clicked again mid-step, and a step can take several seconds on the
      // development instance. So after a click the pass waits, as long as the deadline allows, until the app is ready, a field
      // that was not visible at the click is visible (the next step), or Clerk shows a new error; only then does the next
      // pass fill and click again. A click that did not happen (control missing or detached mid-render) is retried at once.
      const app = new URL(BASE_URL).origin;
      const marker = j.page.locator('[data-auth-state="signed-in"], a[data-action="open-case"], nav[aria-label="Case views"]').first();
      const ready = async () => { const u = new URL(j.page.url()); return u.origin === app && !u.pathname.startsWith('/sign-in') && await quietly(marker.isVisible()); };
      const email = j.page.locator('input[name="identifier"],input[type="email"]').first();
      const password = j.page.locator('input[type="password"]').first();
      const code = j.page.locator('input[autocomplete="one-time-code"]').first();
      const errors = j.page.locator('[class*="ErrorText"]');
      const shown = async () => ({ email: await quietly(email.isVisible()), password: await quietly(password.isVisible()), code: await quietly(code.isVisible()) });
      const errorText = async () => { try { return (await errors.allInnerTexts()).join('|'); } catch { return ''; } };
      const nextStep = async before => { const now = await shown(); return (now.email && !before.email) || (now.password && !before.password) || (now.code && !before.code); };
      let lastSubmit = performance.now();
      const codeSent = async () => {
        while (Date.now() < deadline) {
          const p = prepares.filter(x => x.startedAt >= lastSubmit).at(-1);
          if (p?.done) { if (p.ok) return; throw new SignInError('Hosted sign-in failed: Clerk could not send the sign-in code'); }
          await sleep(25);
        }
        throw new SignInError('Hosted sign-in failed: Clerk did not send the sign-in code before the deadline');
      };
      const signedIn = async () => {
        while (Date.now() < deadline) {
          if (await ready()) return;
          if (await quietly(email.isVisible()) && await quietly(email.isEditable())) await quietly(email.fill(credentials.email, { timeout: left() }));
          if (await quietly(password.isVisible()) && await quietly(password.isEditable())) await quietly(password.fill(credentials.password, { timeout: left() }));
          const atCode = await quietly(code.isVisible());
          let typed = false;
          if (atCode) {
            codeStep = true;
            if (!credentials.otp) throw new SignInError('Hosted sign-in failed: the sign-in code is needed but the credentials hold none');
            await codeSent();
            // typed key by key, which Clerk's code boxes take (a single fill leaves them empty); the last digit submits the step
            typed = await code.pressSequentially(credentials.otp, { timeout: left() }).then(() => true, () => false);
          }
          const submit = j.page.getByRole('button', { name: /^(Continue|Sign in|Sign in to ClearCase)$/i }).first();
          const before = await shown(), errorBefore = await errorText();
          let clicked = typed;
          if (!atCode && await quietly(submit.isVisible()) && await quietly(submit.isEnabled())) {
            lastSubmit = performance.now();
            clicked = await submit.click({ timeout: left() }).then(() => true, () => false);
          }
          if (!clicked) { await sleep(100); continue; }
          while (Date.now() < deadline && !(await ready()) && !(await nextStep(before)) && (await errorText()) === errorBefore) await sleep(25);
        }
        throw new SignInError('Hosted sign-in failed: the sign-in did not finish before the deadline');
      };
      await signedIn();
      // the paint is part of the measured time and of the deadline
      let timer;
      await Promise.race([paint(j.page), new Promise((_, reject) => { timer = setTimeout(() => reject(new SignInError('Hosted sign-in failed: no paint before the deadline')), remaining()); })]).finally(() => clearTimeout(timer));
    } catch (error) { throw error instanceof SignInError ? error : new Error('Hosted sign-in failed; inspect authentication privately'); }
  }, async () => {}, budget).finally(() => { j.page.off('request', onRequest); j.page.off('response', onResponse); j.page.off('requestfailed', onFailed); });
  return codeStep;
}
// The app's own sign-out, then proof the app session is gone: /cases answers 401 to the context's cookies, read through a separate
// request context so the expected 401 is not counted as a network error of the journey. Clerk's device cookies stay in the context.
async function signOutOfApp(j) {
  // the hosted app's own sign-out is the control of its case list, a POST to /sign-out
  const out = hook(j.page, 'sign-out', '#sign-out');
  await j.page.goto(`${BASE_URL}/cases`, { waitUntil: 'domcontentloaded' });
  await out.waitFor({ state: 'visible', timeout: 15000 }).catch(() => { throw new Error('Returning-device sign-in failed: no sign-out control on the case list'); });
  await out.click();
  await out.waitFor({ state: 'detached', timeout: 30000 }); // the POST navigated away from the case list
  const api = await playwrightRequest.newContext({ storageState: await j.context.storageState() });
  try {
    const response = await api.get(`${BASE_URL}/cases`, { maxRedirects: 0, failOnStatusCode: false });
    check(response.status() === 401, `Returning-device sign-in failed: /cases answered ${response.status()} after sign-out, expected 401`);
  } finally { await api.dispose(); }
}
// The timed sign-in of a journey. Returning: the enrol pass (no budget) and the sign-out come first, so the timed step is the second sign-in.
async function signInSteps(j) {
  if (MODE !== 'hosted' || !process.env.CREDENTIALS_JSON) return;
  const record = (name, deviceCodeStep) => Object.assign(j.results.findLast(x => x.name === name), { deviceCodeStep });
  if (SIGN_IN_DEVICE === 'returning') {
    record('sign-in-enrol', await signIn(j, { name: 'sign-in-enrol', budget: null }));
    await signOutOfApp(j);
    record('sign-in', await signIn(j));
  } else await signIn(j);
}
export async function createJourney(id) {
  const problems = preflightProblems();
  check(!problems.length, problems[0]);
  await fs.mkdir(OUT, { recursive: true });
  // CHROMIUM_PATH overrides the pinned browser; when that is absent too, Playwright's own Chromium is used.
  const pinned = path.join(os.homedir(), '.cache/ms-playwright/chromium-1223/chrome-linux64/chrome');
  const executablePath = process.env.CHROMIUM_PATH || (existsSync(pinned) ? pinned : undefined);
  const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true, args: ['--host-resolver-rules=MAP clearcase-originals.localhost 127.0.0.1'] });
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, ...(process.env.STORAGE_STATE ? { storageState: process.env.STORAGE_STATE } : {}) });
    if (MODE === 'local') await context.route('**/*', r => {
      const u = new URL(r.request().url());
      return ['127.0.0.1', 'localhost', 'clearcase-originals.localhost'].includes(u.hostname) || ['data:', 'blob:', 'chrome-extension:', 'chrome:'].includes(u.protocol) ? r.continue() : r.abort('blockedbyclient');
    });
    const network = capture(context);
    const page = await context.newPage(); page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(30000);
    const j = { id, browser, context, page, rv: process.env.RESULTS_VERSION, network, results: [], startedAt: new Date().toISOString(), metadata: { mode: MODE, baseURL: BASE_URL, chromium: browser.version(), sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(), signIn: MODE === 'hosted' && process.env.CREDENTIALS_JSON ? 'requested' : 'not-tested', runId: process.env.RUN_ID || `${Date.now()}`, signInDevice: SIGN_IN_DEVICE } };
    j.measure = async (name, action, target = async () => {}, budgetMs = PAGE_MS, targetPage = page) => {
      const start = performance.now();
      try {
        const value = await action(); await target(value); await paint(typeof targetPage === 'function' ? targetPage() : targetPage);
        const ms = Math.round(performance.now() - start);
        j.results.push({ name, status: budgetMs !== null && ms >= budgetMs ? 'FAIL' : 'PASS', ms, budgetMs, ...(budgetMs !== null && ms >= budgetMs ? { reason: 'Latency budget exceeded' } : {}) });
        return value;
      } catch (error) {
        j.results.push({ name, status: 'FAIL', ms: Math.round(performance.now() - start), budgetMs, reason: error.name === 'TimeoutError' ? 'Target not ready before timeout' : error.message.split('\n')[0] });
        throw error;
      }
    };
    j.attempt = async (name, fn) => { try { await fn(); } catch (e) { if (!j.results.some(x => x.name === name && x.status === 'FAIL')) j.results.push({ name, status: 'FAIL', reason: e.name === 'TimeoutError' ? 'Required control/content missing' : e.message.split('\n')[0] }); } };
    j.url = suffix => route(j.rv, suffix);
    j.go = async (suffix, view, label = view) => j.measure(label, () => page.goto(j.url(suffix), { waitUntil: 'domcontentloaded' }), () => ready(page, view));
    j.nav = async id => j.measure(id, () => page.locator(`nav [data-view="${id}"]`).click(), () => ready(page, id));
    j.writeAllowed = () => {
      check(process.env.READ_ONLY !== '1', 'Write journey blocked by READ_ONLY=1');
      // Writes add synthetic notes, deadlines and bundles. When the driver names the data directory it expects
      // (CLEARCASE_DATA_DIR, as the app was started with), a different instance is refused.
      if (MODE === 'local' && env('CLEARCASE_DATA_DIR')) check(path.resolve(env('CLEARCASE_DATA_DIR')) === path.resolve(j.metadata.dataDir || ''), 'Refusing writes: the running app uses a different data directory than CLEARCASE_DATA_DIR');
    };
    j.saveNote = async label => {
      j.writeAllowed();
      const text = `Journey ${id} ${j.metadata.runId} ${Date.now()}`;
      await hook(page, 'note-body', '#note-body').fill(text);
      await j.measure(label, () => hook(page, 'note-add', '#note-add').click(), () => page.getByText(text, { exact: true }).waitFor());
      return text;
    };
    j.download = async (label, control, filename) => {
      let saved;
      await j.measure(label, async () => {
        const waiting = page.waitForEvent('download'); await control.click(); const dl = await waiting;
        check(!await dl.failure(), 'Download failed'); saved = path.join(OUT, filename); await dl.saveAs(saved);
      });
      return saved;
    };
    if (MODE === 'local') {
      const health = await context.request.get(`${BASE_URL}/api/health`);
      check(health.ok(), 'Local health endpoint failed');
      const h = await health.json();
      j.metadata.build = h.instance?.build; j.metadata.dataDir = h.instance?.dataDir;
      check(j.metadata.build?.revision === j.metadata.sourceSha, 'Local build revision differs from HEAD');
    } else {
      check(process.env.EXPECTED_SHA, 'EXPECTED_SHA required to identify the staging deployment');
      const health = await context.request.get(`${BASE_URL}/health`);
      check(health.ok(), 'Hosted health endpoint failed');
      const h = await health.json(); j.metadata.build = h.build;
      check(h.build?.revision === process.env.EXPECTED_SHA, 'Hosted build differs from EXPECTED_SHA');
    }
    await signInSteps(j);
    if (!j.rv) {
      await page.goto(`${BASE_URL}${MODE === 'hosted' ? `/cases/${encodeURIComponent(process.env.CASE_ID || '')}` : '/cases'}`, { waitUntil: 'domcontentloaded' });
      const link = page.locator('a[href*="/v/"][href$="/overview"]').first(); await link.waitFor();
      j.rv = decodeURIComponent((await link.getAttribute('href')).match(/\/v\/([^/]+)\//)[1]);
    }
    return j;
  } catch (error) { await browser.close(); throw error; }
}
async function record(id, result) {
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, `${id}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
/**
 * Runs one journey. `needs` names the environment variables it cannot run without. `writes: 'all'` marks a journey that
 * only writes (J7 to J9): under READ_ONLY=1 it is SKIPPED, never run and never reported as passed.
 */
export async function run(id, work, { needs = [], writes = null } = {}) {
  const problems = preflightProblems(needs);
  if (problems.length) { refuse(problems); return null; }
  if (writes === 'all' && process.env.READ_ONLY === '1') {
    const result = { id, status: 'SKIPPED', reason: 'READ_ONLY=1: this journey writes', steps: [] };
    await record(id, result);
    return result;
  }
  let j, result;
  try {
    j = await createJourney(id);
    await work(j);
  } catch (error) {
    const fail = { name: 'journey', status: 'FAIL', reason: error.name === 'TimeoutError' ? 'Required control/content missing' : error.message.split('\n')[0] };
    if (j) j.results.push(fail); else result = { id, status: 'FAIL', steps: [fail], baseURL: BASE_URL };
  } finally {
    if (j) {
      try {
        const h = await (await j.context.request.get(`${BASE_URL}${MODE === 'local' ? '/api/health' : '/health'}`)).json();
        const build = MODE === 'local' ? h.instance?.build : h.build;
        check(build?.revision === j.metadata.build?.revision && build?.buildId === j.metadata.build?.buildId, 'App build changed during journey');
        check(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim() === j.metadata.sourceSha, 'Driver HEAD changed during journey');
        j.metadata.buildVerifiedAtEnd = true;
      } catch { j.results.push({ name: 'build-identity', status: 'FAIL', reason: 'Build identity changed or became unavailable' }); }
      await j.context.close();
      if (j.network.http4xx || j.network.http5xx || j.network.pageErrors || j.network.failedRequests) j.results.push({ name: 'network/runtime', status: 'FAIL', reason: 'HTTP errors, failed requests or uncaught page errors' });
      const status = j.results.some(x => x.status === 'FAIL') ? 'FAIL' : j.results.some(x => x.status === 'SKIPPED') ? 'PARTIAL' : 'PASS';
      result = { id, status, startedAt: j.startedAt, metadata: j.metadata, network: j.network, steps: j.results };
      await j.browser.close();
    }
    await record(id, result);
    if (result.status === 'FAIL') process.exitCode = 1;
  }
  return result;
}
export function direct(meta) { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(meta); }
