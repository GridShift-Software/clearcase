// The client half of the heavy review's M4: a fetch the hosted handle refused 401 with `x-clearcase-reauth: 1` (an expired
// session only the handshake renews) reloads the page, which goes through it; nothing is retried. SYNTHETIC responses.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reloadForSignIn } from '../../../src/lib/views/hosted/reauth.ts';

afterEach(() => void vi.unstubAllGlobals());
const page = () => {
	const assign = vi.fn();
	vi.stubGlobal('location', { href: 'https://client-a.clearcase.test/operator/results/case-a?tab=import', assign });
	return assign;
};

describe('reloadForSignIn', () => {
	it('reloads the current page for a marked 401, and says so', () => {
		const assign = page();
		expect(reloadForSignIn(new Response('{}', { status: 401, headers: { 'x-clearcase-reauth': '1' } }))).toBe(true);
		expect(assign).toHaveBeenCalledExactlyOnceWith('https://client-a.clearcase.test/operator/results/case-a?tab=import');
	});
	it.each([
		['an unmarked 401', new Response('{}', { status: 401 })],
		['a marked success', new Response('{}', { status: 200, headers: { 'x-clearcase-reauth': '1' } })],
		['a 403', new Response('{}', { status: 403, headers: { 'x-clearcase-reauth': '1' } })],
		['another marker value', new Response('{}', { status: 401, headers: { 'x-clearcase-reauth': 'yes' } })],
	])('leaves %s to the caller', (_name, r) => {
		const assign = page();
		expect(reloadForSignIn(r)).toBe(false);
		expect(assign).not.toHaveBeenCalled();
	});
});
