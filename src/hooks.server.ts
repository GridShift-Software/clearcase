import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit';
import { building } from '$app/environment';
import { app, initApp } from '$lib/local-case/app.server';

export const init: ServerInit = async () => {
	if (building) return;
	await initApp();
};

// Exact Host allowlist: only 127.0.0.1:<PORT>. 'localhost:<PORT>' (or any *.localhost) is refused on purpose: the
// originals site is clearcase-originals.localhost and the two must never share a site. The production listener
// (scripts/pilot/start.ts) applies the same check to static assets before SvelteKit sees them.
const appHost = () => `127.0.0.1:${app().config.appPort}`;

const plain = (status: number, body: string, extra: Record<string, string> = {}) =>
	new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'cache-control': 'no-store', ...extra } });

export const handle: Handle = async ({ event, resolve }) => {
	if (!building && !event.isSubRequest) {
		const a = app();
		// DNS-rebinding guard. Sub-requests (SSR fetch of /api/...) are exempt: they carry no browser Host.
		if (event.request.headers.get('host') !== appHost()) return plain(421, 'misdirected request: unknown Host');
		// Non-form API endpoints: browsers must be same-origin; writes must be JSON (forms go through actions).
		if (event.url.pathname.startsWith('/api/')) {
			const site = event.request.headers.get('sec-fetch-site');
			if (site && site !== 'same-origin' && site !== 'none') return plain(403, 'cross-site API request refused');
			if (event.request.method !== 'GET' && event.request.method !== 'HEAD' && !(event.request.headers.get('content-type') ?? '').startsWith('application/json'))
				return plain(415, 'API writes must be application/json');
		}
		// '?/default' is reserved by SvelteKit (it throws, i.e. 500): no form here posts to it.
		if (event.request.method === 'POST' && event.url.searchParams.has('/default')) return plain(400, 'unknown form action');
		await a.retryStartupIfDue();
		// The store files must still be the ones this process opened (rm -rf or replaced files: stop writing).
		if (!a.storageError) {
			try { a.storage.checkStoreFiles(); } catch (e) { a.storageError = (e as Error).message; a.retryAt = null; console.error('STORAGE UNAVAILABLE:', a.storageError); }
		}
		if (a.storageError && event.url.pathname !== '/api/health')
			return plain(503, `ClearCase storage is unavailable, so nothing can be shown.\n\n${a.storageError}\n\n${a.retryAt ? 'Another process holds a lock on the store; ClearCase retries automatically. Reload in a few seconds.' : a.restoreHelp()}`, a.retryAt ? { 'retry-after': '2' } : {});
	}
	const res = await resolve(event);
	res.headers.set('x-content-type-options', 'nosniff');
	// NOT no-referrer: that makes Chromium send 'Origin: null' on form POSTs, which SvelteKit's CSRF check rejects.
	res.headers.set('referrer-policy', 'same-origin');
	res.headers.set('cross-origin-opener-policy', 'same-origin');
	res.headers.set('cross-origin-resource-policy', 'same-origin');
	// Pages and data reflect mutable state (active version, user work): never reuse a stored copy. Endpoints that are
	// safe to revalidate set their own Cache-Control (chronology: private, no-cache + ETag).
	if (!res.headers.has('cache-control')) res.headers.set('cache-control', 'no-store');
	if (res.status === 503 && !res.headers.has('retry-after')) res.headers.set('retry-after', '2');
	return res;
};

export const handleError: HandleServerError = ({ error, status }) => {
	if (status !== 404) console.error(error);
	return { message: status === 404 ? 'Not found' : 'Internal error' };
};
