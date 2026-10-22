import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';

test('the pool runs in workerd with the local D1 and R2 bindings', async () => {
	expect(navigator.userAgent).toBe('Cloudflare-Workers');
	expect(await env.DB.prepare('SELECT 1 AS one').first()).toEqual({ one: 1 });
	await env.BUCKET.put('probe.txt', 'synthetic');
	expect(await (await env.BUCKET.get('probe.txt')).text()).toBe('synthetic');
	expect(env.CLEARCASE_CLIENT_ID).toBe('probe-local');
});
