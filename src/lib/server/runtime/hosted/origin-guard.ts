import type { Handle } from '@sveltejs/kit/hooks';
import { plain } from './handle.ts';

/**
 * The origin this deployment serves: CLEARCASE_APP_ORIGIN in canonical form, or null when it is absent or not an origin. An
 * unconfigured deployment has nothing to compare against and no identity service, so its protected paths already answer 503.
 */
export function pinnedOrigin(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	try {
		const u = new URL(value);
		return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
	} catch {
		return null;
	}
}

/**
 * The refusal of a request that reached this Worker at an origin other than the pinned one (workers.dev, a preview URL, another
 * scheme or port), for every method and path. One Worker serves one origin: a session valid for the pinned origin is not
 * welcome anywhere else, and a plain 403 with no cookie and no identity call leaves it untouched (sign-out included).
 */
export function pinnedOriginRefusal(url: URL, pinned: unknown): Response | null {
	const expected = pinnedOrigin(pinned);
	return expected !== null && url.origin !== expected ? plain(403, 'Forbidden') : null;
}

/** Runs `inner` only for a request at the pinned origin. `pinned` is read per request because bindings are the isolate's env. */
export const withPinnedOrigin = (pinned: () => unknown, inner: Handle): Handle => (input) => pinnedOriginRefusal(input.event.url, pinned()) ?? inner(input);
