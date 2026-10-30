import { expect, it } from 'vitest';
import { createHandle } from '../../../src/lib/server/runtime/hosted/handle.ts';
import type { RequestEvent } from '@sveltejs/kit';
import type { Readiness } from '../../../src/lib/server/runtime/hosted/handle.ts';

it.each(['/sign-out', '/sign-in/operator', '/sign-in'])('does not restore a deleted app cookie on %s', async (path) => {
	const request = new Request(`https://client.test${path}`, { method: 'POST', headers: { origin: 'https://client.test' } });
	const handle = createHandle(async () => ({ ready: true, services: { identity: { kind: 'verified' } } }) as unknown as Readiness, undefined, undefined,
		async () => ({ setCookies: ['__Host-clearcase_session=synthetic-slid; Path=/'] }));
	const response = await handle({ event: { request, url: new URL(request.url), locals: {} } as RequestEvent,
		resolve: async () => new Response(null, { status: 303, headers: { 'set-cookie': '__Host-clearcase_session=; Path=/; Max-Age=0' } }) });
	expect(response.headers.getSetCookie()).toEqual(['__Host-clearcase_session=; Path=/; Max-Age=0']);
});
