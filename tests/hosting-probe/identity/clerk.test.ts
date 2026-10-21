// The runner's Clerk client (clerk.ts) against a stubbed fetch: no network, no key.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Backend, halt, Pace } from './clerk.ts';

const NOW = 1_700_000_000_000;
const stub = (...replies: unknown[]) => {
	const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(replies.shift() ?? []), { status: 200 }));
	vi.stubGlobal('fetch', fetch);
	return fetch;
};
const backend = () => new Backend('sk_test_synthetic-placeholder-not-a-key', new Pace(1000, 1));
afterEach(() => (vi.unstubAllGlobals(), (halt.on = false)));

describe('a row without a creation time has none, so it is not swept as if it were old', () => {
	const user = (id: string, created_at: unknown) => ({ id, primary_email_address_id: 'idn_1', email_addresses: [{ id: 'idn_1', email_address: `cc108-${id}+clerk_test@example.com` }], ...(created_at === undefined ? {} : { created_at }) });

	test('users: a missing, null, non-numeric or infinite created_at is null; a finite one is kept', async () => {
		stub([user('u1', NOW), user('u2', undefined), user('u3', null), user('u4', 'soon'), user('u5', Infinity), user('u6', NOW + 1)]);
		expect((await backend().users('cc108-')).map((u) => [u.id, u.createdAt])).toEqual([['u1', NOW], ['u2', null], ['u3', null], ['u4', null], ['u5', null], ['u6', NOW + 1]]);
	});

	test('invitations: the same, and every row of the prefix is still listed for the cleanup', async () => {
		const inv = (id: string, created_at?: unknown) => ({ id, email_address: `cc108-${id}+clerk_test@example.com`, status: 'pending', ...(created_at === undefined ? {} : { created_at }) });
		stub([inv('i1', NOW), inv('i2'), inv('i3', null), inv('i4', 'x')]);
		expect((await backend().invitations('cc108-')).map((i) => [i.id, i.createdAt])).toEqual([['i1', NOW], ['i2', null], ['i3', null], ['i4', null]]);
	});
});

describe('halt: after an interrupt the run creates nothing more but still cleans up', () => {
	test('a create is refused before it is sent, and a delete, a read and a revoke are not', async () => {
		const fetch = stub({}, {}, {}, {});
		const b = backend();
		halt.on = true;
		await expect(b.createUser('cc108-x+clerk_test@example.com', 'synthetic')).rejects.toThrow(/interrupted/);
		await expect(b.createInvitation('cc108-y+clerk_test@example.com', 'https://example.invalid/')).rejects.toThrow(/interrupted/);
		expect(fetch).not.toHaveBeenCalled();
		await b.deleteUser('user_1');
		await b.getSession('sess_1');
		await b.revokeSession('sess_1');
		expect(fetch.mock.calls.map(([url, init]) => `${init?.method} ${String(url).replace(/^.*\/v1/, '')}`)).toEqual(['DELETE /users/user_1', 'GET /sessions/sess_1', 'POST /sessions/sess_1/revoke']);
	});
});
