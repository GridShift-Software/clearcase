import { onDestroy } from 'svelte';
import { invalidateAll } from '$app/navigation';

export const RELOAD_LOST = 'The change was saved, but the page could not reload: the app did not answer. Parts of this page may be out of date until you reload it.';

/**
 * The longest `reload()` waits for the data before it reports the reload lost, when nothing reported the failure first.
 * It sits above the 5 s the browser holds a reload in CB-RESTART-SLOW, so a slow reload that does land is not reported
 * as lost, and below that scenario's 10 s wait for the page to leave busy.
 */
export const RELOAD_BOUND_MS = 7000;

/** The `lose` of every reload still waiting, for `reloadFailed`. */
const waiting = new Set<() => void>();

/**
 * Ends the wait of every reload in progress when the data fetch for `failed`, the URL of the page, is refused. Call it
 * from `handleError` (src/hooks.client.ts) with the event's URL: SvelteKit reports a failed load there before its
 * fallback begins, and a leave the user starts never reaches it, so it tells a failed reload apart where a navigation
 * event cannot. A fetch for another URL (a link preloaded, a different page opened) is not this page's reload.
 */
export function reloadFailed(failed: URL) {
	if (failed.pathname + failed.search !== location.pathname + location.search) return;
	for (const lose of [...waiting]) lose();
}

/**
 * invalidateAll() that ends (GRS-160). When the reload fails SvelteKit gives up on it and loads the page in full,
 * which a leave guard may refuse or, under a URL fragment, is a same-document navigation that raises no event at all;
 * its invalidateAll() never settles. `reloadFailed` ends the wait at once when the app is gone, and RELOAD_BOUND_MS is
 * the backstop for a failure it does not see. `reload()` resolves true once the data is back, and false once the reload
 * failed, was rejected, or RELOAD_BOUND_MS has passed; `lost` then holds until a reload comes back, even one that lands
 * after the bound. Call `reloader()` while a component initialises: leaving the page ends a wait, without marking it lost.
 */
export function reloader() {
	const s = $state({ lost: false });
	const cancels = new Set<() => void>();
	const reload = () => new Promise<boolean>((done) => {
		const timer = setTimeout(() => lose(), RELOAD_BOUND_MS);
		const forget = () => { clearTimeout(timer); waiting.delete(lose); cancels.delete(cancel); };
		const lose = () => { forget(); s.lost = true; done(false); };
		const cancel = () => { forget(); done(false); };
		waiting.add(lose);
		cancels.add(cancel);
		invalidateAll().then(() => { forget(); s.lost = false; done(true); }, lose);
	});
	onDestroy(() => { for (const cancel of [...cancels]) cancel(); });
	return { reload, get lost() { return s.lost; } };
}
