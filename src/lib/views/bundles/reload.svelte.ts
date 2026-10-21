import { beforeNavigate, invalidateAll } from '$app/navigation';

export const RELOAD_LOST = 'The change was saved, but the page could not reload: the app did not answer. Parts of this page may be out of date until you reload it.';

/**
 * invalidateAll() that ends when the reload fails (GRS-160). SvelteKit then gives up on the reload and loads the page
 * in full (a 'leave' navigation, which a leave guard may refuse), and its invalidateAll() never settles. Call while a
 * component initialises: `reload()` resolves true once the data is back and false once SvelteKit has given up, and
 * `lost` holds from then until a later reload comes back.
 */
export function reloader() {
	const waiting = new Set<() => void>();
	const s = $state({ lost: false });
	beforeNavigate((nav) => { if (nav.type === 'leave') for (const give of [...waiting]) give(); });
	const reload = () => new Promise<boolean>((done) => {
		const give = () => { waiting.delete(give); s.lost = true; done(false); };
		waiting.add(give);
		invalidateAll().then(() => { waiting.delete(give); s.lost = false; done(true); }, give);
	});
	return { reload, get lost() { return s.lost; } };
}
