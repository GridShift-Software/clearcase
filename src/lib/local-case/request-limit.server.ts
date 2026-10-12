// The app's own request size limits (PRFIX-21 r2). The launcher raises adapter-node's BODY_SIZE_LIMIT to 65M so a
// backup file can be uploaded, which would otherwise let every form post through at that size; each route's limit is
// enforced here instead, from the declared Content-Length before any of the body is read, and answers 413 whatever
// BODY_SIZE_LIMIT is. A route that needs more than the default is listed in `bodyLimit`.
import { MAX_BACKUP_BYTES } from '$lib/user-work/backup/backup.server';

const KIB = 1024;
/** What a form post may carry: a register entry (at most 64 KiB, stored), a note, a path or a choice. The litigation 413 message names it (views/litigation/submit.ts). */
export const DEFAULT_BODY_LIMIT = 512 * KIB;
/** Backup restore posts the backup file itself, with the form's other fields. */
export const BACKUP_BODY_LIMIT = MAX_BACKUP_BYTES + 1024 * KIB;

/** The court bundle page saves a bundle's item list (the route refuses over 2,000,000 characters or 5,000 items itself); a v5-size list is far over the default. */
export const COURT_BUNDLE_BODY_LIMIT = 2 * 1024 * KIB;

const BACKUP_ROUTE = /^\/v\/[^/]+\/system\/backup_tab\/?$/;
const COURT_BUNDLE_ROUTE = /^\/v\/[^/]+\/bundles\/court_bundle_tab\/?$/;
/** The most a request to this path may carry in its body, in bytes. */
export const bodyLimit = (pathname: string) => (BACKUP_ROUTE.test(pathname) ? BACKUP_BODY_LIMIT : COURT_BUNDLE_ROUTE.test(pathname) ? COURT_BUNDLE_BODY_LIMIT : DEFAULT_BODY_LIMIT);

const size = (n: number) => (n >= 1024 * KIB ? `${n / (1024 * KIB)} MiB` : `${n / KIB} KiB`);

/** The refusal for a request whose body is over its route's limit, or whose size is not declared; null when it may be read. */
export function oversize(request: Pick<Request, 'method' | 'headers'>, pathname: string): { status: 411 | 413; message: string } | null {
	if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return null;
	const limit = bodyLimit(pathname);
	const declared = request.headers.get('content-length');
	if (declared === null) {
		// no body unless it is chunked, and a chunked body has no size to check before it is read
		return request.headers.has('transfer-encoding') ? { status: 411, message: 'the request must declare its size (Content-Length)' } : null;
	}
	const n = /^\d+$/.test(declared.trim()) ? Number(declared) : NaN;
	if (!Number.isSafeInteger(n)) return { status: 411, message: 'the request must declare its size (Content-Length)' };
	return n > limit ? { status: 413, message: `request too large: this page accepts at most ${size(limit)} in one request` } : null;
}

/**
 * Reads and discards an over-limit body (nothing is kept), up to `cap` bytes, so the refusal reaches the browser: a server
 * that answers while the body is still arriving and closes the connection makes the browser's fetch fail with no status.
 */
export async function discardBody(request: Pick<Request, 'body'>, cap = BACKUP_BODY_LIMIT) {
	const reader = request.body?.getReader();
	if (!reader) return;
	try {
		for (let seen = 0; seen < cap;) {
			const { done, value } = await reader.read();
			if (done) return;
			seen += value.byteLength;
		}
		await reader.cancel();
	} catch { /* the client went away: nothing left to refuse */ }
}
