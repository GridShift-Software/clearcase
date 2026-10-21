import { invalidateAll } from '$app/navigation';

export const RELOAD_LOST = 'The change was saved, but the page could not reload: the app did not answer. Parts of this page may be out of date until you reload it.';

/**
 * How long `reload()` waits for the data before it reports the reload lost. It sits above the 5 s the browser holds a
 * reload in CB-RESTART-SLOW, so a slow reload that does land is not reported as lost, and below that scenario's 10 s
 * wait for the page to leave busy.
 */
export const RELOAD_BOUND_MS = 7000;

/**
 * invalidateAll() that ends (GRS-160). When the reload fails SvelteKit gives up on it and loads the page in full,
 * which a leave guard may refuse or, under a URL fragment, is a same-document navigation that raises no event at all;
 * its invalidateAll() never settles. No event marks that, and a leave the user starts cannot be told from SvelteKit's
 * own, so the wait is bounded instead. `reload()` resolves true once the data is back, and false once RELOAD_BOUND_MS
 * has passed or the reload rejected; `lost` then holds until a reload comes back, even one that lands after the bound.
 */
export function reloader() {
	const s = $state({ lost: false });
	const reload = () => new Promise<boolean>((done) => {
		const lose = () => { s.lost = true; done(false); };
		const timer = setTimeout(lose, RELOAD_BOUND_MS);
		invalidateAll().then(() => { clearTimeout(timer); s.lost = false; done(true); }, () => { clearTimeout(timer); lose(); });
	});
	return { reload, get lost() { return s.lost; } };
}
