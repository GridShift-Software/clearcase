// The hosted pages a signed-out or mis-signed person lands on (alpha hardening, lane auth-routing; Astra findings from the live
// Cloudflare runs). Server renders: the 401 page must send staff to operator sign-in with the exact requested path, the client
// sign-in page must point staff at their own sign-in, entry links must be full document navigations (the sign-in pages carry a
// form-action CSP an SPA navigation never receives), and client intake must explain a reader without an upload grant. Only
// $app/state is a double, so this is a markup contract, not a browser, CSP or Clerk run.
import { render } from 'svelte/server';
// @ts-expect-error jsdom ships no types and the root pins no @types/jsdom; the suite only parses rendered markup with it.
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import ErrorPage from '../../../deploy/client/routes/+error.svelte';
import SignInPage from '../../../deploy/client/routes/sign-in/+page.svelte';
import IntakePage from '../../../deploy/client/routes/client/intake/[caseId]/+page.svelte';

const state = vi.hoisted(() => ({ page: { status: 401, url: new URL('https://client-a.clearcase.test/cases'), error: null as { message: string; code?: string } | null } }));
vi.mock('$app/state', () => state);
vi.mock('$app/navigation', () => ({ invalidateAll: async () => {} }));

const ORIGIN = 'https://client-a.clearcase.test';
const dom = (C: unknown, props: Record<string, unknown> = {}) => new JSDOM(`<body>${render(C as never, { props } as never).body}</body>`).window.document as Document;
const refused = (status: number, path: string) => {
	state.page.status = status;
	state.page.url = new URL(path, ORIGIN);
	state.page.error = { message: status === 401 ? 'Sign in to continue.' : 'Not found.', code: status === 401 ? 'unauthenticated' : 'not-found' };
	return dom(ErrorPage);
};

describe('the 401 page', () => {
	it.each([
		['/operator/cases/case-a', '%2Foperator%2Fcases%2Fcase-a'],
		['/operator/cases/case-a?q=JN-001&type=original', '%2Foperator%2Fcases%2Fcase-a%3Fq%3DJN-001%26type%3Doriginal'],
		['/operator/cases/case-a/preview/cand-1', '%2Foperator%2Fcases%2Fcase-a%2Fpreview%2Fcand-1'],
		['/operator/submissions/case-a', '%2Foperator%2Fsubmissions%2Fcase-a'],
	])('links a signed-out %s to operator sign-in with that exact path as returnTo, as a full navigation', (path, encoded) => {
		const a = refused(401, path).querySelector('#sign-in-link')!;
		expect(a.getAttribute('href')).toBe(`/sign-in/operator?returnTo=${encoded}`);
		expect(a.hasAttribute('data-sveltekit-reload')).toBe(true);
	});

	it('treats an encoded operator prefix as the operator route it routes to', () => {
		expect(refused(401, '/%6Fperator/cases/case-a').querySelector('#sign-in-link')!.getAttribute('href')).toMatch(/^\/sign-in\/operator\?returnTo=/);
	});

	it('sends a signed-out client page to client sign-in and keeps the page as returnTo', () => {
		const a = refused(401, '/cases/case-a/notes').querySelector('#sign-in-link')!;
		expect(a.getAttribute('href')).toBe('/sign-in?returnTo=%2Fcases%2Fcase-a%2Fnotes');
		expect(a.hasAttribute('data-sveltekit-reload')).toBe(true);
	});

	it('offers no sign-in link on a refusal that is not a 401', () => {
		expect(refused(404, '/operator/cases/case-a').querySelector('#sign-in-link')).toBeNull();
	});
});

describe('the client sign-in page', () => {
	const signIn = (extra: Record<string, unknown> = {}) => dom(SignInPage, { data: { provider: 'clerk', href: 'https://accounts.client-a.clerk.test/sign-in', options: [], ...extra }, form: null });

	it('tells staff that their accounts sign in separately and links the staff sign-in as a full navigation', () => {
		const d = signIn(), staff = d.querySelector('a[href="/sign-in/operator"]')!;
		expect(staff).not.toBeNull();
		expect(staff.textContent).toMatch(/ClearCase staff\? Sign in here/);
		expect(staff.hasAttribute('data-sveltekit-reload')).toBe(true);
		expect(d.body.textContent).toMatch(/staff accounts sign in separately/i);
	});

	it('keeps the staff link off the test-identity sign-in, where operator sign-in does not exist', () => {
		expect(signIn({ provider: 'double', href: null }).querySelector('a[href="/sign-in/operator"]')).toBeNull();
	});
});

describe('the client intake page', () => {
	const entry = (stage: 'finalized') => ({ operationId: 'op-1', path: 'letter.pdf', size: 40, stage, results: 'none', manifest: null, handoff: [] });
	const intake = (data: Record<string, unknown>) => dom(IntakePage, { data: { caseId: 'case-a', available: true, submissions: [], ...data } });

	it('explains a missing upload grant plainly instead of showing the upload form', () => {
		const d = intake({ canUpload: false });
		expect(d.querySelector('form')).toBeNull();
		expect(d.querySelector('input[type=file]')).toBeNull();
		expect(d.querySelector('[data-intake-state="no-upload-grant"]')!.textContent).toMatch(/not set up to supply files for this case/i);
	});

	it('still lists the submissions of a reader who may not upload', () => {
		expect(intake({ canUpload: false, submissions: [entry('finalized')] }).querySelector('[data-stage="finalized"]')).not.toBeNull();
	});

	it.each([[true], [undefined]])('shows the upload form when the grant is held or unknown (%s)', (canUpload) => {
		const d = intake({ canUpload });
		expect(d.querySelector('form[data-intake-state="available"] input[type=file]')).not.toBeNull();
		expect(d.querySelector('[data-intake-state="no-upload-grant"]')).toBeNull();
	});

	it('shows nothing about grants when intake is unavailable on this deployment', () => {
		const d = intake({ available: false, canUpload: false });
		expect(d.querySelector('[data-intake-state="unavailable"]')).not.toBeNull();
		expect(d.querySelector('[data-intake-state="no-upload-grant"]')).toBeNull();
	});
});
