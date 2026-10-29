// The session cookie of the hosted-gate identity double. The Clerk app session is `__Host-` (app-session.ts APP_COOKIE)
// and never reads this name, which it had before GRS-278; sign-out still clears it.
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
