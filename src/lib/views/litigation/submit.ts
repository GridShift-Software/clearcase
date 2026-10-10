// Form submission for the litigation registers: SvelteKit's enhance, except that a failure (a busy store: the action's
// fail(503, {values, message})) or a request that never got an answer (the server stopped, the connection dropped) is
// reported through `onError` and changes nothing else on the page: the typed values stay in their fields and the
// page is never replaced by the error page. Only a success updates the page (and resets the submitted form, as v5
// clears its inputs after an add). Without JavaScript the action's `values` re-fill the form instead. Browser-safe.
import type { SubmitFunction } from '@sveltejs/kit';

export const LOST = 'Not saved: the app could not be reached. Your entry is kept below; try again once it is running.';

/** The message of a failed action result, or null when the action declined silently (v5's no-op adds). */
export const failureMessage = (data: Record<string, unknown> | undefined) => (typeof data?.message === 'string' ? data.message : null);

/** An enhance callback: `onError(message)` on a failure or a lost request, `onStart` before each submit. */
export const keepInput = (onError: (message: string | null) => void, onStart: () => void = () => {}): SubmitFunction => () => {
	onStart();
	return async ({ result, update }) => {
		if (result.type === 'failure') { onError(failureMessage(result.data)); return; }
		if (result.type === 'error') { onError(LOST); return; }
		await update();
	};
};
