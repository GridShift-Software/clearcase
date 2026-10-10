// Form submission for the litigation registers: SvelteKit's enhance, except that a request that never got an answer
// (the server stopped, the connection dropped) or an unexpected error keeps the page and the typed values and shows
// a visible error, instead of replacing the page with the error page. A `fail` (busy store) is applied as usual,
// which keeps the inputs (only a success resets the form). Browser-safe.
import type { SubmitFunction } from '@sveltejs/kit';

export const LOST = 'Not saved: the app could not be reached. Your entry is kept below; try again once it is running.';

/** An enhance callback that reports a lost request through `onLost` and otherwise lets SvelteKit update the page. */
export const keepInput = (onLost: (message: string) => void, onStart: () => void = () => {}): SubmitFunction => () => {
	onStart();
	return async ({ result, update }) => {
		if (result.type === 'error') { onLost(LOST); return; }
		await update();
	};
};
