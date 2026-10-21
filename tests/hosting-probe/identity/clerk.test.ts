// The runner's Clerk client (clerk.ts) against a stubbed fetch: no network, no key.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Backend, Pace } from './clerk.ts';

const NOW = 1_700_000_000_000;
const stub = (...replies: unknown[]) => {
	const fetch = vi.fn(async () => new Response(JSON.stringify(replies.shift() ?? []), { status: 200 }));
	vi.stubGlobal('fetch', fetch);
	return fetch;
};
const backend = () => new Backend('sk_test_synthetic-placeholder-not-a-key', new Pace(1000, 1));
afterEach(() => vi.unstubAllGlobals());

describe('a row without a creation time is not swept as if it were old', () => {
	const user = (id: string, created_at: unknown) => ({ id, primary_email_address_id: 'idn_1', email_addresses: [{ id: 'idn_1', email_address: `cc108-${id}+clerk_test@example.com` }], ...(created_at === undefined ? {} : { created_at }) });

	test('users: a missing, null, non-numeric or infinite created_at is skipped; a finite one is kept', async () => {
		stub([user('u1', NOW), user('u2', undefined), user('u3', null), user('u4', 'soon'), user('u5', Infinity), user('u6', NOW + 1)]);
		expect((await backend().users('cc108-')).map((u) => [u.id, u.createdAt])).toEqual([['u1', NOW], ['u6', NOW + 1]]);
	});

	test('invitations: the same', async () => {
		const inv = (id: string, created_at?: unknown) => ({ id, email_address: `cc108-${id}+clerk_test@example.com`, status: 'pending', ...(created_at === undefined ? {} : { created_at }) });
		stub([inv('i1', NOW), inv('i2'), inv('i3', null), inv('i4', 'x')]);
		expect((await backend().invitations('cc108-')).map((i) => i.id)).toEqual(['i1']);
	});
});
