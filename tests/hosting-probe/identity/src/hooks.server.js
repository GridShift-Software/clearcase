// The one place a request is admitted (GRS-108). Every route the app serves has a gate per method in #lib/gates.json;
// this hook looks it up before the route runs, so a route without a gate is never served and no route checks access
// on its own. A request with no route is refused too (404 not-served), except Kit's own 404 for a path nothing matches.
// Public routes (the BA-19 and BA-20 entry points) never call Clerk or D1.
import { decide, gateOf } from '#lib/server/access.js';

/** A refusal: JSON for API callers, a redirect to the sign-in entry (BA-19) for a signed-out document request. */
function refusal(event, status, reason, clerkReason) {
	const headers = { 'x-probe-denial': reason, 'cache-control': 'no-store' };
	if (clerkReason) headers['x-probe-clerk-reason'] = clerkReason;
	const document = event.request.method === 'GET' && (event.request.headers.get('accept') ?? '').includes('text/html');
	if (status === 401 && document) {
		const to = new URLSearchParams({ reason, next: event.url.pathname });
		return new Response(null, { status: 303, headers: { ...headers, location: `/login?${to}` } });
	}
	return new Response(JSON.stringify({ error: 'denied', reason }), { status, headers: { ...headers, 'content-type': 'application/json' } });
}

export async function handle({ event, resolve }) {
	// Kit 3.1.0 matches no route to a remote-function call (/_app/remote/...), so no gate could name it: default deny.
	if (event.isRemoteRequest) return refusal(event, 404, 'not-served', null);
	const found = gateOf(event.route.id, event.request.method);
	if (found.status === 404 && found.reason === 'no-route') {
		// No file matches. Kit's own 404 may stand; any other answer to a request with no route is refused.
		const response = await resolve(event);
		return response.status === 404 ? response : refusal(event, 404, 'not-served', null);
	}
	if (found.status) return refusal(event, found.status, found.reason, null);
	if (found.gate === 'public') return resolve(event);
	const d = await decide(event, found.gate).catch(() => ({ status: 503, reason: 'access-unavailable' }));
	if (d.handshake) return new Response(null, { status: 307, headers: d.handshake });
	if (!d.access) return refusal(event, d.status, d.reason, d.clerkReason);
	event.locals.access = d.access;
	const response = await resolve(event);
	const out = new Response(response.body, response); // a resolved response's headers can be immutable
	out.headers.set('cache-control', 'private, no-store');
	for (const c of d.setCookies ?? []) out.headers.append('set-cookie', c);
	return out;
}
