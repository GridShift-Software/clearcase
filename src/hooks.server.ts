import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit';
import { building } from '$app/environment';
import { app, initApp } from '$lib/local-case/app.server';
import { discardBody, oversize } from '$lib/local-case/request-limit.server';
import { ensureRescanProvider } from '$lib/local-case/rescan/rescan.server';

export const init: ServerInit = async () => {
	if (building) return;
	await initApp();
	// the rescan additions are document rows for every reader (chronology, documents, search), so the provider is
	// registered at start-up, not when a system page first loads
	// (a storage problem is shown by the first request; the system pages then register it as before)
	if (app().storageError) return;
	try { for (const p of app().store.activePointers()) ensureRescanProvider(app(), p.case_id); } catch (e) { console.error('rescan provider not registered at start-up:', e); }
};

// Exact Host allowlist: only 127.0.0.1:<PORT>. 'localhost:<PORT>' (or any *.localhost) is refused on purpose: the
// originals site is clearcase-originals.localhost and the two must never share a site. The production listener
// (scripts/pilot/start.ts) applies the same check to static assets before SvelteKit sees them.
const appHost = () => `127.0.0.1:${app().config.appPort}`;

const plain = (status: number, body: string, extra: Record<string, string> = {}) =>
	new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'cache-control': 'no-store', ...extra } });

// Loopback clients only: 127.0.0.0/8, ::1 and IPv4-mapped 127.x. The listener binds 127.0.0.1, so this holds only if
// someone serves the handler another way (defence in depth). An address SvelteKit cannot tell is refused too.
const isLoopback = (addr: string) => /^(::ffff:)?127(\.\d{1,3}){3}$/i.test(addr) || addr === '::1';
const clientAddress = (event: Parameters<Handle>[0]['event']) => { try { return event.getClientAddress(); } catch { return ''; } };

export const handle: Handle = async ({ event, resolve }) => {
	if (!building && !event.isSubRequest) {
		if (!isLoopback(clientAddress(event))) return plain(403, 'ClearCase answers this machine only (loopback clients)');
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
		// Each route's own size limit, from the declared size and before the body is read; independent of BODY_SIZE_LIMIT.
		const big = oversize(event.request, event.url.pathname);
		if (big) {
			if (big.status === 413) await discardBody(event.request);
			// a form enhanced by SvelteKit reads an action result: only this JSON gives it the status (a text body is a lost request to it)
			if (event.request.headers.get('x-sveltekit-action') === 'true') return plain(big.status, JSON.stringify({ type: 'error', error: { message: big.message } }), { 'content-type': 'application/json' });
			return plain(big.status, big.message);
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
	// The chronology page's universal load reads x-clearcase-degraded from its /api fetch; during SSR SvelteKit refuses
	// (500) any response header it is not told to serialize for hydration. That one header is allowed, nothing else.
	const res = await resolve(event, { filterSerializedResponseHeaders: (name) => name === 'x-clearcase-degraded' });
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

// SQLITE_FULL (13) or ENOSPC: the file system holding the data directory is full. Nothing was written (every write is
// one transaction); say so instead of a generic error.
const diskFull = (e: unknown) => { const x = e as { errcode?: number; code?: string; message?: string }; return (x?.errcode !== undefined && (x.errcode & 0xff) === 13) || x?.code === 'ENOSPC' || /database or disk is full|ENOSPC|no space left on device/i.test(String(x?.message ?? '')); };
const DISK_FULL = 'The disk holding the ClearCase data directory is full, so nothing was written. Free some space and try again.';

export const handleError: HandleServerError = ({ error, status }) => {
	if (status !== 404) console.error(error);
	return { message: status === 404 ? 'Not found' : diskFull(error) ? DISK_FULL : 'Internal error' };
};
