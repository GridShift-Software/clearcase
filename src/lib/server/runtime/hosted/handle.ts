import type { Handle, HandleServerError } from '@sveltejs/kit/hooks';
import type { RequestServices } from '../contracts.ts';

/** What the hosted entry knows about one request's services: ready, or the reason it refuses before any route runs. */
export type Readiness = { ready: true; services: RequestServices } | { ready: false; services: RequestServices; reason: string };

const SECURITY = {
	'cache-control': 'no-store',
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'same-origin',
	'cross-origin-opener-policy': 'same-origin',
	'cross-origin-resource-policy': 'same-origin',
};
export const plain = (status: number, body: string, extra: Record<string, string> = {}) =>
	new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY, ...extra } });

// Paths that answer without the request services: the health report (which states its own readiness) and the refusal
// of the local folder browser. Everything else is protected and waits for readiness.
const PUBLIC = (path: string) => path === '/health';
const LOCAL_ONLY = (path: string) => path === '/api/browse' || path.startsWith('/api/browse/');

// An exact https origin with a plain DNS host and an optional port: no wildcard, scheme-only, keyword, path or separator.
const HTTPS_ORIGIN = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::\d{1,5})?$/;
const FORM_ACTION_SELF = /(^|;\s*)form-action 'self'(?=\s*(;|$))/;

/**
 * The CSP with `origins` appended to its exact `form-action 'self'` directive. A CSP without that directive, or any origin
 * that is not an exact https origin, leaves the CSP as it is, so this can only ever add named hosts.
 */
export function withFormActions(csp: string, origins: readonly string[]): string {
	if (!origins.length || !origins.every((o) => HTTPS_ORIGIN.test(o)) || !FORM_ACTION_SELF.test(csp)) return csp;
	return csp.replace(FORM_ACTION_SELF, `$1form-action 'self' ${origins.join(' ')}`);
}

/**
 * A request's renewed session: the credential its identity is read from instead, and the cookies its answer sets. With no
 * credential the request keeps its own identity and only the cookies are set (a refused renewal clears its spent hold).
 */
export type Refreshed = { credential?: Request; setCookies: readonly string[]; outage?: true; spent?: true };
/** Where a page-data request is handed for a full page load, and the cookies its answer sets. */
export type Handoff = { location: string; setCookies: readonly string[] };

// Kit's page-data request: the page's path with `/__data.json` appended and its own query parameters added.
const DATA_SUFFIX = '/__data.json', INVALIDATED = 'x-sveltekit-invalidated', TRAILING_SLASH = 'x-sveltekit-trailing-slash';
/** The page a `__data.json` request loads data for, as Kit resolves it (respond.js), or null for any other request. */
export function dataRequestPage(url: string): URL | null {
	const page = new URL(url);
	if (!page.pathname.endsWith(DATA_SUFFIX)) return null;
	page.pathname = page.pathname.slice(0, -DATA_SUFFIX.length) + (page.searchParams.get(TRAILING_SLASH) === '1' ? '/' : '') || '/';
	page.searchParams.delete(TRAILING_SLASH);
	page.searchParams.delete(INVALIDATED);
	return page;
}
/**
 * Kit's answer to a page-data request that redirects (its `redirect_json_response`: a 200 JSON `{"type":"redirect"}`
 * node), built here so the cookies it sets survive: Kit rebuilds a 30x a hook returns for a data request without them.
 * The client follows a location on another origin as a full page load.
 */
function dataRedirect(location: string, setCookies: readonly string[]): Response {
	const response = new Response(JSON.stringify({ type: 'redirect', status: 303, location }), { status: 200, headers: { 'content-type': 'application/json', ...SECURITY } });
	for (const c of setCookies) response.headers.append('set-cookie', c);
	return response;
}

/**
 * The hosted `handle`. It builds the six request services, refuses a protected request with 503 before resolving any
 * route when they are not ready, keeps SvelteKit's Origin check for form posts (and refuses a cross-origin write
 * itself first), and adds the security headers to every answer. `formActionsFor` names, per path, the origins a page's
 * form may additionally be redirected to (the production sign-in pages); without it every CSP stays the app's own.
 * `refreshFor` may renew an expired session of a request the handshake let through (any method, after the Origin
 * check): its identity is then read from the renewed credential and its answer sets the renewed cookies. A refresh
 * that fails is no refresh, so the request meets the identity it presented. `handoffFor` may hand a page-data GET that was
 * not renewed (and not for an outage), or whose renewal left its hold spent, to a full page load through the identity handshake: its answer is then a data
 * redirect there, with the refresh's cookies and its own, and no route runs.
 * The local pilot keeps its own hooks.
 */
export function createHandle(servicesFor: (request: Request, credential?: Request) => Promise<Readiness>, handshakeFor?: (request: Request) => Promise<Response | null>, formActionsFor?: (path: string) => readonly string[], refreshFor?: (request: Request) => Promise<Refreshed | null>, handoffFor?: (request: Request, page: URL) => Promise<Handoff | null>): Handle {
	return async ({ event, resolve }) => {
		const path = event.url.pathname;
		if (LOCAL_ONLY(path)) return plain(404, 'Not found');
		if (!['GET', 'HEAD', 'OPTIONS'].includes(event.request.method) && event.request.headers.get('origin') !== event.url.origin) return plain(403, 'Forbidden');
		if (handshakeFor && event.request.method === 'GET' && !PUBLIC(path) && path !== '/sign-out') {
			let response: Response | null;
			try { response = await handshakeFor(event.request); }
			catch { return plain(503, 'ClearCase is unavailable: the identity handshake is unavailable'); }
			if (response) {
				const headers = new Headers(response.headers);
				for (const [name, value] of Object.entries(SECURITY)) headers.set(name, value);
				return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
			}
		}
		let refreshed: Refreshed | null = null;
		if (refreshFor && !PUBLIC(path) && path !== '/sign-out') {
			try { refreshed = await refreshFor(event.request); }
			catch { refreshed = null; }
		}
		// a renewal that left the hold spent is handed off too, so a later save has a fresh refresh token (round 4b)
		const page = handoffFor && event.request.method === 'GET' && (!refreshed?.credential || refreshed.spent) && !refreshed?.outage ? dataRequestPage(event.request.url) : null;
		if (page) {
			let handoff: Handoff | null;
			try { handoff = await handoffFor!(event.request, page); }
			catch { handoff = null; }
			if (handoff) return dataRedirect(handoff.location, [...(refreshed?.setCookies ?? []), ...handoff.setCookies]);
		}
		const readiness = await servicesFor(event.request, refreshed?.credential);
		Object.assign(event.locals, readiness.services);
		if (!readiness.ready && !PUBLIC(path)) return plain(503, `ClearCase is unavailable: ${readiness.reason}`, { 'retry-after': '2' });
		const response = await resolve(event);
		for (const [name, value] of Object.entries(SECURITY)) response.headers.set(name, value);
		for (const c of refreshed?.setCookies ?? []) response.headers.append('set-cookie', c);
		const csp = formActionsFor ? response.headers.get('content-security-policy') : null;
		if (csp) response.headers.set('content-security-policy', withFormActions(csp, formActionsFor!(path)));
		return response;
	};
}

// No stack, cause or binding name reaches a client; app errors keep the message their route gave.
export const handleError: HandleServerError = ({ kind, error }) => {
	if (kind === 'app' || kind === 'validation') return;
	if (kind === 'framework' && error.status === 404) return { message: 'Not found' };
	console.error(error);
	return { message: 'Internal error' };
};
