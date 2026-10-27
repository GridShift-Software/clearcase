// The hosted pages a signed-out or mis-signed person lands on (alpha hardening, lane auth-routing; Astra findings from the live
// Cloudflare runs): the 401 page must send staff to operator sign-in with the exact requested path, the client sign-in page
// must point staff at their own sign-in, entry links must be full document navigations (the sign-in pages carry a form-action
// CSP an SPA navigation never receives), and client intake must explain a refusal. Page components are mounted in jsdom;
// only $app/state, $app/navigation and fetch are doubles, so this is a UI contract, not a browser, CSP or Clerk run.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
// @ts-expect-error jsdom ships no types and the root pins no @types/jsdom; the suite only constructs windows and types them as any.
import { JSDOM } from 'jsdom';
import ErrorPage from '../../../deploy/client/routes/+error.svelte';
import SignInPage from '../../../deploy/client/routes/sign-in/+page.svelte';
import IntakePage from '../../../deploy/client/routes/client/intake/[caseId]/+page.svelte';

const state = vi.hoisted(() => ({ page: { status: 401, url: new URL('https://client-a.clearcase.test/cases'), error: { message: 'Sign in to continue.', code: 'unauthenticated' } as { message: string; code?: string } | null } }));
vi.mock('$app/state', () => state);
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(async () => {}) }));

const ORIGIN = 'https://client-a.clearcase.test';
let dom: any, component: any;
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: ORIGIN });
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLMediaElement', 'Text', 'Comment', 'Event', 'MutationObserver'])
    vi.stubGlobal(key, dom.window[key]);
});
afterEach(async () => { if (component) await unmount(component); component = null; dom.window.close(); vi.unstubAllGlobals(); });

const show = (page: { status: number; path: string; code?: string }) => {
  state.page.status = page.status;
  state.page.url = new URL(page.path, ORIGIN);
  state.page.error = { message: page.status === 401 ? 'Sign in to continue.' : 'Not found.', code: page.code };
  component = mount(ErrorPage, { target: document.body });
  flushSync();
};
const link = (selector: string) => document.querySelector(selector) as HTMLAnchorElement | null;

it.each([
  ['/operator/cases/case-a', '%2Foperator%2Fcases%2Fcase-a'],
  ['/operator/cases/case-a?q=JN-001&type=original', '%2Foperator%2Fcases%2Fcase-a%3Fq%3DJN-001%26type%3Doriginal'],
  ['/operator/cases/case-a/preview/cand-1', '%2Foperator%2Fcases%2Fcase-a%2Fpreview%2Fcand-1'],
  ['/operator/submissions/case-a', '%2Foperator%2Fsubmissions%2Fcase-a'],
])('a signed-out %s page links to operator sign-in with that exact path as returnTo', (path, encoded) => {
  show({ status: 401, path });
  const a = link('#sign-in-link')!;
  expect(a.getAttribute('href')).toBe(`/sign-in/operator?returnTo=${encoded}`);
  expect(a.hasAttribute('data-sveltekit-reload')).toBe(true);
});

it('treats an encoded operator prefix as the operator route it routes to', () => {
  show({ status: 401, path: '/%6Fperator/cases/case-a' });
  expect(link('#sign-in-link')!.getAttribute('href')).toMatch(/^\/sign-in\/operator\?returnTo=/);
});

it('sends a signed-out client page to client sign-in and keeps the page as returnTo', () => {
  show({ status: 401, path: '/cases/case-a/notes' });
  const a = link('#sign-in-link')!;
  expect(a.getAttribute('href')).toBe('/sign-in?returnTo=%2Fcases%2Fcase-a%2Fnotes');
  expect(a.hasAttribute('data-sveltekit-reload')).toBe(true);
});

it('offers no sign-in link on a refusal that is not a 401', () => {
  show({ status: 404, path: '/operator/cases/case-a' });
  expect(link('#sign-in-link')).toBeNull();
});

const signIn = (extra: Partial<{ provider: string; href: string | null }> = {}) => {
  component = mount(SignInPage, { target: document.body, props: { data: { provider: 'clerk', href: 'https://accounts.client-a.clerk.test/sign-in', options: [], ...extra }, form: null } });
  flushSync();
};

it('tells staff that their accounts sign in separately and links the staff sign-in as a full navigation', () => {
  signIn();
  const staff = link('a[href="/sign-in/operator"]')!;
  expect(staff).not.toBeNull();
  expect(staff.textContent).toMatch(/ClearCase staff\? Sign in here/);
  expect(staff.hasAttribute('data-sveltekit-reload')).toBe(true);
  expect(document.body.textContent).toMatch(/staff accounts sign in separately/i);
});

it('keeps the staff link off the test-identity sign-in, where operator sign-in does not exist', () => {
  signIn({ provider: 'double', href: null });
  expect(link('a[href="/sign-in/operator"]')).toBeNull();
});

// ---- client intake --------------------------------------------------------------------------------------------------

const CASE = 'case-a';
const pdf = new TextEncoder().encode('%PDF-1.4\n% SYNTHETIC ONLY auth-routing\n%%EOF\n');
const reply = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const intake = (data: Record<string, unknown> = {}) => {
  component = mount(IntakePage, { target: document.body, props: { data: { caseId: CASE, available: true, submissions: [], ...data } } });
  flushSync();
};
const pick = () => {
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [new File([pdf], 'letter.pdf', { type: 'application/pdf' })] });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
};
const submit = () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); flushSync(); };

it('a send refused with 401 shows a sign-in link that returns to this intake page', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => reply(401, { code: 'unauthenticated', message: 'Sign in to continue.' })));
  intake();
  pick(); submit();
  await vi.waitFor(() => expect(document.querySelector('[role=status]')!.textContent).toBe('Sign in to continue.'));
  const a = link('[role=status] a, a[data-intake-sign-in]')!;
  expect(a.getAttribute('href')).toBe(`/sign-in?returnTo=${encodeURIComponent(`/client/intake/${CASE}`)}`);
  expect(a.hasAttribute('data-sveltekit-reload')).toBe(true);
});

it('a send refused for another reason shows no sign-in link', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => reply(403, { code: 'forbidden', message: 'You cannot supply files for this case.' })));
  intake();
  pick(); submit();
  await vi.waitFor(() => expect(document.querySelector('[role=status]')!.textContent).toBe('You cannot supply files for this case.'));
  expect(link('a[data-intake-sign-in]')).toBeNull();
});

it('explains a missing upload grant plainly instead of showing the upload form', () => {
  intake({ canUpload: false });
  expect(document.querySelector('form')).toBeNull();
  expect(document.querySelector('input[type=file]')).toBeNull();
  expect(document.querySelector('[data-intake-state="no-upload-grant"]')!.textContent).toMatch(/not set up to supply files for this case/i);
});

it('still lists the submissions of a reader who may not upload', () => {
  intake({ canUpload: false, submissions: [{ operationId: 'op-1', path: 'letter.pdf', size: 40, stage: 'finalized', results: 'none', manifest: null, handoff: [] }] });
  expect(document.querySelector('[data-stage="finalized"]')).not.toBeNull();
});

it.each([[true], [undefined]])('shows the upload form when the grant is held or unknown (%s)', (canUpload) => {
  intake({ canUpload });
  expect(document.querySelector('form[data-intake-state="available"]')).not.toBeNull();
});
