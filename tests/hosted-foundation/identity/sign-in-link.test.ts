// Where a refused page sends a person to sign in (alpha hardening, lane auth-routing). The 401 page builds its link from the
// requested URL with signInHref; every operator route must reach /sign-in/operator with the exact path as returnTo, and the
// server's existing returnTo validation (signInReturnTarget) must still accept it unchanged or refuse it to the default, never
// follow it off this origin. SYNTHETIC paths only; pure functions, no browser and no Clerk.
import { describe, expect, it } from 'vitest';
import { DEFAULT_RETURN, OPERATOR_PATH, signInReturnTarget } from '../../../src/lib/auth/clerk/flow.ts';
import { signInHref } from '../../../src/lib/auth/sign-in-link.ts';

const ORIGIN = 'https://client-a.clearcase.test';
const returnToOf = (href: string) => new URL(href, ORIGIN).searchParams.get('returnTo');
const pathOf = (href: string) => new URL(href, ORIGIN).pathname;

describe('signInHref', () => {
	it.each([
		'/operator/cases/case-a',
		'/operator/cases/case-a?q=JN-001&type=original&status=open',
		'/operator/cases/case-a/preview/cand-1',
		'/operator/submissions/case-a',
		'/operator/publication/case-a/readiness',
		'/operator',
	])('sends the operator route %s to operator sign-in with that exact path as returnTo, accepted unchanged by the server validation', (path) => {
		const href = signInHref(path);
		expect(pathOf(href)).toBe(OPERATOR_PATH);
		expect(returnToOf(href)).toBe(path);
		expect(signInReturnTarget(returnToOf(href))).toBe(path);
	});

	it.each(['/cases', '/cases/case-a/notes', '/client/intake/case-a', '/operatorx/cases', '/api/operator/cases'])('sends the client page %s to client sign-in with returnTo', (path) => {
		const href = signInHref(path);
		expect(pathOf(href)).toBe('/sign-in');
		expect(returnToOf(href)).toBe(path);
	});

	it('treats an encoded or slash-doubled operator prefix as the operator route it routes to', () => {
		for (const path of ['/%6Fperator/cases/case-a', '//operator/cases/case-a', '/operator%2Fcases']) expect(pathOf(signInHref(path))).toBe(OPERATOR_PATH);
	});

	it('encodes the path into one returnTo value, so a query cannot add parameters of its own', () => {
		const href = signInHref('/operator/cases/case-a?returnTo=https://evil.example&x=1#frag');
		const params = new URL(href, ORIGIN).searchParams;
		expect([...params.keys()]).toEqual(['returnTo']);
		expect(params.get('returnTo')).toBe('/operator/cases/case-a?returnTo=https://evil.example&x=1#frag');
	});

	it.each([
		'//evil.example/operator/x', '/\\evil.example', 'https://evil.example/operator/x', 'javascript:alert(1)', '/operator/\u0000x', '/operator/\r\nSet-Cookie: a=b', '', 'operator/cases',
	])('never lets %j take a person off this origin: the server validation keeps the target same-origin', (path) => {
		const href = signInHref(path);
		expect(href.startsWith('/sign-in')).toBe(true);
		const target = signInReturnTarget(returnToOf(href));
		expect(new URL(target, ORIGIN).origin).toBe(ORIGIN);
	});

	it('does not loop back into a sign-in or sign-out page', () => {
		for (const path of ['/sign-in', '/sign-in/operator', '/sign-out']) expect(signInReturnTarget(returnToOf(signInHref(path)))).toBe(DEFAULT_RETURN);
	});
});
