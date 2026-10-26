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
 * The hosted `handle`. It builds the six request services, refuses a protected request with 503 before resolving any
 * route when they are not ready, keeps SvelteKit's Origin check for form posts (and refuses a cross-origin write
 * itself first), and adds the security headers to every answer. `formActionsFor` names, per path, the origins a page's
 * form may additionally be redirected to (the production sign-in pages); without it every CSP stays the app's own.
 * The local pilot keeps its own hooks.
 */
export function createHandle(servicesFor: (request: Request) => Promise<Readiness>, handshakeFor?: (request: Request) => Promise<Response | null>, formActionsFor?: (path: string) => readonly string[]): Handle {
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
		const readiness = await servicesFor(event.request);
		Object.assign(event.locals, readiness.services);
		if (!readiness.ready && !PUBLIC(path)) return plain(503, `ClearCase is unavailable: ${readiness.reason}`, { 'retry-after': '2' });
		const response = await resolve(event);
		for (const [name, value] of Object.entries(SECURITY)) response.headers.set(name, value);
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
