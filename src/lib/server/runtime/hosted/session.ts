// The session cookie of the hosted entry. The hosted-gate identity double sets it; an identity provider replaces both.
export const SESSION_COOKIE = 'clearcase_session';
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The session id the request presents, or null; a malformed value is presented but matches no session. */
export function presentedSession(request: Request): string | null {
	for (const part of (request.headers.get('cookie') ?? '').split(';')) {
		const [name, ...rest] = part.trim().split('=');
		if (name === SESSION_COOKIE) return SESSION.test(rest.join('=')) ? rest.join('=') : 'malformed';
	}
	return null;
}
