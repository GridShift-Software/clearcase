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

/**
 * The hosted `handle`. It builds the six request services, refuses a protected request with 503 before resolving any
 * route when they are not ready, keeps SvelteKit's Origin check for form posts (and refuses a cross-origin write
 * itself first), and adds the security headers to every answer. The local pilot keeps its own hooks.
 */
export function createHandle(servicesFor: (request: Request) => Promise<Readiness>): Handle {
	return async ({ event, resolve }) => {
		const path = event.url.pathname;
		if (LOCAL_ONLY(path)) return plain(404, 'Not found');
		if (!['GET', 'HEAD', 'OPTIONS'].includes(event.request.method) && event.request.headers.get('origin') !== event.url.origin) return plain(403, 'Forbidden');
		const readiness = await servicesFor(event.request);
		Object.assign(event.locals, readiness.services);
		if (!readiness.ready && !PUBLIC(path)) return plain(503, `ClearCase is unavailable: ${readiness.reason}`, { 'retry-after': '2' });
		const response = await resolve(event);
		for (const [name, value] of Object.entries(SECURITY)) response.headers.set(name, value);
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
