import { timingSafeEqual } from 'node:crypto';

const REFUSED = [/^\/import(\/|$)/, /^\/api\/browse(\/|$)/, /^\/api\/import-progress(\/|$)/, /^\/recovery(\/|$)/, /^\/v\/[^/]+\/system(\/|$)/];

/**
 * The path SvelteKit will route on, or null when the request-target is malformed or ambiguous. SvelteKit's
 * decode_pathname runs decodeURI over each part between literal "%25" before matching routes, so "/api/%62rowse"
 * reaches /api/browse; the rules must see the same string. Of the percent sequences that survive that decoding, only
 * %3A occurs in the app's routes: versionPath encodes the colon of 'sha256:<hex>' and SvelteKit decodes it from the
 * matched parameter. Any other (%2F, %25, so also a double encoding such as %253A), a backslash, a control character or
 * a dot segment occurs in none of the app's routes, so such a path is refused rather than guessed at.
 */
export function canonicalPath(target: string): string | null {
	const cut = target.search(/[?#]/);
	const raw = cut < 0 ? target : target.slice(0, cut);
	if (!raw.startsWith('/')) return null;
	let p: string;
	try { p = raw.split('%25').map(decodeURI).join('%25'); } catch { return null; }
	if (/[\\\u0000-\u001f\u007f]|%(?!3a)/i.test(p)) return null;
	if (p.split('/').some((s) => s === '.' || s === '..')) return null;
	return p;
}

export const refused = (canonical: string): boolean => REFUSED.some((re) => re.test(canonical));

/** Equal as UTF-8 bytes, in constant time once the lengths agree. Byte lengths, not string lengths: "töur" and "tour"
 *  have the same length as strings and different lengths as bytes, and timingSafeEqual throws on the latter. */
const same = (a: string, b: string): boolean => {
	const x = Buffer.from(a, 'utf8'), y = Buffer.from(b, 'utf8');
	return x.byteLength === y.byteLength && timingSafeEqual(x, y);
};

export function authorised(header: string | undefined, user: string, password: string): boolean {
	if (typeof header !== 'string' || !header.startsWith('Basic ')) return false;
	const [u, ...rest] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
	const userOk = same(u ?? '', user);
	const passwordOk = same(rest.join(':'), password);
	return userOk && passwordOk;
}
